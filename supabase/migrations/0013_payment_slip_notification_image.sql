-- Attach BOTH the customer's face-verification photo AND the actual
-- uploaded payment-slip image to team notifications for every
-- payment-verified confirmation path, each independently and durably
-- retryable — instead of one image field ambiguously standing in for either
-- meaning.
--
-- PROPOSED — do not apply without review. Run AFTER
-- 0012_booking_confirmed_notification.sql. Never auto-applied by this repo;
-- apply manually via the Supabase SQL editor per the project's existing
-- workflow.
--
-- Forward-only: this migration does not edit 0012_booking_confirmed_notification.sql
-- (already applied to Production; its own post-migration verification
-- already passed) or any earlier migration. It only issues
-- `create or replace function` for confirm_slip_payment,
-- approve_manual_review_payment, and transition_slot_booking, each
-- reproducing its current (0012) body verbatim plus the additive change
-- described below. All three keep their existing signatures, invoker
-- rights, and revoke/grant pairs unchanged.
--
-- Correction note (this revision): an earlier draft of this migration
-- incorrectly made the face and slip images mutually exclusive — payment
-- paths carried only the slip, and admin_override lost its face image
-- entirely. That was wrong: the face photo (already sent once with the
-- initial booking notification) and the slip (payment evidence) are two
-- separate pieces of information the team needs together, not substitutes
-- for one another. This revision sends both, tracked independently.
--
-- Correction note (release-blocker fixes, this revision):
--   1. claim_notification_image_deliveries could claim a face/slip row
--      before its parent notification_deliveries row had actually reached
--      'sent' — a retryable/pending/processing/dead parent text row no
--      longer blocks its own image rows from being claimed and sent ahead of
--      it. The gate is enforced inside the claim function's own candidate
--      query (an EXISTS check against notification_deliveries.status), not
--      only by worker sequencing in TypeScript.
--   2. The TS upload route's recordEvidenceFailure ignored a returned
--      { error } from the Supabase insert (only a thrown exception was
--      handled). Every evidence-storage function now returns an explicit
--      typed outcome so a caller can never mistake "insert returned an
--      error" for "recorded".
--   3. The slip object path was deterministic
--      (<booking_id>/<payment_order_id>.<ext>) and uploaded with
--      upsert: true, so a later or concurrent upload attempt for the same
--      order could overwrite the bytes an earlier successful attempt's
--      payment_slip_images row still referenced. Evidence objects are now
--      immutable: each upload gets its own unique path
--      (<booking_id>/<payment_order_id>/<uuid>.<ext>), uploaded with
--      upsert: false, and payment_slip_images.storage_path is now unique.
--      confirm_slip_payment's evidence lookups now break created_at ties on
--      id (order by created_at desc, id desc) so the freshest row is picked
--      deterministically even when two uploads for the same order commit in
--      the same millisecond.
--
-- The three parts:
--
--   1. A private Storage bucket 'payment-slips' (separate from
--      'booking-faces': never mix payment evidence and identity photos in
--      one bucket) plus public.payment_slip_images, recording every
--      accepted upload: (payment_order_id, booking_id, storage_path,
--      mime_type, created_at). Populated by the TS upload route
--      (src/app/api/pay/[token]/slip/route.ts) AFTER local image
--      validation, EasySlip provider verification, and slip policy checks
--      all pass. Images that fail validation or provider verification are
--      never stored; provider-verified outcomes (including an amount
--      mismatch or any other manual-review outcome) are retained as
--      evidence. Mirrors the existing public.booking_images
--      lookup-by-latest-row pattern — no RPC signature changes.
--      public.payment_slip_evidence_failures records the (rare) case where
--      the upload or its DB record failed, so a failed evidence write is
--      durably visible for manual follow-up rather than only console-logged.
--
--   2. public.notification_image_deliveries: one row per (notification, image
--      kind) — 'face' or 'payment_slip' — each with its OWN status,
--      attempt_count, next_retry_at, sent_at, last_error, and stable
--      line_retry_key, claimed/completed via a dedicated pair of RPCs
--      (claim_notification_image_deliveries /
--      complete_notification_image_delivery) that mirror
--      claim_team_notification_deliveries / complete_notification_delivery
--      (0007_team_notification_outbox.sql) exactly — same lease/backoff
--      semantics, entirely independent of the parent notification_deliveries
--      row's own lifecycle. This is what makes a face failure never block or
--      resend the slip (and vice versa), and lets a future cron tick retry
--      only the image that is still outstanding, indefinitely, even after
--      the parent text row has long since reached 'sent'.
--
--      0012's image_retry_key column (on notification_deliveries) is
--      superseded by this per-row-per-kind design and is no longer written
--      or read going forward. It is left in place (0012 is frozen) — an
--      inert, harmless column, exactly like this project's convention for
--      superseded-but-additive columns elsewhere.
--
--   3. confirm_slip_payment (both its manual_review and success branches)
--      inserts a 'face' row (from booking_images) and a 'payment_slip' row
--      (from payment_slip_images) for its notification_deliveries row,
--      whichever paths are actually on file — never both unconditionally,
--      never neither's absence blocking the other.
--      transition_slot_booking (admin override, no verified payment) inserts
--      only a 'face' row — never a slip, and never implies a payment was
--      received.
--      approve_manual_review_payment inserts NO new image rows at all: by
--      the time an order can be approved it is already 'manual_review',
--      which is only ever reached via confirm_slip_payment's manual_review
--      branch — which has already enqueued the slip_manual_review
--      notification carrying both image rows. Approving it must never
--      duplicate those sends; the original rows keep retrying independently
--      (via next_retry_at) regardless of the approval event, until sent or
--      durably dead.
--      The notification_deliveries jsonb payload no longer carries any
--      image-path field at all (neither the old 'image_storage_path' nor a
--      new one) — image delivery is entirely driven by
--      notification_image_deliveries now, keeping the payload to pure
--      text-rendering fields.
--
-- Atomicity: the entire migration runs inside one BEGIN/COMMIT, same as
-- every other migration in this repo.

