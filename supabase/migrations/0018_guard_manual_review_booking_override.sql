-- Prevent an admin booking-only override from bypassing a provider-verified
-- payment transaction that is already in manual_review. Run after 0013.
--
-- The payment-order rows are locked before the booking row, matching the
-- order -> booking lock order used by confirm_slip_payment and the expiry
-- worker. This makes the review check race-safe against a concurrent slip
-- confirmation. Approval remains possible only through
-- approve_manual_review_payment, which resolves the order before updating the
-- booking and therefore does not trip this guard.
begin;

create or replace function public.transition_slot_booking(
  p_booking_id uuid,
  p_to         text
)
returns public.bookings
language plpgsql
as $$
declare
  v_booking       public.bookings;
  v_slot          public.booking_slots;
  v_from          text;
  v_others        int;
  v_self_occupies boolean;
  v_face_path     text;
  v_notification_id uuid;
begin
  if p_to = 'confirmed' then
    -- Lock every existing order for this booking before inspecting review
    -- state. A concurrent confirm_slip_payment holds the same order lock, so
    -- after waiting this transaction sees its committed paid/manual_review
    -- result instead of racing past it.
    perform 1
      from public.payment_orders
     where booking_id = p_booking_id
     order by created_at, id
     for update;

    if exists (
      select 1
        from public.payment_orders
       where booking_id = p_booking_id
         and status = 'manual_review'
    ) then
      raise exception 'payment_review_required';
    end if;
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'booking_not_found'; end if;
  if v_booking.slot_id is null then raise exception 'not_slot_booking'; end if;

  v_from := v_booking.status;
  if p_to = v_from then return v_booking; end if;

  if not (
       (v_from = 'pending_payment' and p_to in ('confirmed', 'cancelled', 'expired'))
    or (v_from = 'booked'         and p_to in ('confirmed', 'cancelled'))
    or (v_from = 'confirmed'      and p_to in ('completed', 'cancelled'))
  ) then
    raise exception 'invalid_transition';
  end if;

  select * into v_slot from public.booking_slots where id = v_booking.slot_id for update;

  if p_to = 'confirmed' then
    if v_from = 'pending_payment'
       and (v_booking.hold_expires_at is null or v_booking.hold_expires_at <= clock_timestamp())
    then
      raise exception 'hold_expired';
    end if;

    v_self_occupies := (
      v_booking.status = 'booked'
      or (
        v_booking.status = 'pending_payment'
        and v_booking.hold_expires_at is not null
        and v_booking.hold_expires_at > clock_timestamp()
      )
    );
    if not v_self_occupies then
      select count(*) into v_others
        from public.bookings
       where slot_id = v_booking.slot_id
         and id <> p_booking_id
         and (status in ('booked', 'confirmed', 'completed')
              or (status = 'pending_payment' and hold_expires_at > clock_timestamp()));
      if v_others >= v_slot.capacity then raise exception 'slot_full'; end if;
    end if;
    update public.bookings
       set status = 'confirmed', hold_expires_at = null, updated_at = now()
     where id = p_booking_id returning * into v_booking;

    select bi.storage_path into v_face_path
      from public.booking_images bi
     where bi.booking_id = p_booking_id
     order by bi.created_at desc, bi.id desc
     limit 1;

    insert into public.notification_deliveries (
      booking_id, channel, recipient_type, event_type, idempotency_key, payload
    ) values (
      v_booking.id, 'line', 'team', 'booking_confirmed',
      'booking:confirmed:team:' || v_booking.id::text,
      jsonb_build_object(
        'booking_id', v_booking.id,
        'reference_code', upper(left(v_booking.id::text, 8)),
        'customer_name', v_booking.nickname,
        'birth_date', v_booking.birth_date_text,
        'consultation_topic', v_booking.consultation_topic,
        'phone', v_booking.phone,
        'booking_date', v_slot.booking_date,
        'session_time', v_slot.label,
        'queue_number', v_booking.queue_number,
        'confirmation_method', 'admin_override',
        'updated_at', v_booking.updated_at
      )
    )
    on conflict (idempotency_key) do nothing
    returning id into v_notification_id;

    if v_notification_id is not null and v_face_path is not null then
      insert into public.notification_image_deliveries(notification_delivery_id, image_kind, storage_path)
        values (v_notification_id, 'face', v_face_path)
        on conflict (notification_delivery_id, image_kind) do nothing;
    end if;

  elsif p_to = 'cancelled' then
    update public.bookings
       set status = 'cancelled', hold_expires_at = null, updated_at = now()
     where id = p_booking_id returning * into v_booking;

  elsif p_to = 'expired' then
    update public.bookings
       set status = 'expired', hold_expires_at = null, updated_at = now()
     where id = p_booking_id returning * into v_booking;

  elsif p_to = 'completed' then
    update public.bookings
       set status = 'completed', updated_at = now()
     where id = p_booking_id returning * into v_booking;
  end if;

  return v_booking;
end;
$$;

revoke all on function public.transition_slot_booking(uuid, text) from public, anon, authenticated;
grant execute on function public.transition_slot_booking(uuid, text) to service_role;

commit;
