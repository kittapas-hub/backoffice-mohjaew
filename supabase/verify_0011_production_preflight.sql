-- Read-only production preflight for 0011_slip_verification.sql.
--
-- Run this report only after 0010_reconcile_0006_0009.sql has been applied.
-- It contains SELECTs against catalog metadata and aggregate counts only; it
-- does not invoke application functions or return customer, booking, payment,
-- notification, or slip rows.
--
-- Source provenance is a repository gate, not a database capability. The
-- supplied commit below is intentionally reported as FAIL: it is not a valid
-- commit in the reviewed checkout. The reviewed migration is instead blob
-- ab1d75b1aba70f181818cf88c9d08c641abe82c4 in commit
-- 6af8356eae317393403a4fc6780e53596489d08b.

with
source_provenance as (
  select
    '6af83563216a2701a3878d74c85e86ff510b093b'::text as supplied_commit,
    '6af8356eae317393403a4fc6780e53596489d08b'::text as actual_reviewed_commit,
    'ab1d75b1aba70f181818cf88c9d08c641abe82c4'::text as migration_blob,
    '6c30aa9c267d6645bf9a2bf1b916bc8da31dc9ddd14fd4fe795c1086f8cff6a7'::text
      as working_tree_sha256,
    false as pass
),
required_0010_functions(signature) as (
  values
    ('public.get_open_slots(date)'::text),
    ('public.transition_slot_booking(uuid,text)'::text),
    ('public.claim_team_notification_deliveries(text,integer,text[])'::text)
),
function_privileges as (
  select
    signature,
    to_regprocedure(signature) as function_oid
  from required_0010_functions
),
function_baseline as (
  select
    count(*) = 3
      and bool_and(function_oid is not null)
      and bool_and(not coalesce(
        has_function_privilege(to_regrole('anon'), function_oid, 'execute'), false
      ))
      and bool_and(not coalesce(
        has_function_privilege(to_regrole('authenticated'), function_oid, 'execute'), false
      ))
      and bool_and(coalesce(
        has_function_privilege(to_regrole('service_role'), function_oid, 'execute'), false
      )) as pass
  from function_privileges
),
get_open_slots_definition as (
  select
    coalesce(position(
      'expire_pending_bookings' in pg_get_functiondef(
        to_regprocedure('public.get_open_slots(date)')
      )
    ) = 0, false) as pass
),
cutover_dates as (
  select distinct booking_date
  from public.booking_slots
  where booking_date >= date '2026-07-12'
),
canonical_sessions as (
  select
    d.booking_date,
    count(s.id) filter (where (s.start_time, s.end_time) in (
      ('09:00'::time, '12:00'::time),
      ('13:00'::time, '16:00'::time),
      ('18:00'::time, '21:00'::time),
      ('22:00'::time, '23:00'::time)
    )) as canonical_count,
    count(s.id) filter (where
      (s.start_time, s.end_time, s.capacity) in (
        ('09:00'::time, '12:00'::time, 5),
        ('13:00'::time, '16:00'::time, 5),
        ('18:00'::time, '21:00'::time, 5),
        ('22:00'::time, '23:00'::time, 2)
      )
    ) as expected_capacity_count
  from cutover_dates d
  left join public.booking_slots s on s.booking_date = d.booking_date
  group by d.booking_date
),
canonical_sessions_valid as (
  select coalesce(bool_and(
    canonical_count = 4 and expected_capacity_count = 4
  ), false) as pass
  from canonical_sessions
),
open_legacy_hourly_slots as (
  select count(*) as count
  from public.booking_slots s
  where s.booking_date >= date '2026-07-12'
    and (s.end_time - s.start_time) = interval '1 hour'
    and s.start_time >= '09:00'::time
    and s.end_time <= '21:00'::time
    and (s.start_time, s.end_time) not in (
      ('09:00'::time, '12:00'::time),
      ('13:00'::time, '16:00'::time),
      ('18:00'::time, '21:00'::time),
      ('22:00'::time, '23:00'::time)
    )
    and s.is_open
),
slip_object_collisions as (
  select count(*) as count
  from (
    select c.oid
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('payment_slip_verifications', 'payment_transactions')
    union all
    select p.oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'reject_payment_order_trust_field_change',
        'create_slip_payment_order',
        'confirm_slip_payment',
        'approve_manual_review_payment'
      )
    union all
    select t.oid
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'payment_orders'
      and t.tgname = 'payment_orders_trust_fields_immutable'
      and not t.tgisinternal
    union all
    select a.attrelid
    from pg_attribute a join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and ((c.relname = 'payment_orders' and a.attname = 'receiver_profile')
        or (c.relname = 'notification_deliveries' and a.attname = 'line_retry_key'))
      and a.attnum > 0 and not a.attisdropped
    union all
    select con.oid
    from pg_constraint con join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'payment_orders'
      and con.conname = 'payment_orders_promptpay_profile_check'
  ) collisions
),
required_tables(table_name) as (
  values ('bookings'::text), ('payment_orders'::text),
         ('notification_deliveries'::text)
),
table_rls_baseline as (
  select
    count(*) = 3
      and bool_and(coalesce(c.relrowsecurity, false))
      and bool_and(not coalesce(has_table_privilege(
        to_regrole('anon'), c.oid, 'select,insert,update,delete'
      ), false))
      and bool_and(not coalesce(has_table_privilege(
        to_regrole('authenticated'), c.oid, 'select,insert,update,delete'
      ), false))
      and bool_and(coalesce(has_table_privilege(
        to_regrole('service_role'), c.oid, 'select,insert,update'
      ), false)) as pass
  from required_tables r
  left join pg_class c on c.oid = to_regclass('public.' || r.table_name)
),
required_columns(table_name, column_name) as (
  values
    ('bookings', 'id'), ('bookings', 'status'), ('bookings', 'hold_expires_at'),
    ('payment_orders', 'id'), ('payment_orders', 'booking_id'),
    ('payment_orders', 'provider'), ('payment_orders', 'currency'),
    ('payment_orders', 'amount_satang'), ('payment_orders', 'status'),
    ('payment_orders', 'expires_at'), ('payment_orders', 'idempotency_key'),
    ('notification_deliveries', 'booking_id'),
    ('notification_deliveries', 'payment_order_id'),
    ('notification_deliveries', 'idempotency_key'),
    ('notification_deliveries', 'event_type')
),
required_columns_present as (
  select count(*) = 15 and bool_and(a.attnum is not null) as pass
  from required_columns r
  left join pg_attribute a on a.attrelid = to_regclass('public.' || r.table_name)
    and a.attname = r.column_name and a.attnum > 0 and not a.attisdropped
),
existing_row_integrity as (
  select
    (select count(*) from public.payment_orders po
       left join public.bookings b on b.id = po.booking_id
       where b.id is null) = 0
    and
    (select count(*) from public.notification_deliveries d
       left join public.bookings b on b.id = d.booking_id
       where b.id is null) = 0
    and
    (select count(*) from public.notification_deliveries d
       left join public.payment_orders po on po.id = d.payment_order_id
       where d.payment_order_id is not null and po.id is null) = 0 as pass
),
pgcrypto_available as (
  select exists (select 1 from pg_extension where extname = 'pgcrypto') as pass
),
checks as (
  select 'source_provenance'::text as check_name, pass,
    jsonb_build_object(
      'supplied_commit', supplied_commit,
      'actual_reviewed_commit', actual_reviewed_commit,
      'migration_blob', migration_blob,
      'working_tree_sha256', working_tree_sha256
    ) as evidence
  from source_provenance
  union all
  select 'reconciliation_0010_function_baseline', pass,
    jsonb_build_object('required_signatures', array_agg(signature order by signature))
  from function_baseline cross join function_privileges
  group by function_baseline.pass
  union all
  select 'reconciliation_0010_get_open_slots_is_read_only', pass,
    jsonb_build_object('forbidden_marker', 'expire_pending_bookings')
  from get_open_slots_definition
  union all
  select 'canonical_booking_sessions', pass,
    jsonb_build_object('cutover_date', '2026-07-12')
  from canonical_sessions_valid
  union all
  select 'open_legacy_hourly_slots', count = 0,
    jsonb_build_object('open_legacy_hourly_slot_count', count)
  from open_legacy_hourly_slots
  union all
  select 'migration_0011_objects_absent_and_no_collisions', count = 0,
    jsonb_build_object('existing_0011_named_object_count', count)
  from slip_object_collisions
  union all
  select 'rls_and_table_privilege_baseline', pass,
    jsonb_build_object('tables', array['bookings','payment_orders','notification_deliveries'])
  from table_rls_baseline
  union all
  select 'function_privilege_baseline', pass,
    jsonb_build_object('roles', array['anon','authenticated','service_role'])
  from function_baseline
  union all
  select 'required_pre_0011_columns', pass, '{}'::jsonb
  from required_columns_present
  union all
  select 'existing_row_referential_integrity', pass,
    jsonb_build_object('scope', 'aggregate foreign-key compatibility only')
  from existing_row_integrity
  union all
  select 'pgcrypto_available_for_line_retry_key_default', pass, '{}'::jsonb
  from pgcrypto_available
)
select
  check_name,
  case when pass then 'PASS' else 'FAIL' end as status,
  evidence
from checks
order by check_name;
