begin;

create table if not exists public.line_user_segments (
  id uuid primary key default gen_random_uuid(),
  line_user_id text not null,
  campaign text not null check (campaign = 'september_waiting'),
  segment text not null check (segment in ('WAIT_ANSWER', 'WAIT_MULTIPLE', 'WAIT_STALLED')),
  created_at timestamptz not null default now(),
  constraint line_user_segments_identity_unique unique (line_user_id, campaign, segment)
);

alter table public.line_user_segments enable row level security;
revoke all on table public.line_user_segments from anon, authenticated;
grant all on table public.line_user_segments to service_role;

commit;
