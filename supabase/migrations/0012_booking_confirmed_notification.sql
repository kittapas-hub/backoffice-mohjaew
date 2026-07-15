-- Team LINE booking-summary notification on confirmation, from any of the
-- three paths that transition a booking to 'confirmed':
--   1. Admin non-payment override    -> transition_slot_booking (0008)
--   2. Manual payment review approval -> approve_manual_review_payment (0011)
--   3. EasySlip automatic confirmation -> confirm_slip_payment (0011)
--
-- PROPOSED — do not apply without review. Run AFTER
-- 0011_slip_verification.sql. Never auto-applied by this repo; apply
-- manually via the Supabase SQL editor per the project's existing workflow.
-- Forward-only: this migration does not edit 0010_reconcile_0006_0009.sql or
-- 0011_slip_verification.sql. It only issues `create or replace function`
-- (and, for the two functions whose signature changes, `drop function` +
-- `create function`) for the objects listed below, each reproducing its
-- current body verbatim (same signature, same invoker/definer rights, same
-- revoke/grant) plus one additive change apiece. Every other behaviour is
-- unchanged, including the hold_expired guard, the capacity/'slot_full'
-- guard, the slip transaction ledger (payment_transactions /
-- payment_slip_verifications), the existing payment_received /
-- slip_manual_review outbox inserts, and the line_retry_key default
-- introduced by 0011. get_open_slots (0010) is not touched.
--
-- Atomicity: the entire migration runs inside one BEGIN/COMMIT. If any
-- statement fails, every function/column/index change below rolls back
-- together — there is no partially-applied state where e.g.
-- transition_slot_booking was replaced but confirm_slip_payment was not.
--
-- This migration does not enable slip verification automation: the
-- application-level release gate in src/lib/env.ts (slipVerificationEnabled)
-- is never read or set by any SQL here. confirm_slip_payment only ever runs
-- when something else has already decided to call it.
--
-- Duplicate-notification / race safety: idempotency_key is
-- 'booking:confirmed:team:' || booking_id (independent of which of the
-- three RPCs wrote it), and every insert is ON CONFLICT (idempotency_key) DO
-- NOTHING. All three RPCs additionally lock the same public.bookings row
-- with SELECT ... FOR UPDATE before checking/mutating status, so real
-- concurrent calls for the same booking (e.g. EasySlip auto-confirmation
-- racing an admin's manual override) are serialized by Postgres: only the
-- call that actually wins the 'confirmed' transition ever reaches its
-- enqueue block. The idempotency key is defense in depth on top of that
-- row-lock serialization, not the only guard.
--
-- Never sent inline: the insert is the entire notification side effect of
-- each function. Actual LINE delivery happens later, out of this
-- transaction, in the delivery worker — a LINE outage can never fail or
-- roll back a booking confirmation.
--
-- Every insert below hardcodes the team recipient type, matching every
-- existing insert in this table — customer delivery is never introduced.
--
-- image_retry_key: a stable per-row LINE retry key for the face-image push,
-- separate from line_retry_key (used only for the text push) — see section 4
-- below. Text and image are independently retryable and must never share a
-- retry key; sharing one would make LINE's own duplicate-request dedup
-- collapse two different message bodies (text vs. image) onto the same key.

begin;

-- ===========================================================================
-- 1. transition_slot_booking — replaces the version from
--    0008_reject_expired_hold_confirmation.sql. Path: admin non-payment
--    override (pending_payment -> confirmed with no payment order at all, or
--    booked -> confirmed).
-- ===========================================================================
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
  v_image_path    text;
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
    -- A lapsed pending_payment hold can never be confirmed, no matter how
    -- much room the slot has left. Checked before the capacity math below
    -- so it takes priority over 'slot_full'.
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

    -- Enqueue the team LINE booking-summary notification (see header for the
    -- full dedup/race/never-inline rationale, shared by all three RPCs in
    -- this migration).
    select bi.storage_path into v_image_path
      from public.booking_images bi
     where bi.booking_id = p_booking_id
     order by bi.created_at desc
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
        'updated_at', v_booking.updated_at,
        'image_storage_path', v_image_path
      )
    )
    on conflict (idempotency_key) do nothing;

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

