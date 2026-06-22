-- Phase 3: hardened face-upload intent table + updated create_booking RPC.
-- Safe to apply to a fresh Supabase instance AFTER 0001 + 0002.
-- 0003 is NOT yet applied to any environment.

-- 1. Allow booking_images rows without a LINE session (slot/web bookings). -----
alter table public.booking_images alter column session_id drop not null;

-- 2. Upload intent table -------------------------------------------------------
-- Tracks every face-upload attempt. The server returns `id` (= uploadToken)
-- to the client — never the storage_path or a signed URL.
-- status lifecycle: pending → claimed (booking created) | cleaning → deleted (expired cleanup).
create table if not exists public.booking_face_uploads (
  id                 uuid        primary key default gen_random_uuid(),
  idempotency_key    text        not null,
  storage_path       text        not null unique,
  mime_type          text        not null
                       check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes         int         not null check (size_bytes > 0 and size_bytes <= 5242880),
  status             text        not null default 'pending'
                       check (status in ('pending', 'claimed', 'cleaning', 'deleted')),
  expires_at         timestamptz not null default (now() + interval '2 hours'),
  claimed_booking_id uuid        references public.bookings (id),
  ip_hash            text,       -- HMAC of client IP; never raw IP
  created_at         timestamptz not null default now()
);

-- Only one active pending upload per idempotency key (idempotent re-upload).
create unique index if not exists booking_face_uploads_idem_key_pending
  on public.booking_face_uploads (idempotency_key)
  where status = 'pending';

-- Efficient cron cleanup of expired rows.
create index if not exists booking_face_uploads_expires_idx
  on public.booking_face_uploads (expires_at)
  where status in ('pending', 'cleaning');

alter table public.booking_face_uploads enable row level security;
-- Deny-by-default: anon/authenticated get nothing; service_role bypasses RLS.
revoke all on table public.booking_face_uploads from anon, authenticated;
grant all on table public.booking_face_uploads to service_role;

-- 3. Updated create_booking RPC ------------------------------------------------
-- Adds p_face_upload_token (default null) to atomically claim the upload intent
-- in the same transaction as the booking insert, preventing token reuse.
-- The 8-parameter overload (from 0002) is dropped first to avoid ambiguity.
drop function if exists public.create_booking(uuid, text, text, text, text, text, int, text);

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

  -- Idempotency short-circuit: same key returns the original booking.
  -- The face upload was already claimed atomically in that transaction.
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select * into v_booking from public.bookings
     where idempotency_key = p_idempotency_key;
    if found then
      return v_booking;
    end if;
  end if;

  -- Serialize concurrent bookings for this slot.
  select * into v_slot from public.booking_slots where id = p_slot_id for update;
  if not found then raise exception 'slot_not_found'; end if;
  if not v_slot.is_open then raise exception 'slot_closed'; end if;
  -- Do not allow new bookings after the round has started in Thailand time.
  if v_slot.booking_date < (now() at time zone 'Asia/Bangkok')::date
     or (
       v_slot.booking_date = (now() at time zone 'Asia/Bangkok')::date
       and v_slot.start_time <= (now() at time zone 'Asia/Bangkok')::time
     ) then
    raise exception 'slot_closed';
  end if;

  -- Expire lapsed holds for this slot before counting capacity.
  update public.bookings
     set status = 'expired', updated_at = now()
   where slot_id = p_slot_id
     and status = 'pending_payment'
     and hold_expires_at is not null
     and hold_expires_at <= now();

  -- Duplicate guard: at most one active booking per (slot, phone).
  perform 1 from public.bookings
   where slot_id = p_slot_id
     and regexp_replace(coalesce(phone, ''), '\D', '', 'g') = v_phone
     and (status in ('confirmed', 'completed')
          or (status = 'pending_payment' and hold_expires_at > now()));
  if found then raise exception 'duplicate_booking'; end if;

  select count(*) into v_occupied
    from public.bookings
   where slot_id = p_slot_id
     and (status in ('confirmed', 'completed')
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
    -- Idempotency race: another request with the same key won the insert.
    if p_idempotency_key is not null and p_idempotency_key <> '' then
      select * into v_booking from public.bookings
       where idempotency_key = p_idempotency_key;
      if found then return v_booking; end if;
    end if;
    raise;
  end;

  -- Atomically claim the face upload intent (if provided).
  -- FOR UPDATE serializes against the cron's 'cleaning' status transition,
  -- guaranteeing the object is not deleted while we are linking it.
  if p_face_upload_token is not null then
    select * into v_upload
      from public.booking_face_uploads
     where id = p_face_upload_token
     for update;

    if not found then
      raise exception 'face_token_invalid';
    end if;
    -- status = 'cleaning' / 'claimed' / 'deleted' all map to invalid.
    if v_upload.status <> 'pending' then
      raise exception 'face_token_invalid';
    end if;
    if v_upload.expires_at <= now() then
      raise exception 'face_token_expired';
    end if;
    -- Binding check: upload must have been created for this exact booking attempt.
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

-- Grant only to service_role; anon/authenticated cannot call this directly.
revoke all on function public.create_booking(uuid, text, text, text, text, text, int, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_booking(uuid, text, text, text, text, text, int, text, uuid)
  to service_role;
