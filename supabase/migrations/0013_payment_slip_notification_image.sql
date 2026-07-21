-- Attach the actual uploaded payment-slip image to team notifications, for
-- every path where a payment was verified — instead of (incorrectly) reusing
-- the customer's face-verification photo.
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
-- rights, and revoke/grant pairs unchanged — no DROP + CREATE is needed
-- here, unlike 0012's claim_team_notification_deliveries change.
--
-- The defect: src/app/api/pay/[token]/slip/route.ts forwards the uploaded
-- slip image to the EasySlip provider and never stored it. Meanwhile
-- confirm_slip_payment / approve_manual_review_payment / transition_slot_booking
-- populated 'image_storage_path' from the CUSTOMER'S FACE photo
-- (public.booking_images) — already sent once with the initial booking
-- notification (src/lib/booking-core.ts's sendTeamNotify). The team's
-- booking_confirmed / slip_manual_review LINE notification therefore never
-- carried the actual payment evidence, and for payment paths it silently
-- resent the unrelated face photo.
--
-- The fix, in three parts:
--
--   1. A new private Storage bucket 'payment-slips' (separate from
--      'booking-faces': never mix payment evidence and identity photos in
--      one bucket). Private, no anon/authenticated read or write access —
--      the storage.buckets row has public = false and, like every other
--      bucket in this schema, is never granted any RLS policy; the only way
--      to reach it is the service-role client, which bypasses RLS
--      entirely (src/lib/supabase/admin.ts's supabaseAdmin()).
--
--   2. A new table, public.payment_slip_images, recording every accepted
--      upload: (payment_order_id, booking_id, storage_path, mime_type,
--      created_at). Populated by the TS upload route
--      (src/app/api/pay/[token]/slip/route.ts) AFTER local image
--      validation, EasySlip provider verification, and slip policy checks
--      all pass — i.e. exactly the same point at which the route is about
--      to call confirm_slip_payment. Images that fail basic validation or
--      provider verification are never stored; provider-verified outcomes
--      (including an amount mismatch or any other manual-review outcome)
--      are retained as evidence, matching the existing
--      payment_slip_verifications audit-trail policy. This intentionally
--      mirrors the existing public.booking_images lookup-by-latest-row
--      pattern (see all three functions below) rather than adding a new RPC
--      parameter — no signature changes, no DROP + CREATE required.
--
--      Storage path is deterministic and tied to both ids:
--      '<booking_id>/<payment_order_id>.<ext>' — a non-guessable path (both
--      segments are UUIDs) under a private bucket, never a signed URL. Only
--      the path (never a signed URL) is ever written to
--      payment_slip_images.storage_path or to any notification_deliveries
--      payload — signing happens later, at delivery time, in the TS
--      delivery worker (src/lib/notifications/delivery-worker.ts), exactly
--      like the pre-existing face-image flow.
--
--      Upload/DB-failure cleanup: the route uploads the object to storage
--      FIRST, then inserts the payment_slip_images row. If the row insert
--      fails, the route makes a best-effort attempt to remove the
--      just-uploaded object so a failed evidence write never leaves an
--      unreferenced file. Documented residual failure mode: if that
--      best-effort removal itself fails (e.g. a transient storage outage
--      exactly when the DB insert also failed), the object remains in
--      'payment-slips' with no payment_slip_images row pointing to it — a
--      genuine orphan. This is accepted as a rare, low-severity residual
--      risk (private bucket, no cost/security exposure beyond storage
--      usage) rather than solved with a two-phase-commit; an operator can
--      periodically list objects in 'payment-slips' and diff against
--      existing payment_slip_images.storage_path values to sweep any stray
--      files.
--
--      Retention policy: payment-slip images are payment evidence, exactly
--      like the payment_transactions and payment_slip_verifications rows
--      they sit alongside — retained indefinitely, never auto-deleted by
--      this schema. This matches how every other piece of financial
--      evidence in this schema is already handled (no TTL, no cron
--      deletion); an operator wanting to purge old evidence can do so
--      manually against payment_slip_images joined to terminal
--      payment_orders older than whatever retention window they choose.
--
--   3. confirm_slip_payment / approve_manual_review_payment now populate
--      the notification payload's 'slip_storage_path' field (a NEW,
--      distinct field — never reusing 'image_storage_path' for both a face
--      and a slip) from payment_slip_images, instead of 'image_storage_path'
--      from booking_images. transition_slot_booking (admin override, no
--      verified payment) drops the image lookup entirely: it must never
--      attach any image and must never imply a payment was received —
--      matching the existing admin_override wording
--      ("ทีมงานยืนยันการจองแล้ว") which never claims payment receipt.
--
-- Atomicity: the entire migration runs inside one BEGIN/COMMIT, same as
-- every other migration in this repo.
--
-- Delivery-worker side (TS, not SQL, not part of this migration but
-- described here for completeness): the worker now signs/sends from the
-- 'payment-slips' bucket using the 'slip_storage_path' payload field,
-- covering both booking_confirmed (payment-verified paths only) and
-- slip_manual_review rows, sent only after the text push has already
-- succeeded — same never-resend-text-on-image-failure and same stable,
-- independent line_retry_key / image_retry_key columns as before (no new
-- columns needed; image_retry_key already existed generically on every
-- notification_deliveries row since 0012). admin_override rows carry no
-- 'slip_storage_path' at all and are additionally guarded at render time so
-- an image is never attempted for that confirmation method.

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
alter table public.payment_slip_images enable row level security;
revoke all on table public.payment_slip_images from anon, authenticated;
grant all on table public.payment_slip_images to service_role;

-- ===========================================================================
-- 3. confirm_slip_payment — replaces the version from
--    0012_booking_confirmed_notification.sql. Same signature, invoker
--    rights, and revoke/grant pair. Only change: the notification
--    payloads now carry 'slip_storage_path' (looked up from
--    payment_slip_images) instead of 'image_storage_path' (looked up from
--    booking_images).
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
  v_slip_path text;
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

    -- Payment-slip evidence: looked up by the freshest upload for THIS
    -- payment order (mirrors the pre-0013 face-image lookup pattern
    -- exactly) — never a signed URL, only the private storage path.
    select psi.storage_path into v_slip_path
      from public.payment_slip_images psi
     where psi.payment_order_id = p_payment_order_id
     order by psi.created_at desc
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
                         'received_amount_satang',p_amount_satang,
                         'slip_storage_path',v_slip_path))
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

  -- Single canonical successful-confirmation notification (see 0012's
  -- header for the dedup rationale): booking_confirmed only.
  select * into v_slot from public.booking_slots where id = v_booking.slot_id;
  select psi.storage_path into v_slip_path
    from public.payment_slip_images psi
   where psi.payment_order_id = p_payment_order_id
   order by psi.created_at desc
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
      'updated_at', now(),
      'slip_storage_path', v_slip_path
    )
  )
  on conflict (idempotency_key) do nothing;

  return jsonb_build_object('result','ok','booking_id',v_order.booking_id);
