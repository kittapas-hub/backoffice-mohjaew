-- Phase 1 slip verification. PROPOSED: Run AFTER 0010_reconcile_0006_0009.sql.
-- Tests may apply it only to a clearly disposable local database.
begin;

-- A profile is immutable payment truth for a PromptPay slip order. Existing
-- historical orders remain readable; the NOT VALID constraint protects every
-- order written after this migration without rewriting old data.
alter table public.payment_orders add column if not exists receiver_profile text;
alter table public.payment_orders drop constraint if exists payment_orders_promptpay_profile_check;
alter table public.payment_orders add constraint payment_orders_promptpay_profile_check
  check (provider <> 'promptpay_slip' or (currency = 'THB' and receiver_profile is not null)) not valid;

-- Payment truth is fixed when an order is created. Status/evidence fields may
-- advance, but neither service_role nor future application code may retarget
-- an order or change what it is supposed to collect.
create or replace function public.reject_payment_order_trust_field_change()
returns trigger language plpgsql as $$
begin
  if new.booking_id is distinct from old.booking_id
     or new.provider is distinct from old.provider
     or new.currency is distinct from old.currency
     or new.amount_satang is distinct from old.amount_satang
     or new.receiver_profile is distinct from old.receiver_profile then
    raise exception 'payment_order_trust_fields_immutable';
  end if;
  return new;
end;
$$;
revoke all on function public.reject_payment_order_trust_field_change() from public, anon, authenticated;
drop trigger if exists payment_orders_trust_fields_immutable on public.payment_orders;
create trigger payment_orders_trust_fields_immutable
before update of booking_id, provider, currency, amount_satang, receiver_profile
on public.payment_orders for each row
execute function public.reject_payment_order_trust_field_change();

-- Append-only attempt audit. The durable ledger below, not this table, owns
-- the one-real-transaction-one-payment invariant.
create table if not exists public.payment_slip_verifications (
  id uuid primary key default gen_random_uuid(),
  payment_order_id uuid not null references public.payment_orders(id),
  booking_id uuid not null references public.bookings(id),
  provider text not null,
  provider_tx_ref text,
  transfer_at timestamptz,
  amount_satang int,
  outcome text not null check (outcome in (
    'confirmed','manual_review','duplicate_tx','provider_unverified',
    'tx_ref_missing','invalid_image','provider_error'
  )),
  evidence jsonb,
  created_at timestamptz not null default now()
);
drop index if exists public.payment_slip_verifications_tx_claim_uniq;
create index if not exists payment_slip_verifications_order_idx
  on public.payment_slip_verifications(payment_order_id);
alter table public.payment_slip_verifications enable row level security;
revoke all on table public.payment_slip_verifications from anon, authenticated;
grant all on table public.payment_slip_verifications to service_role;

-- Every provider-verified real transaction has exactly one durable claim,
-- including late/ambiguous/mismatched transactions sent to manual review.
create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  normalized_tx_ref text not null,
  payment_order_id uuid not null references public.payment_orders(id),
  booking_id uuid not null references public.bookings(id),
  transfer_at timestamptz not null,
  amount_satang int not null check (amount_satang > 0),
  currency text not null,
  receiver_profile text,
  resolution text not null default 'claimed'
    check (resolution in ('claimed','confirmed','manual_review')),
  resolution_reason text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index if not exists payment_transactions_provider_ref_uniq
  on public.payment_transactions(provider, normalized_tx_ref);
alter table public.payment_transactions enable row level security;
revoke all on table public.payment_transactions from anon, authenticated;
grant all on table public.payment_transactions to service_role;

-- Explicit POST-only order creation calls this RPC. It never returns an active
-- order created for another provider/profile/amount/currency combination.
create or replace function public.create_slip_payment_order(
  p_booking_id uuid,
  p_idempotency_key text,
  p_amount_satang int,
  p_receiver_profile text
) returns public.payment_orders
language plpgsql
as $$
declare v_booking public.bookings; v_order public.payment_orders;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then raise exception 'invalid_idempotency_key'; end if;
  if p_amount_satang is null or p_amount_satang <= 0 then raise exception 'invalid_amount'; end if;
  if p_receiver_profile is null or btrim(p_receiver_profile) = '' then raise exception 'invalid_receiver_profile'; end if;

  select * into v_order from public.payment_orders where idempotency_key = p_idempotency_key;
  if found then
    if v_order.provider <> 'promptpay_slip' or v_order.currency <> 'THB'
       or v_order.amount_satang <> p_amount_satang
       or v_order.receiver_profile is distinct from p_receiver_profile then
      raise exception 'idempotency_key_incompatible';
    end if;
    return v_order;
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'booking_not_found'; end if;
  if v_booking.status <> 'pending_payment' then raise exception 'booking_not_pending_payment'; end if;
  if v_booking.hold_expires_at is null or v_booking.hold_expires_at <= now() then raise exception 'booking_hold_expired'; end if;

  perform 1 from public.payment_orders where booking_id = p_booking_id and status in ('created','pending');
  if found then raise exception 'active_order_exists'; end if;

  insert into public.payment_orders(
    booking_id, provider, idempotency_key, amount_satang, currency, status,
    expires_at, receiver_profile
  ) values (
    p_booking_id, 'promptpay_slip', p_idempotency_key, p_amount_satang, 'THB',
    'created', v_booking.hold_expires_at, p_receiver_profile
  ) returning * into v_order;
  return v_order;
end;
$$;
revoke all on function public.create_slip_payment_order(uuid, text, int, text) from public, anon, authenticated;
grant execute on function public.create_slip_payment_order(uuid, text, int, text) to service_role;

-- One locked database transaction owns ordering, replay prevention, manual
-- review, booking/payment/audit/outbox writes, and rollback behaviour.
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
  return jsonb_build_object('result','ok','booking_id',v_order.booking_id);
end;
$$;
revoke all on function public.confirm_slip_payment(uuid, text, text, timestamptz, int, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.confirm_slip_payment(uuid, text, text, timestamptz, int, text, text, jsonb) to service_role;

-- Assisted approval can only finalize provider-verified money that the
-- confirmation RPC already claimed into manual_review. The browser supplies
-- only a booking capability; transaction identity is selected and locked in
-- PostgreSQL. Unclaimed or ambiguous transactions are never accepted here.
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
  return jsonb_build_object('result','ok','booking_id',p_booking_id);
end;
$$;
revoke all on function public.approve_manual_review_payment(uuid) from public, anon, authenticated;
grant execute on function public.approve_manual_review_payment(uuid) to service_role;

-- Stable LINE retry key per outbox row. Existing rows receive a random key
-- exactly once, and retries receive the same value through the claim RPC.
alter table public.notification_deliveries add column if not exists line_retry_key uuid default gen_random_uuid();
update public.notification_deliveries set line_retry_key = gen_random_uuid() where line_retry_key is null;
alter table public.notification_deliveries alter column line_retry_key set not null;

drop function if exists public.claim_team_notification_deliveries(text, int, text[]);
create function public.claim_team_notification_deliveries(
  p_worker_id text, p_batch int, p_event_types text[]
) returns table (
  id uuid, booking_id uuid, payment_order_id uuid, channel text, event_type text,
  payload jsonb, idempotency_key text, attempt_count int, line_retry_key uuid
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
      upd.payload,upd.idempotency_key,upd.attempt_count,upd.line_retry_key;
end;
$$;
revoke all on function public.claim_team_notification_deliveries(text, int, text[]) from public, anon, authenticated;
grant execute on function public.claim_team_notification_deliveries(text, int, text[]) to service_role;

commit;
