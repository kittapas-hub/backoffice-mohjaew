-- Phase 1A: durable team-notification outbox worker support.
-- PROPOSED — do not apply without review. Run AFTER 0006_read_only_get_open_slots.sql.
--
-- Scope: recipient_type = 'team' rows in notification_deliveries ONLY.
-- Customer-channel LINE delivery (recipient_type = 'customer') is explicitly
-- out of scope for this migration: no booking currently has a resolvable
-- LINE user id, so there is nothing yet for a customer-delivery worker to
-- send to. Both RPCs below hardcode recipient_type = 'team' and refuse to
-- touch any other row.
--
-- Security model: both RPCs are SECURITY DEFINER with search_path pinned to
-- (public, pg_temp) so they cannot be tricked by a caller-controlled
-- search_path into resolving an object from an untrusted schema. EXECUTE is
-- revoked from public/anon/authenticated and granted only to service_role,
-- so the definer-rights escalation is only ever reachable from server-side
-- service-role code, never from anon/authenticated callers. Every table
-- reference inside both functions is schema-qualified (public.*).

-- ===========================================================================
-- 1. Status domain: add 'processing' and 'dead' (distinct from 'skipped')
-- ===========================================================================
-- 'processing' = currently leased by a worker (locked_by/locked_at set).
-- 'dead'       = retry budget exhausted (attempt_count >= 6) or an explicit
--                dead outcome. Distinct from 'skipped', which remains
--                reserved for its original meaning elsewhere in the schema.
alter table public.notification_deliveries
  drop constraint if exists notification_deliveries_status_check;
alter table public.notification_deliveries
  add constraint notification_deliveries_status_check
  check (status in ('pending', 'processing', 'sent', 'failed', 'skipped', 'dead'));

-- ===========================================================================
-- 2. Durable lease columns (additive)
-- ===========================================================================
-- locked_by = opaque worker identifier that currently owns this row.
-- locked_at = when the lease was taken; a 'processing' row whose locked_at
-- is older than the staleness window is treated as an abandoned lease
-- (e.g. worker crashed mid-send) and becomes reclaimable again.
alter table public.notification_deliveries
  add column if not exists locked_by text;

alter table public.notification_deliveries
  add column if not exists locked_at timestamptz;

-- Efficient lookup of stale in-flight leases.
create index if not exists notification_deliveries_locked_idx
  on public.notification_deliveries (locked_at)
  where status = 'processing';