end;
$$;
revoke all on function public.confirm_slip_payment(uuid, text, text, timestamptz, int, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.confirm_slip_payment(uuid, text, text, timestamptz, int, text, text, jsonb) to service_role;

-- ===========================================================================
-- 4. approve_manual_review_payment — replaces the version from
--    0012_booking_confirmed_notification.sql. Same signature. Only change:
--    'slip_storage_path' (from payment_slip_images, keyed by the order being
--    approved) instead of 'image_storage_path' (from booking_images).
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
  v_slip_path text;
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

  -- Single canonical successful-confirmation notification: booking_confirmed
  -- only. Slip evidence is whatever was retained from the original upload
  -- attempt that put this order into manual_review.
  select psi.storage_path into v_slip_path
    from public.payment_slip_images psi
   where psi.payment_order_id = v_order.id
   order by psi.created_at desc
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
      'expected_amount_satang', v_order.amount_satang,
      'received_amount_satang', v_transaction.amount_satang,
      'updated_at', now(),
      'slip_storage_path', v_slip_path
    )
  )
  on conflict (idempotency_key) do nothing;

  return jsonb_build_object('result','ok','booking_id',p_booking_id);
end;
$$;
revoke all on function public.approve_manual_review_payment(uuid) from public, anon, authenticated;
grant execute on function public.approve_manual_review_payment(uuid) to service_role;

-- ===========================================================================
-- 5. transition_slot_booking — replaces the version from
--    0012_booking_confirmed_notification.sql. Same signature. The admin
--    non-payment override path has no verified payment and must never
--    attach any image (face or slip) or imply payment was received — the
--    face-image lookup/field is removed entirely, no replacement field is
--    added.
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

    -- Enqueue the team LINE booking-summary notification. No image field at
    -- all: this path has no verified payment, so there is neither a slip
    -- (nothing was ever submitted for verification) nor a repeat of the
    -- face photo (already sent once with the initial booking notification).
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

commit;

-- ROLLBACK (non-destructive):
--   Re-run 0012_booking_confirmed_notification.sql's CREATE OR REPLACE
--   statements for transition_slot_booking, confirm_slip_payment, and
--   approve_manual_review_payment to restore their pre-0013 bodies (face
--   image / no distinct slip field). Do NOT drop the payment-slips bucket
--   or the payment_slip_images table — both are additive and harmless to
--   leave in place; any rows/objects already written are payment evidence
--   and should be retained regardless of whether this migration is rolled
--   back at the application layer.