begin;

-- ===========================================================================
-- 1. Private storage bucket for payment-slip evidence images. Separate from
--    'booking-faces' (0001_init.sql) — payment evidence and identity photos
--    are never mixed in one bucket.
-- ===========================================================================
insert into storage.buckets (id, name, public)
values ('payment-slips', 'payment-slips', false)
on conflict (id) do nothing;

-- ===========================================================================
-- 2. payment_slip_images — one row per accepted upload. Append-only, same
--    security model as payment_slip_verifications (0011): RLS enabled, no
--    anon/authenticated grants, service_role only.
-- ===========================================================================
create table if not exists public.payment_slip_images (
  id                uuid        primary key default gen_random_uuid(),
  payment_order_id  uuid        not null references public.payment_orders (id),
  booking_id        uuid        not null references public.bookings (id),
  storage_path      text        not null,
  mime_type         text        not null,
  created_at        timestamptz not null default now()
);
create index if not exists payment_slip_images_order_idx
  on public.payment_slip_images(payment_order_id, created_at desc);
-- Evidence objects are immutable and each upload gets its own unique path
-- (see the TS upload route) — this constraint is the DB-level guarantee that
-- two rows can never claim the same underlying storage object.
create unique index if not exists payment_slip_images_storage_path_uniq
  on public.payment_slip_images(storage_path);
alter table public.payment_slip_images enable row level security;
revoke all on table public.payment_slip_images from anon, authenticated;
grant all on table public.payment_slip_images to service_role;

-- ===========================================================================
-- 2b. payment_slip_evidence_failures — durable, queryable record of a slip
--     evidence write that failed (upload or DB record), so it stays visible
--     for manual follow-up instead of only appearing in a console log.
--     'stage' is a fixed code, never free-text/error detail.
-- ===========================================================================
create table if not exists public.payment_slip_evidence_failures (
  id                uuid        primary key default gen_random_uuid(),
  payment_order_id  uuid        not null references public.payment_orders (id),
  booking_id        uuid        not null references public.bookings (id),
  stage             text        not null check (stage in ('upload', 'record')),
  created_at        timestamptz not null default now()
);
create index if not exists payment_slip_evidence_failures_order_idx
  on public.payment_slip_evidence_failures(payment_order_id, created_at desc);
alter table public.payment_slip_evidence_failures enable row level security;
revoke all on table public.payment_slip_evidence_failures from anon, authenticated;
grant all on table public.payment_slip_evidence_failures to service_role;

-- ===========================================================================
-- 3. notification_image_deliveries — one row per (notification_delivery_id,
--    image_kind). Same status/lease/backoff shape as notification_deliveries
--    itself (0007), but entirely independent: an image's retry schedule
--    never depends on the parent text row's status.
-- ===========================================================================
create table if not exists public.notification_image_deliveries (
  id                        uuid        primary key default gen_random_uuid(),
  notification_delivery_id  uuid        not null references public.notification_deliveries (id),
  image_kind                text        not null check (image_kind in ('face', 'payment_slip')),
  storage_path              text        not null,
  status                    text        not null default 'pending'
                              check (status in ('pending', 'processing', 'sent', 'failed', 'dead')),
  attempt_count             int         not null default 0,
  next_retry_at             timestamptz,
  sent_at                   timestamptz,
  last_error                text,
  line_retry_key            uuid        not null default gen_random_uuid(),
  locked_by                 text,
  locked_at                 timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (notification_delivery_id, image_kind)
);
create index if not exists notification_image_deliveries_due_idx
  on public.notification_image_deliveries (status, next_retry_at);