-- ===========================================================================
-- 2. confirm_slip_payment — replaces the version from
--    0011_slip_verification.sql. Path: EasySlip automatic confirmation. Only
--    the success branch (v_reason is null) reaches 'confirmed' — the
--    manual_review branch is untouched and still inserts only its existing
--    'slip_manual_review' row.
-- ===========================================================================
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
  v_image_path text;
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

  if v_order.status not in ('created','pending') then
    v_reason := 'order_' || v_order.status;
  elsif v_booking.status <> 'pending_payment' then
    v_reason := 'booking_' || v_booking.status;
  elsif v_booking.hold_expires_at is null or v_booking.hold_expires_at <= now() then
    v_reason := 'hold_expired';
  elsif now() >= v_order.expires_at then
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
    insert into public.notification_deliveries(
      booking_id, payment_order_id, channel, recipient_type, event_type,
      idempotency_key, payload
    ) values (v_order.booking_id, p_payment_order_id, 'line', 'team',
      'slip_manual_review', 'slip:review:' || v_transaction.id::text,
      jsonb_build_object('booking_id',v_order.booking_id,
                         'payment_order_id',p_payment_order_id,'reason',v_reason))
      on conflict (idempotency_key) do nothing;
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
  -- Phase 1 has no verified customer LINE identity: team-only outbox intent.
  insert into public.notification_deliveries(
    booking_id, payment_order_id, channel, recipient_type, event_type,
    idempotency_key, payload
  ) values (v_order.booking_id, p_payment_order_id, 'line', 'team',
    'payment_received', 'pay:received:team:' || p_payment_order_id::text,
    jsonb_build_object('booking_id',v_order.booking_id,'payment_order_id',p_payment_order_id))
    on conflict (idempotency_key) do nothing;

  -- Booking-summary team notification (see migration header for dedup/race
  -- rationale). now() rather than v_booking.updated_at: v_booking was
  -- fetched before the status update above, so its own updated_at is stale;
  -- now() is transactionally consistent with the UPDATE just committed above.
  select * into v_slot from public.booking_slots where id = v_booking.slot_id;
  select bi.storage_path into v_image_path
    from public.booking_images bi
   where bi.booking_id = v_order.booking_id
   order by bi.created_at desc
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
      'updated_at', now(),
      'image_storage_path', v_image_path
    )
  )
  on conflict (idempotency_key) do nothing;

  return jsonb_build_object('result','ok','booking_id',v_order.booking_id);
