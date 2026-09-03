begin;

create table if not exists public.line_campaign_runs (
  id uuid primary key default gen_random_uuid(),
  campaign text not null,
  mode text not null check (mode in ('uat', 'live')),
  message_text text not null,
  quick_reply_enabled boolean not null default true,
  status text not null check (status in ('success', 'failed')),
  target_count integer check (target_count is null or target_count >= 0),
  line_status integer,
  created_by text,
  created_at timestamptz not null default now()
);

alter table public.line_campaign_runs enable row level security;
revoke all on table public.line_campaign_runs from anon, authenticated;
grant all on table public.line_campaign_runs to service_role;

commit;
