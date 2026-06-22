-- Phase 2: central slot-based booking core (additive — no data loss).
-- Run AFTER 0001_init.sql in the Supabase SQL editor.
--
-- Security model: all functions below run with invoker rights (the Postgres
-- default; no definer-rights escalation). They are executed only by the server-side
-- service_role client; EXECUTE is revoked from PUBLIC/anon/authenticated and
-- granted to service_role explicitly at the end of this file. Tables have RLS
-- enabled with no policies (deny-by-default) plus explicit table-grant revokes.

-- 1. Time-window slots -------------------------------------------------------
create table if not exists public.booking_slots (
  id           uuid primary key default gen_random_uuid(),
  booking_date date not null,
  start_time   time not null,
  end_time     time not null,
  label        text not null,
  capacity     int  not null default 3 check (capacity >= 0),
  is_open      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (booking_date, start_time, end_time)
);

create index if not exists booking_slots_date_idx on public.booking_slots (booking_date);

alter table public.booking_slots enable row level security;

-- 2. Extend bookings (additive) ---------------------------------------------
alter table public.bookings add column if not exists slot_id uuid references public.booking_slots (id);
alter table public.bookings add column if not exists source text;
alter table public.bookings add column if not exists queue_number int;
alter table public.bookings add column if not exists hold_expires_at timestamptz;
-- Idempotency key for POST /api/bookings (client-generated UUID per submit).
alter table public.bookings add column if not exists idempotency_key text;

-- Non-LINE bookings have no LINE user id.
alter table public.bookings alter column line_user_id drop not null;

-- Channel allowlist (null allowed for legacy rows).
alter table public.bookings drop constraint if exists bookings_source_check;
alter table public.bookings add constraint bookings_source_check
  check (source is null or source in ('line', 'website', 'facebook', 'instagram'));

-- Expanded lifecycle. Legacy values (pending/contacted) preserved.
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in (
    'pending', 'contacted',
    'pending_payment', 'confirmed', 'cancelled', 'expired', 'completed'
  ));

create index if not exists bookings_slot_idx on public.bookings (slot_id);
create index if not exists bookings_hold_idx on public.bookings (hold_expires_at)
  where status = 'pending_payment';

