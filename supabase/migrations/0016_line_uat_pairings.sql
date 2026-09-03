begin;

create table if not exists public.line_uat_pairings (
  id uuid primary key default gen_random_uuid(),
  code_hash text unique not null,
  expires_at timestamptz not null,
  line_user_id text,
  paired_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  constraint line_uat_pairings_code_hash_format check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint line_uat_pairings_expiry_order check (expires_at > created_at),
  constraint line_uat_pairings_user_id_format check (line_user_id is null or line_user_id ~ '^U[0-9A-Fa-f]{32}$'),
  constraint line_uat_pairings_pair_state check (
    (line_user_id is null and paired_at is null)
    or (line_user_id is not null and paired_at is not null)
  )
);

alter table public.line_uat_pairings enable row level security;
revoke all on table public.line_uat_pairings from public, anon, authenticated;
grant all on table public.line_uat_pairings to service_role;

commit;