create index if not exists notification_image_deliveries_locked_idx
  on public.notification_image_deliveries (locked_at)
  where status = 'processing';
create unique index if not exists notification_image_deliveries_line_retry_key_uniq
  on public.notification_image_deliveries(line_retry_key);
alter table public.notification_image_deliveries enable row level security;
revoke all on table public.notification_image_deliveries from anon, authenticated;
grant all on table public.notification_image_deliveries to service_role;

-- ===========================================================================
-- 4. claim_notification_image_deliveries — atomic batch claim, mirroring
--    claim_team_notification_deliveries (0007) exactly: pending/failed rows
--    due for retry, or a 'processing' row whose lease has gone stale
--    (worker crashed mid-send), FOR UPDATE SKIP LOCKED so two workers can
--    never claim the same row. Additionally gated on the parent
--    notification_deliveries row already being 'sent' — an image must never
--    reach LINE ahead of (or in place of) its own text, so a
--    pending/processing/failed/dead parent blocks every one of its image
--    rows from being claimed until the text is delivered. Enforced here
--    (not only by TypeScript worker sequencing) so no future caller of this
--    RPC can accidentally bypass the ordering guarantee.
-- ===========================================================================
create function public.claim_notification_image_deliveries(
  p_worker_id text,
  p_batch     int
)
returns table (
  id                        uuid,
  notification_delivery_id  uuid,
  image_kind                text,
  storage_path              text,
  line_retry_key            uuid,
  attempt_count             int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch int;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then raise exception 'invalid_worker_id'; end if;
  if p_batch is null or p_batch < 1 then raise exception 'invalid_batch'; end if;
  v_batch := least(p_batch, 100);

  return query
    with candidates as (
      select nid.id
        from public.notification_image_deliveries nid
       where (
              (nid.status in ('pending', 'failed')
               and (nid.next_retry_at is null or nid.next_retry_at <= now()))
           or (nid.status = 'processing' and nid.locked_at < now() - interval '10 minutes')
         )
         and exists (
               select 1 from public.notification_deliveries nd
                where nd.id = nid.notification_delivery_id
                  and nd.status = 'sent'
             )
       order by nid.created_at
       limit v_batch
         for update skip locked
    )
    update public.notification_image_deliveries upd
       set status = 'processing', locked_by = p_worker_id, locked_at = now(), updated_at = now()
      from candidates
     where upd.id = candidates.id
    returning upd.id, upd.notification_delivery_id, upd.image_kind, upd.storage_path,
              upd.line_retry_key, upd.attempt_count;
end;
$$;
revoke all on function public.claim_notification_image_deliveries(text, int) from public, anon, authenticated;
grant execute on function public.claim_notification_image_deliveries(text, int) to service_role;

-- ===========================================================================
-- 5. complete_notification_image_delivery — worker-fenced outcome recording,
--    mirroring complete_notification_delivery (0007) exactly: same
--    sent/dead/retry semantics and the same fixed backoff schedule
--    (1m / 5m / 15m / 60m / 360m, dead at attempt 6), with jitter.
-- ===========================================================================
create function public.complete_notification_image_delivery(
  p_id        uuid,
  p_worker_id text,
  p_outcome   text,
  p_error     text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row          public.notification_image_deliveries;
  v_attempt      int;
  v_base_minutes int;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then raise exception 'invalid_worker_id'; end if;
  if p_outcome not in ('sent', 'retry', 'dead') then raise exception 'invalid_outcome'; end if;

  select * into v_row
    from public.notification_image_deliveries
   where id = p_id and status = 'processing' and locked_by = p_worker_id
   for update;

  if not found then
    return false;
  end if;

  if p_outcome = 'sent' then
    update public.notification_image_deliveries
       set status = 'sent', sent_at = now(), next_retry_at = null, last_error = null,
           locked_by = null, locked_at = null, updated_at = now()
     where id = p_id and status = 'processing' and locked_by = p_worker_id;
    return true;
  end if;

  if p_outcome = 'dead' then
    update public.notification_image_deliveries
       set status = 'dead', next_retry_at = null, last_error = p_error,
           locked_by = null, locked_at = null, updated_at = now()
     where id = p_id and status = 'processing' and locked_by = p_worker_id;
    return true;
  end if;

  -- p_outcome = 'retry': calculate the retry count exactly once.
  v_attempt := v_row.attempt_count + 1;

  if v_attempt >= 6 then
    update public.notification_image_deliveries
       set attempt_count = v_attempt, status = 'dead', next_retry_at = null, last_error = p_error,
           locked_by = null, locked_at = null, updated_at = now()
     where id = p_id and status = 'processing' and locked_by = p_worker_id;
    return true;
  end if;

  v_base_minutes := case v_attempt
    when 1 then 1
    when 2 then 5
    when 3 then 15
    when 4 then 60
    when 5 then 360
  end;

  update public.notification_image_deliveries
     set attempt_count = v_attempt,
         status = 'failed',
         next_retry_at = now() + (make_interval(mins => v_base_minutes) * (0.8 + random() * 0.4)),
         last_error = p_error,
         locked_by = null, locked_at = null, updated_at = now()
   where id = p_id and status = 'processing' and locked_by = p_worker_id;

  return true;
end;
$$;
revoke all on function public.complete_notification_image_delivery(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_notification_image_delivery(uuid, text, text, text) to service_role;

-- ===========================================================================
-- 6. confirm_slip_payment — replaces the version from
--    0012_booking_confirmed_notification.sql. Same signature, invoker
--    rights, and revoke/grant pair. Both branches now enqueue independent
--    'face' and 'payment_slip' image-delivery rows (whichever paths are
--    actually on file) instead of a single ambiguous image field.
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

  if v_order.status not in ('created','pending') then
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

-- ===========================================================================
-- 7. approve_manual_review_payment — replaces the version from
--    0012_booking_confirmed_notification.sql. Same signature. Enqueues NO
--    new image-delivery rows: this booking's face/slip rows already exist
--    (and are independently retrying) from the slip_manual_review
--    notification confirm_slip_payment enqueued when it first routed this
--    order to manual_review — approval must never duplicate those sends.
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
  v_others int;
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
  if v_booking.hold_expires_at is null
     or v_booking.hold_expires_at <= clock_timestamp()
  then
    raise exception 'hold_expired';
  end if;
  if v_booking.slot_id is null then raise exception 'not_slot_booking'; end if;

  -- Lock the slot after the booking, then count every other current occupant
  -- while the slot lock prevents create_booking from inserting a competitor.
  select * into v_slot from public.booking_slots
   where id = v_booking.slot_id for update;
  if not found or not v_slot.is_open then raise exception 'slot_closed'; end if;
  select count(*) into v_others
    from public.bookings
   where slot_id = v_booking.slot_id
     and id <> p_booking_id
     and (
       status in ('booked', 'confirmed', 'completed')
       or (status = 'pending_payment' and hold_expires_at > clock_timestamp())
     );
  if v_others >= v_slot.capacity then raise exception 'slot_full'; end if;

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

  -- Single canonical successful-confirmation notification (see 0012's
  -- header for the dedup rationale): booking_confirmed only. No image rows
  -- here — see this migration's header note.
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
      'expected_amount_satang', v_order.amount_satang,
      'received_amount_satang', v_transaction.amount_satang,
      'updated_at', now()
    )
  )
  on conflict (idempotency_key) do nothing;

  return jsonb_build_object('result','ok','booking_id',p_booking_id);
end;
$$;
revoke all on function public.approve_manual_review_payment(uuid) from public, anon, authenticated;
grant execute on function public.approve_manual_review_payment(uuid) to service_role;

-- ===========================================================================
-- 8. transition_slot_booking — replaces the version from
--    0012_booking_confirmed_notification.sql. Same signature. The admin
--    non-payment override path has no verified payment and must never
--    attach a slip or imply payment was received — but it DOES still attach
--    the customer's face photo, same as before 0013.
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
  v_face_path     text;
  v_notification_id uuid;
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
       and (v_booking.hold_expires_at is null or v_booking.hold_expires_at <= clock_timestamp())
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

    -- Enqueue the team LINE booking-summary notification (see header for the
    -- full dedup/race/never-inline rationale, shared by all three RPCs in
    -- this migration). Face image only — no payment, so no slip and no
    -- amount fields.
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

-- ROLLBACK (non-destructive):
--   Re-run 0012_booking_confirmed_notification.sql's CREATE OR REPLACE
--   statements for transition_slot_booking, confirm_slip_payment, and
--   approve_manual_review_payment to restore their pre-0013 bodies. Do NOT
--   drop the payment-slips bucket, payment_slip_images,
--   payment_slip_evidence_failures, or notification_image_deliveries —
--   all are additive and harmless to leave in place; any rows/objects
--   already written are payment evidence and should be retained regardless
--   of whether this migration is rolled back at the application layer.
