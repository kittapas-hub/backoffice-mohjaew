begin;

alter table public.line_campaign_runs
  add column if not exists request_key uuid;

alter table public.line_campaign_runs
  drop constraint if exists line_campaign_runs_status_check;
alter table public.line_campaign_runs
  add constraint line_campaign_runs_status_check
  check (status in ('pending', 'success', 'failed', 'unknown'));

create unique index if not exists line_campaign_runs_live_request_key_uniq
  on public.line_campaign_runs (request_key)
  where mode = 'live' and request_key is not null;

alter table public.line_campaign_runs enable row level security;
revoke all on table public.line_campaign_runs from anon, authenticated;
grant all on table public.line_campaign_runs to service_role;

commit;
