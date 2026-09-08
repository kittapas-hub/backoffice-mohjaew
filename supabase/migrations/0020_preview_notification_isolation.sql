begin;

-- Shared Supabase is used by Vercel Preview and Production. Tag every durable
-- notification intent at insert time so Production workers can never drain
-- Preview/UAT rows.
alter table public.notification_deliveries
  add column if not exists delivery_scope text;

update public.notification_deliveries
   set delivery_scope = 'production'
 where delivery_scope is null;

alter table public.notification_deliveries
  alter column delivery_scope set default
    coalesce(nullif(current_setting('app.notification_scope', true), ''), 'production'),
  alter column delivery_scope set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'notification_deliveries_scope_check'
       and conrelid = 'public.notification_deliveries'::regclass
  ) then
    alter table public.notification_deliveries
      add constraint notification_deliveries_scope_check
      check (delivery_scope in ('production','preview'));
  end if;
end $$;

create index if not exists notification_deliveries_scope_due_idx
  on public.notification_deliveries (delivery_scope, status, next_retry_at, created_at)
  where recipient_type = 'team';
-- Scoped wrappers set a transaction-local GUC. Existing Production callers
-- keep using the old RPCs and therefore retain the safe default 'production'.
create or replace function public.confirm_slip_payment_scoped(
  p_payment_order_id uuid,
  p_provider text,
  p_provider_tx_ref text,
  p_transfer_at timestamptz,
  p_amount_satang int,
  p_currency text,
  p_receiver_profile text,
  p_evidence jsonb,
  p_delivery_scope text
) returns jsonb
language plpgsql
as $$
begin
  if p_delivery_scope not in ('production','preview') then
    raise exception 'invalid_delivery_scope';
  end if;
  perform set_config('app.notification_scope', p_delivery_scope, true);
  return public.confirm_slip_payment(
    p_payment_order_id, p_provider, p_provider_tx_ref, p_transfer_at,
    p_amount_satang, p_currency, p_receiver_profile, p_evidence
  );
end;
$$;
revoke all on function public.confirm_slip_payment_scoped(
  uuid,text,text,timestamptz,int,text,text,jsonb,text
) from public, anon, authenticated;
grant execute on function public.confirm_slip_payment_scoped(
  uuid,text,text,timestamptz,int,text,text,jsonb,text
) to service_role;
create or replace function public.approve_manual_review_payment_scoped(
  p_booking_id uuid,
  p_delivery_scope text
) returns jsonb
language plpgsql
as $$
begin
  if p_delivery_scope not in ('production','preview') then
    raise exception 'invalid_delivery_scope';
  end if;
  perform set_config('app.notification_scope', p_delivery_scope, true);
  return public.approve_manual_review_payment(p_booking_id);
end;
$$;
revoke all on function public.approve_manual_review_payment_scoped(uuid,text)
  from public, anon, authenticated;
grant execute on function public.approve_manual_review_payment_scoped(uuid,text)
  to service_role;

create or replace function public.transition_slot_booking_scoped(
  p_booking_id uuid,
  p_to text,
  p_delivery_scope text
) returns public.bookings
language plpgsql
as $$
begin
  if p_delivery_scope not in ('production','preview') then
    raise exception 'invalid_delivery_scope';
  end if;
  perform set_config('app.notification_scope', p_delivery_scope, true);
  return public.transition_slot_booking(p_booking_id, p_to);
end;
$$;
revoke all on function public.transition_slot_booking_scoped(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.transition_slot_booking_scoped(uuid,text,text)
  to service_role;

-- Keep the legacy Production worker signature intact, but hard-filter it to
-- delivery_scope='production'. This immediately protects Preview rows even
-- while the currently deployed main branch is still running old worker code.
create or replace function public.claim_team_notification_deliveries(
  p_worker_id text,
  p_batch int,
  p_event_types text[]
)
returns table (
  id uuid,
  booking_id uuid,
  payment_order_id uuid,
  channel text,
  event_type text,
  payload jsonb,
  idempotency_key text,
  attempt_count int,
  line_retry_key uuid,
  image_retry_key uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch int;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then raise exception 'invalid_worker_id'; end if;
  if p_batch is null or p_batch < 1 then raise exception 'invalid_batch'; end if;
  v_batch := least(p_batch, 100);
  if p_event_types is null or cardinality(p_event_types) = 0 then raise exception 'invalid_event_types'; end if;
  return query
    with candidates as (
      select d.id
        from public.notification_deliveries d
       where d.recipient_type = 'team'
         and d.channel = 'line'
         and d.delivery_scope = 'production'
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
       set status = 'processing',
           locked_by = p_worker_id,
           locked_at = now(),
           updated_at = now()
      from candidates
     where upd.id = candidates.id
    returning upd.id, upd.booking_id, upd.payment_order_id, upd.channel,
              upd.event_type, upd.payload, upd.idempotency_key,
              upd.attempt_count, upd.line_retry_key, upd.image_retry_key;
end;
$$;
revoke all on function public.claim_team_notification_deliveries(text,int,text[])
  from public, anon, authenticated;
grant execute on function public.claim_team_notification_deliveries(text,int,text[])
  to service_role;
-- Image delivery is independently claimed, so it must also inherit the parent
-- notification's Production-only scope gate.
create or replace function public.claim_notification_image_deliveries(
  p_worker_id text,
  p_batch int
)
returns table (
  id uuid,
  notification_delivery_id uuid,
  image_kind text,
  storage_path text,
  line_retry_key uuid,
  attempt_count int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch int;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then raise exception 'invalid_worker_id'; end if;
  if p_batch is null or p_batch < 1 then raise exception 'invalid_batch'; end if;
  v_batch := least(p_batch, 100);

  return query
    with candidates as (
      select nid.id
        from public.notification_image_deliveries nid
       where (
              (nid.status in ('pending', 'failed')
               and (nid.next_retry_at is null or nid.next_retry_at <= now()))
           or (nid.status = 'processing' and nid.locked_at < now() - interval '10 minutes')
         )
         and exists (
               select 1 from public.notification_deliveries nd
                where nd.id = nid.notification_delivery_id
                  and nd.status = 'sent'
                  and nd.delivery_scope = 'production'
             )
       order by nid.created_at
       limit v_batch
       for update skip locked
    )
    update public.notification_image_deliveries upd
       set status = 'processing',
           locked_by = p_worker_id,
           locked_at = now(),
           updated_at = now()
      from candidates
     where upd.id = candidates.id
    returning upd.id, upd.notification_delivery_id, upd.image_kind,
              upd.storage_path, upd.line_retry_key, upd.attempt_count;
end;
$$;
revoke all on function public.claim_notification_image_deliveries(text,int)
  from public, anon, authenticated;
grant execute on function public.claim_notification_image_deliveries(text,int)
  to service_role;

commit;