end;
$$;
revoke all on function public.confirm_slip_payment(uuid, text, text, timestamptz, int, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.confirm_slip_payment(uuid, text, text, timestamptz, int, text, text, jsonb) to service_role;

-- ===========================================================================
-- 3. approve_manual_review_payment — replaces the version from
--    0011_slip_verification.sql. Path: manual payment review approval.
-- ===========================================================================
create or replace function public.approve_manual_review_payment(
  p_booking_id uuid
) returns jsonb
language plpgsql
as $$
declare
  v_order public.payment_orders;
  v_booking public.bookings;
  v_transaction public.payment_transactions;
  v_order_id uuid;
  v_order_count int;
  v_claim_count int;
  v_slot public.booking_slots;
  v_image_path text;
begin
  select count(*) into v_order_count from public.payment_orders
   where booking_id = p_booking_id and status = 'manual_review';
  if v_order_count = 0 then
    select po.id into v_order_id
      from public.payment_orders po
      join public.payment_transactions pt on pt.payment_order_id = po.id
     where po.booking_id = p_booking_id
       and po.status = 'paid' and pt.resolution = 'confirmed'
     order by po.created_at desc limit 1;
    if v_order_id is not null then
      return jsonb_build_object('result','already_paid','booking_id',p_booking_id);
    end if;
    raise exception 'manual_review_claim_not_found';
  end if;
  if v_order_count <> 1 then raise exception 'manual_review_claim_ambiguous'; end if;
  select id into v_order_id from public.payment_orders
   where booking_id = p_booking_id and status = 'manual_review'
   order by created_at desc limit 1;

  select * into v_order from public.payment_orders where id = v_order_id for update;
  if not found or v_order.booking_id <> p_booking_id then raise exception 'manual_review_claim_not_found'; end if;
  if v_order.status = 'paid' then
    return jsonb_build_object('result','already_paid','booking_id',p_booking_id);
  end if;
  if v_order.status <> 'manual_review' then raise exception 'manual_review_claim_not_found'; end if;

  select count(*) into v_claim_count from public.payment_transactions
   where payment_order_id = v_order.id and booking_id = p_booking_id
     and resolution = 'manual_review';
  if v_claim_count <> 1 then raise exception 'manual_review_claim_ambiguous'; end if;

  select * into v_transaction from public.payment_transactions
   where payment_order_id = v_order.id and booking_id = p_booking_id
     and resolution = 'manual_review'
   for update;
  if v_transaction.provider <> v_order.provider then raise exception 'manual_review_claim_incompatible'; end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'booking_not_found'; end if;
  if v_booking.status <> 'pending_payment' then raise exception 'booking_not_pending_payment'; end if;

  update public.payment_transactions set resolution = 'confirmed',
    resolution_reason = 'manual_approved', resolved_at = now()
    where id = v_transaction.id;
  update public.payment_orders set status = 'paid', paid_at = now(),
    failure_code = null, failure_message = null, updated_at = now()
    where id = v_order.id;
  update public.bookings set status = 'confirmed', hold_expires_at = null,
    updated_at = now() where id = p_booking_id;
  insert into public.payment_slip_verifications(
    payment_order_id, booking_id, provider, provider_tx_ref, transfer_at,
    amount_satang, outcome, evidence
  ) values (v_order.id, p_booking_id, v_transaction.provider,
    v_transaction.normalized_tx_ref, v_transaction.transfer_at,
    v_transaction.amount_satang, 'confirmed',
    jsonb_build_object('resolution','manual_approved'));
  insert into public.notification_deliveries(
    booking_id, payment_order_id, channel, recipient_type, event_type,
    idempotency_key, payload
  ) values (p_booking_id, v_order.id, 'line', 'team', 'payment_received',
    'pay:received:team:' || v_order.id::text,
    jsonb_build_object('booking_id',p_booking_id,'payment_order_id',v_order.id))
  on conflict (idempotency_key) do nothing;

  -- Booking-summary team notification (see migration header for dedup/race
  -- rationale). now() rather than v_booking.updated_at: v_booking was
  -- fetched before the status update above, so its own updated_at is stale;
  -- now() is transactionally consistent with the UPDATE just committed above.
  select * into v_slot from public.booking_slots where id = v_booking.slot_id;
  select bi.storage_path into v_image_path
    from public.booking_images bi
   where bi.booking_id = p_booking_id
   order by bi.created_at desc
   limit 1;

  insert into public.notification_deliveries (
    booking_id, payment_order_id, channel, recipient_type, event_type, idempotency_key, payload
  ) values (
    p_booking_id, v_order.id, 'line', 'team', 'booking_confirmed',
    'booking:confirmed:team:' || p_booking_id::text,
    jsonb_build_object(
      'booking_id', p_booking_id,
      'reference_code', upper(left(p_booking_id::text, 8)),
      'customer_name', v_booking.nickname,
      'birth_date', v_booking.birth_date_text,
      'consultation_topic', v_booking.consultation_topic,
      'phone', v_booking.phone,
      'booking_date', v_slot.booking_date,
      'session_time', v_slot.label,
      'queue_number', v_booking.queue_number,
      'confirmation_method', 'manual_review_approved',
      'updated_at', now(),
      'image_storage_path', v_image_path
    )
  )
  on conflict (idempotency_key) do nothing;

  return jsonb_build_object('result','ok','booking_id',p_booking_id);
end;
$$;
revoke all on function public.approve_manual_review_payment(uuid) from public, anon, authenticated;
grant execute on function public.approve_manual_review_payment(uuid) to service_role;

-- ===========================================================================
-- 4. image_retry_key: a stable per-row LINE retry key for the
--    booking_confirmed face-image push, distinct from line_retry_key (used
--    only for the text push). Same additive pattern as 0011's
--    line_retry_key: existing rows are backfilled with a random key before
--    the NOT NULL is added, so the column is never null for any row a
--    worker could claim.
--
--    Why this matters: the delivery worker signs+sends the image only after
--    the text push succeeds, then calls complete_notification_delivery. If
--    the worker crashes after LINE has accepted the image push but before
--    that completion call commits, the row's lease eventually goes stale and
--    a later worker reclaims and reprocesses it — including resending the
--    image. Reusing the SAME image_retry_key (persisted here, not
--    regenerated per attempt) means that resend carries the identical
--    X-Line-Retry-Key LINE already saw, so LINE reports it as a duplicate
--    (409-as-success) instead of delivering the photo a second time.
-- ===========================================================================
alter table public.notification_deliveries add column if not exists image_retry_key uuid default gen_random_uuid();
update public.notification_deliveries set image_retry_key = gen_random_uuid() where image_retry_key is null;
alter table public.notification_deliveries alter column image_retry_key set not null;

-- ===========================================================================
-- 5. claim_team_notification_deliveries — replaces the version from
--    0011_slip_verification.sql. Adds image_retry_key to the returned
--    columns (alongside the existing line_retry_key) so the delivery worker
--    can reuse the same stable key on every retry of a row's image send.
--    DROP + CREATE (not CREATE OR REPLACE) because the RETURNS TABLE column
--    list changes — Postgres does not allow CREATE OR REPLACE to alter a
--    function's output columns.
-- ===========================================================================
drop function if exists public.claim_team_notification_deliveries(text, int, text[]);
create function public.claim_team_notification_deliveries(
  p_worker_id text, p_batch int, p_event_types text[]
) returns table (
  id uuid, booking_id uuid, payment_order_id uuid, channel text, event_type text,
  payload jsonb, idempotency_key text, attempt_count int, line_retry_key uuid, image_retry_key uuid
) language plpgsql security definer set search_path = public, pg_temp as $$
declare v_batch int;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then raise exception 'invalid_worker_id'; end if;
  if p_batch is null or p_batch < 1 then raise exception 'invalid_batch'; end if;
  if p_event_types is null or cardinality(p_event_types) = 0 then raise exception 'invalid_event_types'; end if;
  v_batch := least(p_batch, 100);
  return query with candidates as (
    select d.id from public.notification_deliveries d
     where d.recipient_type = 'team' and d.channel = 'line'
       and ((d.status in ('pending','failed') and (d.next_retry_at is null or d.next_retry_at <= now()))
         or (d.status = 'processing' and d.locked_at < now() - interval '10 minutes'))
       and d.event_type = any(p_event_types)
     order by d.created_at limit v_batch for update skip locked
  ) update public.notification_deliveries upd set status='processing', locked_by=p_worker_id,
      locked_at=now(), updated_at=now() from candidates where upd.id=candidates.id
    returning upd.id,upd.booking_id,upd.payment_order_id,upd.channel,upd.event_type,
      upd.payload,upd.idempotency_key,upd.attempt_count,upd.line_retry_key,upd.image_retry_key;
end;
$$;
revoke all on function public.claim_team_notification_deliveries(text, int, text[]) from public, anon, authenticated;
grant execute on function public.claim_team_notification_deliveries(text, int, text[]) to service_role;

commit;

-- ROLLBACK (non-destructive):
--   Re-run 0008_reject_expired_hold_confirmation.sql's, 0011_slip_verification.sql's
--   and 0007_team_notification_outbox.sql's CREATE (OR REPLACE) statements
--   for transition_slot_booking, confirm_slip_payment,
--   approve_manual_review_payment, and claim_team_notification_deliveries to
--   restore their pre-0012 bodies. Do NOT drop the image_retry_key column —
--   it is additive and harmless to leave in place, exactly like
--   line_retry_key from 0011. Any notification_deliveries rows already
--   inserted with event_type = 'booking_confirmed' are harmless and may be
--   left as-is (or manually set to status = 'skipped'); no destructive
--   rollback is required.
