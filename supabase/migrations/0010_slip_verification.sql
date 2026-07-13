-- Phase 1 (Mohjaew slip automation): automatic bank-slip verification support.
-- PROPOSED — do not apply without review. Run AFTER 0009_queue_session_cutover.sql.
-- Never auto-applied by this repo; apply manually via the Supabase SQL editor
-- per the project's existing workflow.
--
-- Security model: same as 0005. The new function runs with invoker rights (no
-- definer-rights escalation). EXECUTE is revoked from public/anon/authenticated
-- and granted only to service_role. The new table has RLS enabled
-- (deny-by-default) and is only reachable through the service-role key.
--
-- What this adds:
--   * payment_slip_verifications — an append-only audit table recording every
--     slip verification attempt (accepted or rejected) with normalized,
--     provider-neutral evidence. No raw slip images are ever stored.
--   * a partial unique index that lets ONE (provider, provider_tx_ref) pair
--     confirm ONE payment, globally — the database-level guarantee that a
--     single bank transaction can never pay for two bookings.
--   * confirm_slip_payment() — the single atomic, idempotent confirmation
--     operation: lock order + booking, re-validate states, claim the
--     transaction reference, mark the order paid, transition the booking
--     pending_payment -> confirmed (the SAME trusted state as the manual
--     confirmPayment admin flow, with the SAME live-hold requirement as
--     0008), write the audit row, and enqueue notification outbox entries.
--
-- What this does NOT change:
--   * transition_slot_booking (manual confirmation flow) — untouched.
--   * process_payment_paid_event (future webhook providers) — untouched.
--   * create_booking / get_open_slots / expiry functions — untouched.
--   * No RLS policy is weakened anywhere.

-- ===========================================================================
-- 1. payment_slip_verifications: append-only verification audit
-- ===========================================================================
-- One row per verification attempt. 'confirmed' rows are the transaction
-- claims; all other outcomes are evidence for support/dispute resolution.
-- evidence holds ONLY normalized provider-neutral fields (tx ref, transfer
-- time, amount, masked receiver/sender display) — never the raw provider
-- payload and never an image.
create table if not exists public.payment_slip_verifications (
  id               uuid        primary key default gen_random_uuid(),
  payment_order_id uuid        not null references public.payment_orders (id),
  booking_id       uuid        not null references public.bookings (id),
  provider         text        not null,          -- e.g. 'easyslip'
  provider_tx_ref  text,                          -- null when unreadable
  transfer_at      timestamptz,
  amount_satang    int,
  outcome          text        not null
                     check (outcome in (
                       -- decided inside confirm_slip_payment:
                       'confirmed', 'duplicate_tx', 'amount_mismatch',
                       'booking_ineligible', 'order_not_payable',
                       -- decided by the server before the RPC:
                       'provider_unverified', 'tx_ref_missing',
                       'timestamp_out_of_window', 'receiver_mismatch',
                       'invalid_image', 'provider_error'
                     )),
  evidence         jsonb,
  created_at       timestamptz not null default now()
);

-- THE one-transaction-one-payment invariant. A (provider, tx_ref) pair may
-- have at most one 'confirmed' row, ever. Concurrent confirmations of the
-- same bank transaction serialize here: the loser gets unique_violation and
-- confirm_slip_payment converts it into a safe duplicate_tx result.
create unique index if not exists payment_slip_verifications_tx_claim_uniq
  on public.payment_slip_verifications (provider, provider_tx_ref)
  where outcome = 'confirmed' and provider_tx_ref is not null;

-- Attempt counting per order (abuse control) and admin lookups.
create index if not exists payment_slip_verifications_order_idx
  on public.payment_slip_verifications (payment_order_id);

create index if not exists payment_slip_verifications_booking_idx
  on public.payment_slip_verifications (booking_id);

alter table public.payment_slip_verifications enable row level security;
revoke all on table public.payment_slip_verifications from anon, authenticated;
grant all on table public.payment_slip_verifications to service_role;

