-- Payment Hold Safety (server-side half): close the gap where a
-- pending_payment booking whose hold has already lapsed could still be
-- manually confirmed by an admin before the 5-minute expire-bookings cron
-- catches up and flips its status to 'expired'.
-- PROPOSED — do not apply without review. Run AFTER
-- 0007_team_notification_outbox.sql. Never auto-applied by this repo; apply
-- manually via the Supabase SQL editor per the project's existing workflow.
--
-- Replaces the version of transition_slot_booking() from
-- 0005_payment_foundation.sql. Same signature, still invoker rights (no
-- definer-rights escalation), same revoke/grant. Only behavioural change:
--
--   pending_payment -> confirmed is now rejected with 'hold_expired' when
--   hold_expires_at is null or <= now(), REGARDLESS of whether the slot
--   still has a free seat.
--
-- Before this migration, a lapsed hold could still be confirmed as long as
-- the slot had room (a deliberate "late payment, manual review" allowance).
-- That allowance is intentionally removed here: once a hold's deadline has
-- passed, the booking must go through a fresh booking flow rather than a
-- silent manual confirm, so the customer-facing hold deadline (and the
-- success-page UI that now hides payment instructions at that same
-- deadline) stays a real guarantee instead of best-effort. All other
-- transitions (booked -> confirmed/cancelled, confirmed -> completed/
-- cancelled, pending_payment -> cancelled/expired) are unchanged.
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
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'booking_not_found'; end if;
  if v_booking.slot_id is null then raise exception 'not_slot_booking'; end if;

  v_from := v_booking.status;
  if p_to = v_from then return v_booking; end if;  -- idempotent no-op

  if not (
       (v_from = 'pending_payment' and p_to in ('confirmed', 'cancelled', 'expired'))
    or (v_from = 'booked'         and p_to in ('confirmed', 'cancelled'))
    or (v_from = 'confirmed'      and p_to in ('completed', 'cancelled'))
  ) then
    raise exception 'invalid_transition';
  end if;

  select * into v_slot from public.booking_slots where id = v_booking.slot_id for update;

  if p_to = 'confirmed' then
    -- New invariant: a lapsed pending_payment hold can never be confirmed,
    -- no matter how much room the slot has left. Checked before the
    -- capacity math below so it takes priority over 'slot_full'.
    if v_from = 'pending_payment'
       and (v_booking.hold_expires_at is null or v_booking.hold_expires_at <= now())
    then
      raise exception 'hold_expired';
    end if;

    -- booked always occupies a seat (payment received).
    -- A live pending_payment hold already occupies a seat (guaranteed live
    -- at this point — the hold_expired check above already rejected any
    -- lapsed hold). Kept as an explicit re-check (defense in depth) rather
    -- than assumed, in case a future transition path reaches here.
    v_self_occupies := (
      v_booking.status = 'booked'
      or (
        v_booking.status = 'pending_payment'
        and v_booking.hold_expires_at is not null
        and v_booking.hold_expires_at > now()
      )
    );
    if not v_self_occupies then
      select count(*) into v_others
        from public.bookings
       where slot_id = v_booking.slot_id
         and id <> p_booking_id
         and (status in ('booked', 'confirmed', 'completed')
              or (status = 'pending_payment' and hold_expires_at > now()));
      if v_others >= v_slot.capacity then raise exception 'slot_full'; end if;
    end if;
    update public.bookings
       set status = 'confirmed', hold_expires_at = null, updated_at = now()
     where id = p_booking_id returning * into v_booking;

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