-- One queue number per slot (backstop for the function's max+1 assignment).
create unique index if not exists bookings_slot_queue_uniq
  on public.bookings (slot_id, queue_number)
  where slot_id is not null and queue_number is not null;

-- Idempotency: a key maps to exactly one booking (retries return that booking).
create unique index if not exists bookings_idempotency_key_uniq
  on public.bookings (idempotency_key)
  where idempotency_key is not null;

-- 3. DB-backed rate limiting (cross-instance) -------------------------------
create table if not exists public.api_rate_limits (
  id         bigint generated always as identity primary key,
  bucket     text not null,
  created_at timestamptz not null default now()
);
create index if not exists api_rate_limits_bucket_idx
  on public.api_rate_limits (bucket, created_at);
alter table public.api_rate_limits enable row level security;

-- Records one hit and returns the number of hits for the bucket in the window.
create or replace function public.record_rate_hit(p_bucket text, p_window_seconds int)
returns int
language plpgsql
as $$
declare
  v_count int;
begin
  delete from public.api_rate_limits
   where bucket = p_bucket
     and created_at < now() - make_interval(secs => p_window_seconds);
  insert into public.api_rate_limits (bucket) values (p_bucket);
  select count(*) into v_count
    from public.api_rate_limits
   where bucket = p_bucket
     and created_at > now() - make_interval(secs => p_window_seconds);
  return v_count;
end;
$$;

-- 4. Expire stale holds ------------------------------------------------------
-- A pending_payment booking past its hold no longer occupies capacity.
create or replace function public.expire_pending_bookings()
returns int
language plpgsql
as $$
declare
  v_count int;
begin
  update public.bookings
     set status = 'expired', updated_at = now()
   where status = 'pending_payment'
     and hold_expires_at is not null
     and hold_expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 5. Atomic, overbooking-safe creation --------------------------------------
-- Locks the slot row so concurrent callers serialize; enforces idempotency,
-- a per-(slot, phone) duplicate guard, and capacity — all inside one
-- transaction so none can be bypassed by the API layer.
create or replace function public.create_booking(
  p_slot_id uuid,
  p_source text,
  p_nickname text,
  p_phone text,
  p_consultation_topic text,
  p_birth_date_text text,
  p_hold_minutes int default 60,
  p_idempotency_key text default null
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
begin
  -- Normalize phone to digits only (server/DB-side, authoritative).
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
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select * into v_booking from public.bookings
     where idempotency_key = p_idempotency_key;
    if found then
      return v_booking;
    end if;
  end if;

  -- Serialize concurrent bookings for this slot.
  select * into v_slot from public.booking_slots where id = p_slot_id for update;
  if not found then
    raise exception 'slot_not_found';
  end if;
  if not v_slot.is_open then
    raise exception 'slot_closed';
  end if;

  -- Free seats whose hold lapsed, for this slot, before counting.
  update public.bookings
     set status = 'expired', updated_at = now()
   where slot_id = p_slot_id
     and status = 'pending_payment'
     and hold_expires_at is not null
     and hold_expires_at <= now();

  -- Duplicate guard: at most one ACTIVE booking per (slot, phone).
  -- Active = confirmed/completed or a pending_payment with a live hold.
  perform 1 from public.bookings
   where slot_id = p_slot_id
     and regexp_replace(coalesce(phone, ''), '\D', '', 'g') = v_phone
     and (status in ('confirmed', 'completed')
          or (status = 'pending_payment' and hold_expires_at > now()));
  if found then
    raise exception 'duplicate_booking';
  end if;

  select count(*) into v_occupied
    from public.bookings
   where slot_id = p_slot_id
     and (status in ('confirmed', 'completed')
          or (status = 'pending_payment' and hold_expires_at > now()));

  if v_occupied >= v_slot.capacity then
    raise exception 'slot_full';
  end if;

  -- Monotonic per-slot queue number (never reused).
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
    -- Idempotency race: another request with the same key won. Return it.
    if p_idempotency_key is not null and p_idempotency_key <> '' then
      select * into v_booking from public.bookings
       where idempotency_key = p_idempotency_key;
      if found then
        return v_booking;
      end if;
    end if;
    raise;
  end;

  return v_booking;
end;
$$;

-- 6. State transitions (admin) ----------------------------------------------
-- The ONLY way an admin may change a slot booking's status. Locks the booking
-- and slot, validates the transition, and applies capacity rules:
--   pending_payment -> confirmed | cancelled | expired
--   confirmed       -> completed | cancelled
--   completed/cancelled/expired are terminal
-- A pending_payment with a live hold already occupies its seat, so confirming
-- it needs no extra capacity (works even when the slot is exactly full).
create or replace function public.transition_slot_booking(
  p_booking_id uuid,
  p_to text
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
  if not found then
    raise exception 'booking_not_found';
  end if;
  if v_booking.slot_id is null then
    raise exception 'not_slot_booking';
  end if;

  v_from := v_booking.status;

  -- Idempotent no-op (e.g. confirm an already-confirmed booking).
  if p_to = v_from then
    return v_booking;
  end if;

  if not (
       (v_from = 'pending_payment' and p_to in ('confirmed', 'cancelled', 'expired'))
    or (v_from = 'confirmed' and p_to in ('completed', 'cancelled'))
  ) then
    raise exception 'invalid_transition';
  end if;

  -- Lock the slot to serialize against concurrent creates/transitions.
  select * into v_slot from public.booking_slots where id = v_booking.slot_id for update;

  if p_to = 'confirmed' then
    v_self_occupies := (
      v_booking.status = 'pending_payment'
      and v_booking.hold_expires_at is not null
      and v_booking.hold_expires_at > now()
    );
    if not v_self_occupies then
      select count(*) into v_others
        from public.bookings
       where slot_id = v_booking.slot_id
         and id <> p_booking_id
         and (status in ('confirmed', 'completed')
              or (status = 'pending_payment' and hold_expires_at > now()));
      if v_others >= v_slot.capacity then
        raise exception 'slot_full';
      end if;
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
    -- confirmed -> completed keeps occupying capacity (no recount needed).
    update public.bookings
       set status = 'completed', updated_at = now()
     where id = p_booking_id returning * into v_booking;
  end if;

  return v_booking;
end;
$$;

-- 7. Open slots with live availability (public) -----------------------------
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
         and (b.status in ('confirmed', 'completed')
              or (b.status = 'pending_payment' and b.hold_expires_at > now()))
    ) o on true
   where s.booking_date = p_date and s.is_open
   order by s.start_time;
end;
$$;

-- 8. Grants — server (service_role) only ------------------------------------
-- Revoke EXECUTE from everyone, then grant only to the role the server-side
-- service client connects as. The browser/anon/authenticated cannot call these
-- RPCs directly; public traffic must go through the Next API routes.
revoke all on function public.record_rate_hit(text, int)            from public, anon, authenticated;
revoke all on function public.expire_pending_bookings()             from public, anon, authenticated;
revoke all on function public.create_booking(uuid, text, text, text, text, text, int, text)
                                                                    from public, anon, authenticated;
revoke all on function public.transition_slot_booking(uuid, text)   from public, anon, authenticated;
revoke all on function public.get_open_slots(date)                  from public, anon, authenticated;

grant execute on function public.record_rate_hit(text, int)            to service_role;
grant execute on function public.expire_pending_bookings()             to service_role;
grant execute on function public.create_booking(uuid, text, text, text, text, text, int, text)
                                                                       to service_role;
grant execute on function public.transition_slot_booking(uuid, text)   to service_role;
grant execute on function public.get_open_slots(date)                  to service_role;

-- Defense in depth: no direct table DML for anon/authenticated. RLS (enabled,
-- no policies) already denies them; these revokes remove table grants too.
revoke all on table public.bookings        from anon, authenticated;
revoke all on table public.booking_slots   from anon, authenticated;
revoke all on table public.api_rate_limits from anon, authenticated;
