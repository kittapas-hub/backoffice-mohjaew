-- Phase 4: leased cleanup for orphaned face-upload intents.
-- Safe to run after 0003_face_upload.sql.
--
-- This migration is additive and safe if some cleanup fields/functions already
-- exist in a live database. It does not delete face uploads or mutate bookings.

-- 1. Cleanup lease columns ----------------------------------------------------
alter table public.booking_face_uploads
  add column if not exists cleanup_token text;

alter table public.booking_face_uploads
  add column if not exists cleanup_lease_until timestamptz;

alter table public.booking_face_uploads
  add column if not exists cleanup_attempts int;

alter table public.booking_face_uploads
  add column if not exists cleanup_last_error text;

alter table public.booking_face_uploads
  alter column cleanup_attempts set default 0;

update public.booking_face_uploads
   set cleanup_attempts = 0
 where cleanup_attempts is null;

alter table public.booking_face_uploads
  alter column cleanup_attempts set not null;

-- Efficient lease-expiry lookups during cleanup.
create index if not exists booking_face_uploads_lease_idx
  on public.booking_face_uploads (cleanup_lease_until)
  where status = 'cleaning';

-- 2. Atomic orphan-cleanup claim RPC -----------------------------------------
-- Selects up to p_batch_size rows eligible for cleanup:
-- - pending rows whose expires_at has passed, orphaned without a booking
-- - cleaning rows whose cleanup_lease_until has expired, retrying a prior run
--
-- FOR UPDATE SKIP LOCKED prevents concurrent cron runs from claiming the same
-- row. Each claimed row receives a fresh cleanup_token and a 5-minute lease.
create or replace function public.claim_expired_face_uploads_for_cleanup(
  p_batch_size int default 25
)
returns table (id uuid, storage_path text, cleanup_token text)
language plpgsql
as $$
begin
  return query
    with candidates as (
      select u.id
        from public.booking_face_uploads u
       where (
           (u.status = 'pending' and u.expires_at < now())
           or
           (u.status = 'cleaning'
            and (u.cleanup_lease_until is null or u.cleanup_lease_until < now()))
         )
       limit p_batch_size
         for update skip locked
    )
    update public.booking_face_uploads upd
       set status              = 'cleaning',
           cleanup_token       = gen_random_uuid()::text,
           cleanup_lease_until = now() + interval '5 minutes',
           cleanup_attempts    = coalesce(upd.cleanup_attempts, 0) + 1
      from candidates
     where upd.id = candidates.id
    returning upd.id, upd.storage_path, upd.cleanup_token;
end;
$$;

revoke all on function public.claim_expired_face_uploads_for_cleanup(int)
  from public, anon, authenticated;
grant execute on function public.claim_expired_face_uploads_for_cleanup(int)
  to service_role;

-- 3. Token-verified cleanup completion RPC -----------------------------------
-- Marks a cleaning row as deleted only if the caller still owns the lease token.
-- This keeps a late cron worker from completing a row that another worker has
-- re-claimed with a newer cleanup_token.
create or replace function public.complete_face_upload_cleanup(
  p_id uuid,
  p_cleanup_token text
)
returns boolean
language plpgsql
as $$
declare
  v_rows int;
begin
  update public.booking_face_uploads
     set status             = 'deleted',
         cleanup_last_error = null
   where id            = p_id
     and cleanup_token = p_cleanup_token
     and status        = 'cleaning';

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.complete_face_upload_cleanup(uuid, text)
  from public, anon, authenticated;
grant execute on function public.complete_face_upload_cleanup(uuid, text)
  to service_role;