-- ===========================================================================
-- 2. confirm_slip_payment: atomic, idempotent slip-payment confirmation
-- ===========================================================================
-- All parameters are TRUSTED server-side values: the tx ref, transfer time
-- and amount come from the verification provider via the server; nothing here
-- is ever browser-supplied. The function still re-validates everything
-- against locked rows so a stale or replayed call cannot corrupt state.
--
-- Locking order: payment_orders row first, then bookings row (same order as
-- process_payment_paid_event — no deadlock between the two paths).
--
-- Exact state transitions performed on success:
--   payment_orders:  created|pending -> paid
--   bookings:        pending_payment (live hold) -> confirmed
-- Exception transition (verified money but ineligible booking):
--   payment_orders:  created|pending -> manual_review   (booking untouched)
--
-- Results (jsonb):
--   {result:'ok', booking_id}            confirmed now
--   {result:'already_paid', booking_id}  safe idempotent retry (same order
--                                        already paid — incl. same tx replay)
--   {result:'rejected', reason:'duplicate_tx'}      tx already paid another order
--   {result:'rejected', reason:'amount_mismatch'}   order amount != slip amount
--   {result:'rejected', reason:'order_<status>'}    order expired/failed/refunded
--   {result:'manual_review', reason:'booking_<status>'|'hold_expired'}
--
-- Idempotency / concurrency guarantees:
--   * Repeating a successful call (same order, same tx_ref) returns
--     already_paid without touching any row.
--   * Replaying the same tx_ref against a different order returns
--     rejected/duplicate_tx (partial unique index is the backstop).
--   * Two concurrent calls for the same order serialize on the order row
--     lock; the loser observes status='paid' and returns already_paid.
--   * All writes (order, booking, audit, outbox) happen in this single
--     function = single transaction: they commit or roll back together.
create or replace function public.confirm_slip_payment(
  p_payment_order_id uuid,
  p_provider         text,
  p_provider_tx_ref  text,
  p_transfer_at      timestamptz,
  p_amount_satang    int,
  p_evidence         jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
as $$
declare
  v_order   public.payment_orders;
  v_booking public.bookings;
  v_claim   public.payment_slip_verifications;
  v_reason  text;
begin
  if p_provider is null or btrim(p_provider) = '' then
    raise exception 'invalid_provider';
  end if;
  if p_provider_tx_ref is null or btrim(p_provider_tx_ref) = '' then
    raise exception 'invalid_tx_ref';
  end if;
  if p_amount_satang is null or p_amount_satang <= 0 then
    raise exception 'invalid_amount';
  end if;

  -- Lock the payment order. Concurrent calls for the same order queue here.
  select * into v_order from public.payment_orders
   where id = p_payment_order_id for update;
  if not found then raise exception 'payment_order_not_found'; end if;

  -- Has this bank transaction already confirmed a payment?
  select * into v_claim from public.payment_slip_verifications
   where provider = p_provider
     and provider_tx_ref = p_provider_tx_ref
     and outcome = 'confirmed'
   limit 1;
  if found then
    if v_claim.payment_order_id = p_payment_order_id then
      -- Same slip re-uploaded to the same booking: safe no-op.
      return jsonb_build_object('result', 'already_paid',
                                'booking_id', v_order.booking_id);
    end if;
    -- Same transaction attempted against a DIFFERENT order: hard reject.
    insert into public.payment_slip_verifications (
      payment_order_id, booking_id, provider, provider_tx_ref,
      transfer_at, amount_satang, outcome, evidence
    ) values (
      p_payment_order_id, v_order.booking_id, p_provider, p_provider_tx_ref,
      p_transfer_at, p_amount_satang, 'duplicate_tx', p_evidence
    );
    return jsonb_build_object('result', 'rejected', 'reason', 'duplicate_tx');
  end if;

  -- Order already paid (by another slip or a future webhook): idempotent.
  if v_order.status = 'paid' then
    return jsonb_build_object('result', 'already_paid',
                              'booking_id', v_order.booking_id);
  end if;

  -- Order not payable (expired/failed/refunded/manual_review).
  if v_order.status not in ('created', 'pending') then
    insert into public.payment_slip_verifications (
      payment_order_id, booking_id, provider, provider_tx_ref,
      transfer_at, amount_satang, outcome, evidence
    ) values (
      p_payment_order_id, v_order.booking_id, p_provider, p_provider_tx_ref,
      p_transfer_at, p_amount_satang, 'order_not_payable', p_evidence
    );
    return jsonb_build_object('result', 'rejected',
                              'reason', 'order_' || v_order.status);
  end if;

  -- Amount must equal the trusted order amount exactly. The order stays
  -- open: the customer may have picked the wrong screenshot and can retry.
  if p_amount_satang <> v_order.amount_satang then
    insert into public.payment_slip_verifications (
      payment_order_id, booking_id, provider, provider_tx_ref,
      transfer_at, amount_satang, outcome, evidence
    ) values (
      p_payment_order_id, v_order.booking_id, p_provider, p_provider_tx_ref,
      p_transfer_at, p_amount_satang, 'amount_mismatch', p_evidence
    );
    return jsonb_build_object('result', 'rejected', 'reason', 'amount_mismatch');
  end if;

  -- Lock the booking row (second lock, same order as process_payment_paid_event).
  select * into v_booking from public.bookings
   where id = v_order.booking_id for update;
  if not found then raise exception 'booking_not_found'; end if;

  -- Hold eligibility: identical trust bar to the manual confirmPayment flow
  -- (0008): only a pending_payment booking with a LIVE hold may be confirmed.
  -- A verified payment for an ineligible booking is real money we cannot
  -- auto-place — park the order for humans and alert the team. The booking
  -- itself is never auto-revived, auto-expired, or auto-cancelled here.
  if v_booking.status <> 'pending_payment'
     or v_booking.hold_expires_at is null
     or v_booking.hold_expires_at <= now() then
    v_reason := case
      when v_booking.status <> 'pending_payment' then 'booking_' || v_booking.status
      else 'hold_expired'
    end;

    update public.payment_orders
       set status                 = 'manual_review',
           amount_received_satang = p_amount_satang,
           provider_paid_at       = p_transfer_at,
           provider_payload       = p_evidence,
           failure_code           = v_reason,
           updated_at             = now()
     where id = p_payment_order_id;

    insert into public.payment_slip_verifications (
      payment_order_id, booking_id, provider, provider_tx_ref,
      transfer_at, amount_satang, outcome, evidence
    ) values (
      p_payment_order_id, v_order.booking_id, p_provider, p_provider_tx_ref,
      p_transfer_at, p_amount_satang, 'booking_ineligible', p_evidence
    );

    -- Alert the team through the durable outbox (idempotent).
    insert into public.notification_deliveries (
      booking_id, payment_order_id, channel, recipient_type,
      event_type, idempotency_key, payload
    ) values (
      v_order.booking_id, p_payment_order_id,
      'line', 'team', 'slip_manual_review',
      'slip:review:' || p_payment_order_id::text,
      jsonb_build_object(
        'booking_id', v_order.booking_id,
        'payment_order_id', p_payment_order_id,
        'reason', v_reason
      )
    )
    on conflict (idempotency_key) do nothing;

    return jsonb_build_object('result', 'manual_review', 'reason', v_reason);
  end if;

  -- Claim the transaction reference. The partial unique index is the
  -- concurrency backstop: if another request claimed this tx_ref between our
  -- check above and this insert, we get unique_violation and resolve it.
  begin
    insert into public.payment_slip_verifications (
      payment_order_id, booking_id, provider, provider_tx_ref,
      transfer_at, amount_satang, outcome, evidence
    ) values (
      p_payment_order_id, v_order.booking_id, p_provider, p_provider_tx_ref,
      p_transfer_at, p_amount_satang, 'confirmed', p_evidence
    );
  exception when unique_violation then
    select * into v_claim from public.payment_slip_verifications
     where provider = p_provider
       and provider_tx_ref = p_provider_tx_ref
       and outcome = 'confirmed';
    if found and v_claim.payment_order_id = p_payment_order_id then
      return jsonb_build_object('result', 'already_paid',
                                'booking_id', v_order.booking_id);
    end if;
    return jsonb_build_object('result', 'rejected', 'reason', 'duplicate_tx');
  end;

  -- Record the payment on the order.
  update public.payment_orders
     set status                 = 'paid',
         paid_at                = now(),
         amount_received_satang = p_amount_satang,
         provider_paid_at       = coalesce(p_transfer_at, now()),
         provider_payload       = p_evidence,
         updated_at             = now()
   where id = p_payment_order_id;

  -- Trusted transition: pending_payment (live hold, verified above under
  -- lock) -> confirmed. A live hold already occupies its seat (same
  -- invariant transition_slot_booking relies on), so no capacity re-count
  -- is needed and no other booking can be displaced.
  update public.bookings
     set status          = 'confirmed',
         hold_expires_at = null,
         updated_at      = now()
   where id = v_order.booking_id;

  -- Outbox: notification intents only — never sent from here. Uses the SAME
  -- idempotency keys as process_payment_paid_event so a booking can never
  -- receive double "paid" notifications across the two paths.
  insert into public.notification_deliveries (
    booking_id, payment_order_id, channel, recipient_type,
    event_type, idempotency_key, payload
  ) values
  (
    v_order.booking_id, p_payment_order_id,
    'line', 'customer', 'payment_confirmed',
    'pay:confirmed:customer:' || p_payment_order_id::text,
    jsonb_build_object(
      'booking_id', v_order.booking_id,
      'payment_order_id', p_payment_order_id
    )
  ),
  (
    v_order.booking_id, p_payment_order_id,
    'line', 'team', 'payment_received',
    'pay:received:team:' || p_payment_order_id::text,
    jsonb_build_object(
      'booking_id', v_order.booking_id,
      'payment_order_id', p_payment_order_id
    )
  )
  on conflict (idempotency_key) do nothing;

  return jsonb_build_object('result', 'ok', 'booking_id', v_order.booking_id);
end;
$$;

revoke all on function public.confirm_slip_payment(uuid, text, text, timestamptz, int, jsonb)
  from public, anon, authenticated;
grant execute on function public.confirm_slip_payment(uuid, text, text, timestamptz, int, jsonb)
  to service_role;

-- ROLLBACK (non-destructive):
--   drop function if exists public.confirm_slip_payment(uuid, text, text, timestamptz, int, jsonb);
--   -- Keep payment_slip_verifications: it is append-only audit evidence.
--   -- If it must be removed before any production writes:
--   --   drop table if exists public.payment_slip_verifications;
