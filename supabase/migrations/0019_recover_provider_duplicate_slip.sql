-- Recover safely when EasySlip reports a slip it has verified before.
-- Same-branch retries return isDuplicate=true even when the first application
-- request failed before the local transaction ledger was updated. Such a
-- provider-only duplicate is claimed exactly once but always routed to
-- manual_review. Existing local claims retain the normal idempotent/duplicate
-- behavior. Run after 0018.
begin;
create or replace function public.confirm_slip_payment(
  p_payment_order_id uuid,
  p_provider text,
  p_provider_tx_ref text,
  p_transfer_at timestamptz,
  p_amount_satang int,
  p_currency text,
  p_receiver_profile text,
  p_evidence jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
as $$
declare
  v_order public.payment_orders;
  v_booking public.bookings;
  v_transaction public.payment_transactions;
  v_tx_ref text;
  v_reason text;
  v_slot public.booking_slots;
  v_face_path text;
  v_slip_path text;
  v_notification_id uuid;
begin
  if p_provider <> 'promptpay_slip' then raise exception 'invalid_provider'; end if;
  if p_currency is null or btrim(p_currency) = '' then raise exception 'invalid_currency'; end if;
  if p_provider_tx_ref is null or btrim(p_provider_tx_ref) = '' then raise exception 'invalid_tx_ref'; end if;
  if p_transfer_at is null then raise exception 'invalid_transfer_at'; end if;
  if p_amount_satang is null or p_amount_satang <= 0 then raise exception 'invalid_amount'; end if;
  v_tx_ref := upper(regexp_replace(btrim(p_provider_tx_ref), '\s+', '', 'g'));
  if v_tx_ref = '' then raise exception 'invalid_tx_ref'; end if;

  -- Fixed lock ordering: payment order, durable transaction claim, booking.
  select * into v_order from public.payment_orders where id = p_payment_order_id for update;
  if not found then raise exception 'payment_order_not_found'; end if;
  if v_order.provider <> 'promptpay_slip' or v_order.currency <> 'THB'
     or v_order.receiver_profile is null then raise exception 'incompatible_payment_order'; end if;

  begin
    insert into public.payment_transactions(
      provider, normalized_tx_ref, payment_order_id, booking_id, transfer_at,
      amount_satang, currency, receiver_profile
    ) values (
      p_provider, v_tx_ref, p_payment_order_id, v_order.booking_id, p_transfer_at,
      p_amount_satang, p_currency, p_receiver_profile
    ) returning * into v_transaction;
  exception when unique_violation then
    select * into v_transaction from public.payment_transactions
      where provider = p_provider and normalized_tx_ref = v_tx_ref for update;
    if v_transaction.payment_order_id <> p_payment_order_id then
      return jsonb_build_object('result','rejected','reason','duplicate_tx');
    end if;
    if v_transaction.resolution = 'confirmed' then
      return jsonb_build_object('result','already_paid','booking_id',v_order.booking_id);
    end if;
    return jsonb_build_object('result','manual_review',
      'reason',coalesce(v_transaction.resolution_reason,'manual_review'));
  end;

  select * into v_booking from public.bookings where id = v_order.booking_id for update;
  if not found then raise exception 'booking_not_found'; end if;

  if p_evidence->>'provider_duplicate' = 'true' then
    v_reason := 'provider_duplicate';
  elsif v_order.status not in ('created','pending') then
    v_reason := 'order_' || v_order.status;
  elsif v_booking.status <> 'pending_payment' then
    v_reason := 'booking_' || v_booking.status;
  elsif v_booking.hold_expires_at is null or v_booking.hold_expires_at <= clock_timestamp() then
    v_reason := 'hold_expired';
  elsif clock_timestamp() >= v_order.expires_at then
    v_reason := 'order_expired';
  elsif p_transfer_at < v_order.created_at
     or p_transfer_at > least(v_order.expires_at, v_booking.hold_expires_at) then
    v_reason := 'timestamp_out_of_window';
  elsif p_currency <> v_order.currency or v_order.currency <> 'THB' then
    v_reason := 'currency_mismatch';
  elsif p_receiver_profile is distinct from v_order.receiver_profile then
    v_reason := 'receiver_mismatch';
  elsif p_amount_satang <> v_order.amount_satang then
    v_reason := 'amount_mismatch';
  end if;

  if v_reason is not null then
    update public.payment_transactions set resolution = 'manual_review',
      resolution_reason = v_reason, resolved_at = now() where id = v_transaction.id;
    update public.payment_orders set status = 'manual_review',
      amount_received_satang = p_amount_satang, provider_paid_at = p_transfer_at,
      provider_payload = p_evidence, failure_code = v_reason, updated_at = now()
      where id = p_payment_order_id and status in ('created','pending');
    insert into public.payment_slip_verifications(
      payment_order_id, booking_id, provider, provider_tx_ref, transfer_at,
      amount_satang, outcome, evidence
    ) values (p_payment_order_id, v_order.booking_id, p_provider, v_tx_ref,
      p_transfer_at, p_amount_satang, 'manual_review', p_evidence);

    -- Evidence lookups: freshest face photo on file for this booking, and
    -- freshest slip upload for this specific payment order. Either or both
    -- may be absent (never a signed URL — only the private storage path).
    select bi.storage_path into v_face_path
      from public.booking_images bi
     where bi.booking_id = v_order.booking_id
     order by bi.created_at desc, bi.id desc
     limit 1;
    select psi.storage_path into v_slip_path
      from public.payment_slip_images psi
     where psi.payment_order_id = p_payment_order_id
     order by psi.created_at desc, psi.id desc
     limit 1;

    insert into public.notification_deliveries(
      booking_id, payment_order_id, channel, recipient_type, event_type,
      idempotency_key, payload
    ) values (v_order.booking_id, p_payment_order_id, 'line', 'team',
      'slip_manual_review', 'slip:review:' || v_transaction.id::text,
      jsonb_build_object('booking_id',v_order.booking_id,
                         'payment_order_id',p_payment_order_id,
                         'reference_code',upper(left(v_order.booking_id::text,8)),
                         'reason',v_reason,
                         'expected_amount_satang',v_order.amount_satang,
                         'received_amount_satang',p_amount_satang))
      on conflict (idempotency_key) do nothing
      returning id into v_notification_id;

    if v_notification_id is not null then
      if v_face_path is not null then
        insert into public.notification_image_deliveries(notification_delivery_id, image_kind, storage_path)
          values (v_notification_id, 'face', v_face_path)
          on conflict (notification_delivery_id, image_kind) do nothing;
      end if;
      if v_slip_path is not null then
        insert into public.notification_image_deliveries(notification_delivery_id, image_kind, storage_path)
          values (v_notification_id, 'payment_slip', v_slip_path)
          on conflict (notification_delivery_id, image_kind) do nothing;
      end if;
    end if;

    return jsonb_build_object('result','manual_review','reason',v_reason);
  end if;

  update public.payment_transactions set resolution = 'confirmed', resolved_at = now()
    where id = v_transaction.id;
  update public.payment_orders set status = 'paid', paid_at = now(),
    amount_received_satang = p_amount_satang, provider_paid_at = p_transfer_at,
    provider_payload = p_evidence, updated_at = now() where id = p_payment_order_id;
  update public.bookings set status = 'confirmed', hold_expires_at = null,
    updated_at = now() where id = v_order.booking_id;
  insert into public.payment_slip_verifications(
    payment_order_id, booking_id, provider, provider_tx_ref, transfer_at,
    amount_satang, outcome, evidence
  ) values (p_payment_order_id, v_order.booking_id, p_provider, v_tx_ref,
    p_transfer_at, p_amount_satang, 'confirmed', p_evidence);

  -- Single canonical successful-confirmation notification (see 0012's
  -- header for the dedup rationale): booking_confirmed only.
  select * into v_slot from public.booking_slots where id = v_booking.slot_id;
  select bi.storage_path into v_face_path
    from public.booking_images bi
   where bi.booking_id = v_order.booking_id
   order by bi.created_at desc, bi.id desc
   limit 1;
  select psi.storage_path into v_slip_path
    from public.payment_slip_images psi
   where psi.payment_order_id = p_payment_order_id
   order by psi.created_at desc, psi.id desc
   limit 1;

  insert into public.notification_deliveries (
    booking_id, payment_order_id, channel, recipient_type, event_type, idempotency_key, payload
  ) values (
    v_order.booking_id, p_payment_order_id, 'line', 'team', 'booking_confirmed',
    'booking:confirmed:team:' || v_order.booking_id::text,
    jsonb_build_object(
      'booking_id', v_order.booking_id,
      'reference_code', upper(left(v_order.booking_id::text, 8)),
      'customer_name', v_booking.nickname,
      'birth_date', v_booking.birth_date_text,
      'consultation_topic', v_booking.consultation_topic,
      'phone', v_booking.phone,
      'booking_date', v_slot.booking_date,
      'session_time', v_slot.label,
      'queue_number', v_booking.queue_number,
      'confirmation_method', 'easyslip_auto',
      'expected_amount_satang', v_order.amount_satang,
      'received_amount_satang', p_amount_satang,
      'updated_at', now()
    )
  )
  on conflict (idempotency_key) do nothing
  returning id into v_notification_id;

  if v_notification_id is not null then
    if v_face_path is not null then
      insert into public.notification_image_deliveries(notification_delivery_id, image_kind, storage_path)
        values (v_notification_id, 'face', v_face_path)
        on conflict (notification_delivery_id, image_kind) do nothing;
    end if;
    if v_slip_path is not null then
      insert into public.notification_image_deliveries(notification_delivery_id, image_kind, storage_path)
        values (v_notification_id, 'payment_slip', v_slip_path)
        on conflict (notification_delivery_id, image_kind) do nothing;
    end if;
  end if;

  return jsonb_build_object('result','ok','booking_id',v_order.booking_id);
end;
$$;
revoke all on function public.confirm_slip_payment(uuid, text, text, timestamptz, int, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.confirm_slip_payment(uuid, text, text, timestamptz, int, text, text, jsonb) to service_role;

commit;