-- ===========================================================================
-- 3. claim_team_notification_deliveries: atomic batch claim
-- ===========================================================================
-- Hardcodes recipient_type = 'team' — this function can never claim a
-- customer-channel row. Selects up to p_batch (clamped to 100) rows that
-- are either:
--   - pending/failed and due (next_retry_at is null or has passed), or
--   - stuck in 'processing' with a lease older than 10 minutes (abandoned
--     by a crashed/timed-out worker).
-- p_event_types is required and must be a non-empty array; there is no
-- "null means all event types" mode — callers must always be explicit
-- about which event types they are prepared to deliver.
-- FOR UPDATE SKIP LOCKED prevents two concurrent workers from claiming the
-- same row. Each claimed row is only moved into the lease itself: status ->
-- 'processing', locked_by = p_worker_id, locked_at = now(). attempt_count is
-- NOT touched here — it is owned entirely by complete_notification_delivery,
-- which increments it exactly once per completed attempt.
create or replace function public.claim_team_notification_deliveries(
  p_worker_id   text,
  p_batch       int,
  p_event_types text[]
)
returns table (
  id               uuid,
  booking_id       uuid,
  payment_order_id uuid,
  channel          text,
  event_type       text,
  payload          jsonb,
  idempotency_key  text,
  attempt_count    int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch int;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'invalid_worker_id';
  end if;

  if p_batch is null or p_batch < 1 then
    raise exception 'invalid_batch';
  end if;
  v_batch := least(p_batch, 100);

  if p_event_types is null or cardinality(p_event_types) = 0 then
    raise exception 'invalid_event_types';
  end if;

  return query
    with candidates as (
      select d.id
        from public.notification_deliveries d
       where d.recipient_type = 'team'
         and (
           (d.status in ('pending', 'failed')
            and (d.next_retry_at is null or d.next_retry_at <= now()))
           or
           (d.status = 'processing' and d.locked_at < now() - interval '10 minutes')
         )
         and d.event_type = any (p_event_types)
       order by d.created_at
       limit v_batch
         for update skip locked
    )
    update public.notification_deliveries upd
       set status     = 'processing',
           locked_by  = p_worker_id,
           locked_at  = now(),
           updated_at = now()
      from candidates
     where upd.id = candidates.id
    returning upd.id, upd.booking_id, upd.payment_order_id, upd.channel,
              upd.event_type, upd.payload, upd.idempotency_key,
              upd.attempt_count;
end;
$$;

revoke all on function public.claim_team_notification_deliveries(text, int, text[])
  from public, anon, authenticated;
grant execute on function public.claim_team_notification_deliveries(text, int, text[])
  to service_role;

-- ===========================================================================
-- 4. complete_notification_delivery: worker-fenced outcome recording
-- ===========================================================================
-- Fencing: the row must currently be status = 'processing', locked_by =
-- p_worker_id, AND recipient_type = 'team'. All three conditions gate every
-- mutation below — this is what makes it impossible for Phase 1A to touch a
-- recipient_type = 'customer' row, or for a worker to complete a row it
-- does not currently hold the lease on (e.g. after its lease went stale and
-- another worker reclaimed it).
--
-- Returns boolean: false when no row currently matches the fenced lease
-- (nothing was mutated — the caller's lease was stale, already completed
-- by someone else, or never existed), true only when the state update
-- actually applied.
--
-- p_outcome:
--   'sent'  - delivery succeeded. status -> 'sent', sent_at set,
--             next_retry_at/locked_by/locked_at cleared. attempt_count is
--             left untouched.
--   'dead'  - explicit permanent failure. status -> 'dead', next_retry_at
--             cleared. attempt_count is left untouched (this is a distinct
--             path from retry-exhaustion below).
--   'retry' - delivery failed but may be retried. The retry count is
--             calculated exactly once: v_attempt := v_row.attempt_count + 1.
--               attempts 1-5: attempt_count = v_attempt, status = 'failed',
--                 next_retry_at scheduled per the fixed backoff table below,
--                 with ±20% jitter:
--                   attempt 1 ->   1 minute
--                   attempt 2 ->   5 minutes
--                   attempt 3 ->  15 minutes
--                   attempt 4 ->  60 minutes
--                   attempt 5 -> 360 minutes (6 hours)
--               attempt >= 6: attempt_count = v_attempt, status = 'dead',
--                 next_retry_at = null.
--
-- On 'sent' and both dead paths ('dead' outcome, and 'retry' exhausted at
-- attempt >= 6), locked_by/locked_at/next_retry_at are all cleared.
create or replace function public.complete_notification_delivery(
  p_id        uuid,
  p_worker_id text,
  p_outcome   text,
  p_error     text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row          public.notification_deliveries;
  v_attempt      int;
  v_base_minutes int;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'invalid_worker_id';
  end if;

  if p_outcome not in ('sent', 'retry', 'dead') then
    raise exception 'invalid_outcome';
  end if;

  select * into v_row
    from public.notification_deliveries
   where id = p_id
     and status = 'processing'
     and locked_by = p_worker_id
     and recipient_type = 'team'
   for update;

  if not found then
    return false;
  end if;

  if p_outcome = 'sent' then
    update public.notification_deliveries
       set status        = 'sent',
           sent_at        = now(),
           next_retry_at  = null,
           last_error     = null,
           locked_by      = null,
           locked_at      = null,
           updated_at     = now()
     where id = p_id
       and status = 'processing'
       and locked_by = p_worker_id
       and recipient_type = 'team';
    return true;
  end if;

  if p_outcome = 'dead' then
    update public.notification_deliveries
       set status        = 'dead',
           next_retry_at  = null,
           last_error     = p_error,
           locked_by      = null,
           locked_at      = null,
           updated_at     = now()
     where id = p_id
       and status = 'processing'
       and locked_by = p_worker_id
       and recipient_type = 'team';
    return true;
  end if;

  -- p_outcome = 'retry': calculate the retry count exactly once.
  v_attempt := v_row.attempt_count + 1;

  if v_attempt >= 6 then
    update public.notification_deliveries
       set attempt_count  = v_attempt,
           status         = 'dead',
           next_retry_at  = null,
           last_error     = p_error,
           locked_by      = null,
           locked_at      = null,
           updated_at     = now()
     where id = p_id
       and status = 'processing'
       and locked_by = p_worker_id
       and recipient_type = 'team';
    return true;
  end if;

  v_base_minutes := case v_attempt
    when 1 then 1
    when 2 then 5
    when 3 then 15
    when 4 then 60
    when 5 then 360
  end;

  update public.notification_deliveries
     set attempt_count  = v_attempt,
         status         = 'failed',
         next_retry_at  = now() + (make_interval(mins => v_base_minutes) * (0.8 + random() * 0.4)),
         last_error     = p_error,
         locked_by      = null,
         locked_at      = null,
         updated_at     = now()
   where id = p_id
     and status = 'processing'
     and locked_by = p_worker_id
     and recipient_type = 'team';

  return true;
end;
$$;

revoke all on function public.complete_notification_delivery(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_notification_delivery(uuid, text, text, text)
  to service_role;

-- ROLLBACK (non-destructive):
--   drop function if exists public.complete_notification_delivery(uuid, text, text, text);
--   drop function if exists public.claim_team_notification_deliveries(text, int, text[]);
--   drop index if exists notification_deliveries_locked_idx;
-- Do NOT drop locked_by / locked_at columns and do NOT revert the status
-- constraint once any row may have used 'processing' or 'dead'.
