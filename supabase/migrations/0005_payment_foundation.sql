-- Phase 5: payment foundation (additive, no data loss).
-- Run AFTER 0004_face_upload_cleanup_lease.sql in the Supabase SQL editor.
-- Do NOT apply to production until a real provider adapter is ready.
--
-- Security model: same as prior migrations.
-- All functions run with invoker rights (no definer-rights escalation).
-- EXECUTE is revoked from public/anon/authenticated and granted only to
-- service_role. All new tables have RLS enabled (deny-by-default).

-- ===========================================================================
-- 1. Extend booking status: add 'booked' (payment received, awaiting admin)
-- ===========================================================================
-- 'booked' = slot is secured because payment was received. Admin must still
-- review/confirm (transition to 'confirmed') before the consultation.
-- 'confirmed' continues to mean admin-confirmed, not "money received".
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in (
    'pending', 'contacted',
    'pending_payment', 'booked', 'confirmed', 'cancelled', 'expired', 'completed'
  ));

-- ===========================================================================
-- 2. payment_orders: one payment attempt per booking, provider-neutral
-- ===========================================================================
create table if not exists public.payment_orders (
  id                     uuid        primary key default gen_random_uuid(),
  booking_id             uuid        not null references public.bookings (id),
  provider               text        not null,
  provider_order_id      text,                  -- set by the provider adapter later
  -- Non-guessable public token for /pay/[token] page. Never exposed in booking URLs.
  checkout_token         text        not null unique default gen_random_uuid()::text,
  idempotency_key        text        not null unique,
  amount_satang          int         not null check (amount_satang > 0),
  currency               text        not null default 'THB',
  status                 text        not null default 'created'
                           check (status in (
                             'created', 'pending', 'paid',
                             'expired', 'failed', 'refunded', 'manual_review'
                           )),
  expires_at             timestamptz not null,
  paid_at                timestamptz,
  amount_received_satang int,
  provider_paid_at       timestamptz,
  provider_payload       jsonb,
  failure_code           text,
  failure_message        text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- At most one active (created/pending) order per booking at a time.
-- Prevents double-charging: a second active order is rejected by create_payment_order.
create unique index if not exists payment_orders_booking_active_uniq
  on public.payment_orders (booking_id)
  where status in ('created', 'pending');

-- provider_order_id is globally unique per provider once the provider sets it.
create unique index if not exists payment_orders_provider_order_uniq
  on public.payment_orders (provider, provider_order_id)
  where provider_order_id is not null;

create index if not exists payment_orders_booking_idx
  on public.payment_orders (booking_id);

create index if not exists payment_orders_expires_idx
  on public.payment_orders (expires_at)
  where status in ('created', 'pending');

alter table public.payment_orders enable row level security;
revoke all on table public.payment_orders from anon, authenticated;
grant all on table public.payment_orders to service_role;

-- ===========================================================================
-- 3. payment_webhook_events: immutable inbox for future provider callbacks
-- ===========================================================================
create table if not exists public.payment_webhook_events (
  id                 uuid        primary key default gen_random_uuid(),
  provider           text        not null,
  provider_event_id  text        not null,
  payment_order_id   uuid        references public.payment_orders (id),
  event_type         text        not null,
  payload            jsonb       not null default '{}'::jsonb,
  -- signature_verified is always false until a real provider adapter verifies it.
  signature_verified boolean     not null default false,
  processing_status  text        not null default 'pending'
                       check (processing_status in (
                         'pending', 'processed', 'failed', 'skipped'
                       )),
  processed_at       timestamptz,
  processing_error   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Idempotency guard: duplicate (provider, provider_event_id) pairs are safe no-ops.
create unique index if not exists payment_webhook_events_provider_event_uniq
  on public.payment_webhook_events (provider, provider_event_id);

create index if not exists payment_webhook_events_order_idx
  on public.payment_webhook_events (payment_order_id)
  where payment_order_id is not null;

alter table public.payment_webhook_events enable row level security;
revoke all on table public.payment_webhook_events from anon, authenticated;
grant all on table public.payment_webhook_events to service_role;

-- ===========================================================================
-- 4. notification_deliveries: outbox for future LINE / Facebook retries
-- ===========================================================================
-- Entries are created atomically during payment confirmation but NOT sent here.
-- A future delivery worker reads pending rows and sends them with retry logic.
-- A failed notification can never roll back a confirmed payment.
create table if not exists public.notification_deliveries (
  id                uuid        primary key default gen_random_uuid(),
  booking_id        uuid        not null references public.bookings (id),
  payment_order_id  uuid        references public.payment_orders (id),
  channel           text        not null
                      check (channel in ('line', 'facebook', 'sms', 'email')),
  recipient_type    text        not null
                      check (recipient_type in ('customer', 'team')),
  recipient_id      text,         -- resolved by the delivery worker; null until then
  event_type        text        not null,
  idempotency_key   text        not null unique,
  payload           jsonb,
  status            text        not null default 'pending'
                      check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempt_count     int         not null default 0,
  last_error        text,
  next_retry_at     timestamptz,
  sent_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists notification_deliveries_booking_idx
  on public.notification_deliveries (booking_id);

create index if not exists notification_deliveries_retry_idx
  on public.notification_deliveries (status, next_retry_at)
  where status in ('pending', 'failed');

alter table public.notification_deliveries enable row level security;
revoke all on table public.notification_deliveries from anon, authenticated;
grant all on table public.notification_deliveries to service_role;

-- ===========================================================================
-- 5. Update create_booking: count 'booked' as occupying a seat
--    Replaces the 9-param version from 0003_face_upload.sql.
-- ===========================================================================
create or replace function public.create_booking(
  p_slot_id            uuid,
  p_source             text,
  p_nickname           text,
  p_phone              text,
  p_consultation_topic text,
  p_birth_date_text    text,
  p_hold_minutes       int  default 10,
  p_idempotency_key    text default null,
  p_face_upload_token  uuid default null
)
returns public.bookings
language plpgsql
as $$
declare
  v_slot     public.booking_slots;
  v_occupied int;
  v_queue    int;
  v_booking  public.bookings;
  v_phone    text;
  v_upload   public.booking_face_uploads;
begin
  v_phone := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');

  if p_source not in ('line', 'website', 'facebook', 'instagram') then
    raise exception 'invalid_source';
  end if;
  if coalesce(btrim(p_nickname), '') = ''
     or coalesce(btrim(p_consultation_topic), '') = ''
     or coalesce(btrim(p_birth_date_text), '') = ''
     or length(v_phone) < 9 or length(v_phone) > 15 then
    raise exception 'invalid_input';
  end if;

  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select * into v_booking from public.bookings
     where idempotency_key = p_idempotency_key;
    if found then return v_booking; end if;
  end if;

  select * into v_slot from public.booking_slots where id = p_slot_id for update;
  if not found then raise exception 'slot_not_found'; end if;
  if not v_slot.is_open then raise exception 'slot_closed'; end if;
  if v_slot.booking_date < (now() at time zone 'Asia/Bangkok')::date
     or (
       v_slot.booking_date = (now() at time zone 'Asia/Bangkok')::date
       and v_slot.start_time <= (now() at time zone 'Asia/Bangkok')::time
     ) then
    raise exception 'slot_closed';
  end if;

  -- Free lapsed holds before counting capacity.
  update public.bookings
     set status = 'expired', updated_at = now()
   where slot_id = p_slot_id
     and status = 'pending_payment'
     and hold_expires_at is not null
     and hold_expires_at <= now();

  -- Duplicate guard: at most one active booking per (slot, phone).
  -- Active = booked/confirmed/completed, or a pending_payment with a live hold.
  perform 1 from public.bookings
   where slot_id = p_slot_id
     and regexp_replace(coalesce(phone, ''), '\D', '', 'g') = v_phone
     and (status in ('booked', 'confirmed', 'completed')
          or (status = 'pending_payment' and hold_expires_at > now()));
  if found then raise exception 'duplicate_booking'; end if;

  select count(*) into v_occupied
    from public.bookings
   where slot_id = p_slot_id
     and (status in ('booked', 'confirmed', 'completed')
          or (status = 'pending_payment' and hold_expires_at > now()));
  if v_occupied >= v_slot.capacity then raise exception 'slot_full'; end if;

  select coalesce(max(queue_number), 0) + 1 into v_queue
    from public.bookings where slot_id = p_slot_id;

  begin
    insert into public.bookings (
      slot_id, source, nickname, phone, consultation_topic,
      birth_date_text, preferred_time, status, queue_number, hold_expires_at,
      idempotency_key
    ) values (
      p_slot_id, p_source, p_nickname, v_phone, p_consultation_topic,
      p_birth_date_text, v_slot.label, 'pending_payment', v_queue,
      now() + make_interval(mins => p_hold_minutes),
      nullif(p_idempotency_key, '')
    )
    returning * into v_booking;
  exception when unique_violation then
    if p_idempotency_key is not null and p_idempotency_key <> '' then
      select * into v_booking from public.bookings
       where idempotency_key = p_idempotency_key;
      if found then return v_booking; end if;
    end if;
    raise;
  end;

  if p_face_upload_token is not null then
    select * into v_upload
      from public.booking_face_uploads
     where id = p_face_upload_token
     for update;

    if not found then raise exception 'face_token_invalid'; end if;
    if v_upload.status <> 'pending' then raise exception 'face_token_invalid'; end if;
    if v_upload.expires_at <= now() then raise exception 'face_token_expired'; end if;
    if p_idempotency_key is not null
       and p_idempotency_key <> ''
       and v_upload.idempotency_key <> p_idempotency_key then
      raise exception 'face_token_invalid';
    end if;

    update public.booking_face_uploads
       set status = 'claimed', claimed_booking_id = v_booking.id
     where id = p_face_upload_token;

    insert into public.booking_images (booking_id, storage_path)
    values (v_booking.id, v_upload.storage_path);
  end if;

  return v_booking;
end;
$$;

revoke all on function public.create_booking(uuid, text, text, text, text, text, int, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_booking(uuid, text, text, text, text, text, int, text, uuid)
  to service_role;

-- ===========================================================================
-- 6. Update transition_slot_booking: add 'booked' transitions
--    Replaces the version from 0002_booking_slots.sql.
-- ===========================================================================
-- Valid admin transitions with 'booked' added:
--   pending_payment -> confirmed | cancelled | expired  (preserved for manual flow)
--   booked          -> confirmed | cancelled            (new: admin reviews paid booking)
--   confirmed       -> completed | cancelled            (preserved)
-- pending_payment -> booked is NOT an admin action; it is done only by
-- process_payment_paid_event when a real provider webhook confirms payment.
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
    -- booked always occupies a seat (payment received).
    -- A live pending_payment hold already occupies a seat.
    -- A lapsed pending_payment hold does not; must find room.
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

-- ===========================================================================
-- 7. Update get_open_slots: count 'booked' as occupying a seat
--    Replaces the version from 0002_booking_slots.sql.
-- ===========================================================================
create or replace function public.get_open_slots(p_date date)
returns table (
  id uuid, booking_date date, start_time time, end_time time,
  label text, capacity int, occupied int, remaining int
)
language plpgsql
as $$
begin
  perform public.expire_pending_bookings();

  return query
  select s.id, s.booking_date, s.start_time, s.end_time, s.label, s.capacity,
         coalesce(o.cnt, 0)::int as occupied,
         greatest(s.capacity - coalesce(o.cnt, 0), 0)::int as remaining
    from public.booking_slots s
    left join lateral (
      select count(*) cnt
        from public.bookings b
       where b.slot_id = s.id
         and (b.status in ('booked', 'confirmed', 'completed')
              or (b.status = 'pending_payment' and b.hold_expires_at > now()))
    ) o on true
   where s.booking_date = p_date
     and s.is_open
     and (
       s.booking_date > (now() at time zone 'Asia/Bangkok')::date
       or (
         s.booking_date = (now() at time zone 'Asia/Bangkok')::date
         and s.start_time > (now() at time zone 'Asia/Bangkok')::time
       )
     )
   order by s.start_time;
end;
$$;

revoke all on function public.get_open_slots(date) from public, anon, authenticated;
grant execute on function public.get_open_slots(date) to service_role;

-- ===========================================================================
-- 8. create_payment_order: atomic, idempotent payment order creation
-- ===========================================================================
-- Only eligible bookings (pending_payment + live hold) may create an order.
-- Returns the existing order for a repeated idempotency_key call.
-- Raises 'active_order_exists' if another active order already exists.
create or replace function public.create_payment_order(
  p_booking_id      uuid,
  p_idempotency_key text,
  p_provider        text,
  p_amount_satang   int,
  p_currency        text        default 'THB',
  p_expires_at      timestamptz default null
)
returns public.payment_orders
language plpgsql
as $$
declare
  v_booking public.bookings;
  v_order   public.payment_orders;
  v_expires timestamptz;
begin
  -- Idempotency short-circuit: same key returns the original order.
  select * into v_order from public.payment_orders
   where idempotency_key = p_idempotency_key;
  if found then return v_order; end if;

  -- Lock the booking row to serialize concurrent order creation.
  select * into v_booking from public.bookings
   where id = p_booking_id for update;
  if not found then raise exception 'booking_not_found'; end if;

  if v_booking.status <> 'pending_payment' then
    raise exception 'booking_not_pending_payment';
  end if;
  if v_booking.hold_expires_at is null or v_booking.hold_expires_at <= now() then
    raise exception 'booking_hold_expired';
  end if;

  -- Reject a second active order for the same booking.
  perform 1 from public.payment_orders
   where booking_id = p_booking_id
     and status in ('created', 'pending');
  if found then raise exception 'active_order_exists'; end if;

  v_expires := coalesce(p_expires_at, v_booking.hold_expires_at);

  begin
    insert into public.payment_orders (
      booking_id, provider, idempotency_key,
      amount_satang, currency, status, expires_at
    ) values (
      p_booking_id, p_provider, p_idempotency_key,
      p_amount_satang, p_currency, 'created', v_expires
    )
    returning * into v_order;
  exception when unique_violation then
    -- Idempotency race: another request with the same key won the insert.
    select * into v_order from public.payment_orders
     where idempotency_key = p_idempotency_key;
    if found then return v_order; end if;
    raise;
  end;

  return v_order;
end;
$$;

revoke all on function public.create_payment_order(uuid, text, text, int, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_payment_order(uuid, text, text, int, text, timestamptz)
  to service_role;

-- ===========================================================================
-- 9. process_payment_paid_event: atomic paid-event processing
-- ===========================================================================
-- Inserts a webhook event idempotently, then either:
--   • returns 'already_processed' for a duplicate event
--   • sets 'manual_review' on amount mismatch or expired/cancelled booking
--   • marks the order paid and transitions booking pending_payment -> booked
--     and inserts notification outbox entries (not sent here)
create or replace function public.process_payment_paid_event(
  p_provider               text,
  p_provider_event_id      text,
  p_payment_order_id       uuid,
  p_event_type             text,
  p_payload                jsonb,
  p_amount_received_satang int,
  p_provider_paid_at       timestamptz default null
)
returns jsonb
language plpgsql
as $$
declare
  v_event   public.payment_webhook_events;
  v_order   public.payment_orders;
  v_booking public.bookings;
begin
  -- Insert webhook event idempotently.
  -- ON CONFLICT bumps updated_at so RETURNING gives us the current row state.
  insert into public.payment_webhook_events (
    provider, provider_event_id, payment_order_id, event_type, payload
  ) values (
    p_provider, p_provider_event_id,
    p_payment_order_id,
    p_event_type, coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (provider, provider_event_id) do update
    set updated_at = now()
  returning * into v_event;

  -- Duplicate: event was already fully processed.
  if v_event.processing_status = 'processed' then
    return jsonb_build_object('result', 'already_processed');
  end if;

  -- Lock payment order.
  select * into v_order from public.payment_orders
   where id = p_payment_order_id for update;
  if not found then
    update public.payment_webhook_events
       set processing_status = 'failed',
           processing_error  = 'payment_order_not_found',
           processed_at      = now(),
           updated_at        = now()
     where id = v_event.id;
    raise exception 'payment_order_not_found';
  end if;

  -- Order already paid: idempotent success.
  if v_order.status = 'paid' then
    update public.payment_webhook_events
       set processing_status = 'processed', processed_at = now(), updated_at = now()
     where id = v_event.id;
    return jsonb_build_object('result', 'already_paid');
  end if;

  -- Order not in a processable state (expired/failed/refunded/manual_review).
  if v_order.status not in ('created', 'pending') then
    update public.payment_webhook_events
       set processing_status = 'skipped',
           processing_error  = 'order_status:' || v_order.status,
           processed_at      = now(),
           updated_at        = now()
     where id = v_event.id;
    return jsonb_build_object('result', 'skipped', 'reason', 'order_' || v_order.status);
  end if;

  -- Lock the booking row.
  select * into v_booking from public.bookings
   where id = v_order.booking_id for update;

  -- Amount mismatch: preserve event, flag for manual review. Do not book.
  if p_amount_received_satang <> v_order.amount_satang then
    update public.payment_orders
       set status                = 'manual_review',
           amount_received_satang = p_amount_received_satang,
           provider_paid_at      = p_provider_paid_at,
           provider_payload      = p_payload,
           updated_at            = now()
     where id = p_payment_order_id;
    update public.payment_webhook_events
       set processing_status = 'processed', processed_at = now(), updated_at = now()
     where id = v_event.id;
    return jsonb_build_object('result', 'manual_review', 'reason', 'amount_mismatch');
  end if;

  -- Payment arrived after booking was expired or cancelled.
  -- Do not automatically revive the booking. Requires manual team action.
  if v_booking.status in ('expired', 'cancelled') then
    update public.payment_orders
       set status                = 'manual_review',
           amount_received_satang = p_amount_received_satang,
           provider_paid_at      = p_provider_paid_at,
           provider_payload      = p_payload,
           updated_at            = now()
     where id = p_payment_order_id;
    update public.payment_webhook_events
       set processing_status = 'processed', processed_at = now(), updated_at = now()
     where id = v_event.id;
    return jsonb_build_object(
      'result', 'manual_review',
      'reason', 'booking_' || v_booking.status
    );
  end if;

  -- Valid payment: mark paid and transition booking pending_payment -> booked.
  update public.payment_orders
     set status                 = 'paid',
         paid_at                = now(),
         amount_received_satang = p_amount_received_satang,
         provider_paid_at       = coalesce(p_provider_paid_at, now()),
         provider_payload       = p_payload,
         updated_at             = now()
   where id = p_payment_order_id;

  -- Guard: the booking must still be pending_payment (guards against concurrent
  -- expire_pending_bookings). If it is not, the payment still records as 'paid'
  -- but the booking is left in its current state for manual review.
  update public.bookings
     set status          = 'booked',
         hold_expires_at = null,
         updated_at      = now()
   where id = v_order.booking_id
     and status = 'pending_payment';

  update public.payment_webhook_events
     set processing_status = 'processed', processed_at = now(), updated_at = now()
   where id = v_event.id;

  -- Outbox: notification intents only. Not sent here. Delivery worker reads these.
  -- ON CONFLICT DO NOTHING makes this idempotent if called again after a crash.
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

revoke all on function public.process_payment_paid_event(text, text, uuid, text, jsonb, int, timestamptz)
  from public, anon, authenticated;
grant execute on function public.process_payment_paid_event(text, text, uuid, text, jsonb, int, timestamptz)
  to service_role;

-- ===========================================================================
-- 10. expire_due_payment_orders: expire stale orders and their held bookings
-- ===========================================================================
-- FOR UPDATE SKIP LOCKED prevents concurrent cron runs from touching the same row.
-- The booking is expired only if it is still pending_payment — a booked/confirmed
-- booking is never expired by this function regardless of order expiry timing.
create or replace function public.expire_due_payment_orders(
  p_batch_size int default 50
)
returns int
language plpgsql
as $$
declare
  v_count int := 0;
  v_row   record;
begin
  for v_row in
    select id, booking_id
      from public.payment_orders
     where status in ('created', 'pending')
       and expires_at <= now()
     limit p_batch_size
       for update skip locked
  loop
    -- Recheck status after acquiring the row lock.
    -- If a payment webhook landed between the scan and the lock, status changed.
    update public.payment_orders
       set status = 'expired', updated_at = now()
     where id = v_row.id
       and status in ('created', 'pending');

    if found then
      -- Never expire a booked/confirmed booking even if its payment order expired.
      update public.bookings
         set status          = 'expired',
             hold_expires_at = null,
             updated_at      = now()
       where id = v_row.booking_id
         and status = 'pending_payment';

      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.expire_due_payment_orders(int) from public, anon, authenticated;
grant execute on function public.expire_due_payment_orders(int) to service_role;
