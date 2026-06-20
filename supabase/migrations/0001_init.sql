-- Phase 1 schema for backoffice-mohjaew.
-- Run in the Supabase SQL editor (or supabase db push).

create extension if not exists pgcrypto;

-- One active booking flow per LINE user; carries fields collected across replies.
create table if not exists public.booking_sessions (
  id                uuid primary key default gen_random_uuid(),
  line_user_id      text not null,
  line_display_name text,
  status            text not null default 'active'
                      check (status in ('active', 'completed', 'expired')),
  collected         jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz
);

-- Enforce at most one active session per user (idempotency for the webhook).
create unique index if not exists booking_sessions_one_active
  on public.booking_sessions (line_user_id)
  where status = 'active';

-- Completed bookings shown in the admin dashboard.
create table if not exists public.bookings (
  id                 uuid primary key default gen_random_uuid(),
  -- One booking per session: guards against duplicate webhook deliveries
  -- racing to complete the same session concurrently.
  session_id         uuid unique references public.booking_sessions (id),
  line_user_id       text not null,
  line_display_name  text,
  nickname           text not null,
  birth_date_text    text not null,
  consultation_topic text not null,
  phone              text not null,
  preferred_time     text not null,
  status             text not null default 'pending'
                       check (status in ('pending', 'contacted', 'confirmed', 'cancelled')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists bookings_status_idx on public.bookings (status);
create index if not exists bookings_created_idx on public.bookings (created_at desc);

-- Face images live in private Storage; this table tracks their paths.
create table if not exists public.booking_images (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.booking_sessions (id),
  booking_id   uuid references public.bookings (id),
  -- Unique so a retried image event can't create a duplicate row.
  storage_path text not null unique,
  created_at   timestamptz not null default now()
);

create index if not exists booking_images_session_idx on public.booking_images (session_id);
create index if not exists booking_images_booking_idx on public.booking_images (booking_id);

-- Webhook idempotency: id = LINE webhookEventId.
create table if not exists public.line_webhook_events (
  id         text primary key,
  created_at timestamptz not null default now()
);

-- Lock everything down. The app reaches these tables only via the service-role
-- key on the server; no anon/authenticated policies are defined, so RLS denies
-- all direct client access by default.
alter table public.booking_sessions    enable row level security;
alter table public.bookings            enable row level security;
alter table public.booking_images      enable row level security;
alter table public.line_webhook_events enable row level security;

-- Private storage bucket for face images.
insert into storage.buckets (id, name, public)
values ('booking-faces', 'booking-faces', false)
on conflict (id) do nothing;
