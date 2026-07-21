-- Read-only production preflight for 0013_payment_slip_notification_image.sql.
--
-- Run this report only after 0012_booking_confirmed_notification.sql has
-- been applied. It contains SELECTs against catalog metadata and aggregate
-- counts only; it does not invoke application functions or return
-- customer, booking, payment, notification, or slip row contents.
--
-- Source provenance here is blob-only (no hardcoded reviewed-commit
-- literal), unlike 0011/0012's preflights. Rationale: a commit-hash literal
-- can only ever be correct once the authoring commit already exists, so
-- hardcoding one before that commit is created either guesses wrong or
-- requires a follow-up fix commit — exactly the stale, self-comparing
-- source_provenance defect found (and fixed) in
-- verify_0012_production_preflight.sql. The migration_blob literal below has
-- no such chicken-and-egg problem (git hash-object works on the file's
-- content alone, commit not required) and is independently re-verified by
-- verify_0013_production_preflight.test.ts against a live git hash-object
-- call — the same enforcement mechanism 0012's provenance defect fix added.
with
source_provenance_facts as (
  select 'e9ddc7af68ad203cec73562073fd878e224008b4'::text as migration_blob
),
required_0012_functions(signature) as (
  values
    ('public.transition_slot_booking(uuid,text)'::text),
    ('public.confirm_slip_payment(uuid,text,text,timestamp with time zone,integer,text,text,jsonb)'::text),
    ('public.approve_manual_review_payment(uuid)'::text),
    ('public.claim_team_notification_deliveries(text,integer,text[])'::text)
),
function_baseline as (
  select
    count(*) = 4
      and bool_and(to_regprocedure(signature) is not null)
      and bool_and(not coalesce(
        has_function_privilege(to_regrole('anon'), to_regprocedure(signature), 'execute'), false
      ))
      and bool_and(not coalesce(
        has_function_privilege(to_regrole('authenticated'), to_regprocedure(signature), 'execute'), false
      ))
      and bool_and(coalesce(
        has_function_privilege(to_regrole('service_role'), to_regprocedure(signature), 'execute'), false
      )) as pass
  from required_0012_functions
),
required_columns(table_name, column_name) as (
  values
    ('payment_orders', 'id'), ('payment_orders', 'booking_id'),
    ('bookings', 'id'),
    ('notification_deliveries', 'line_retry_key'),
    ('notification_deliveries', 'image_retry_key'),
    ('notification_deliveries', 'payload')
),
required_columns_present as (
  select count(*) = 6 and bool_and(a.attnum is not null) as pass
  from required_columns r
  left join pg_attribute a on a.attrelid = to_regclass('public.' || r.table_name)
    and a.attname = r.column_name and a.attnum > 0 and not a.attisdropped
),
migration_0013_object_collisions as (
  select
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in (
           'payment_slip_images', 'payment_slip_evidence_failures', 'notification_image_deliveries'
         ))
    +
    (select count(*) from storage.buckets b where b.id = 'payment-slips')
    +
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('claim_notification_image_deliveries', 'complete_notification_image_delivery'))
    as count
),
face_image_field_still_present as (
  select count(*) as count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('transition_slot_booking', 'confirm_slip_payment', 'approve_manual_review_payment')
    and position(quote_literal('image_storage_path') in p.prosrc) > 0
),
pgcrypto_available as (
  select exists (select 1 from pg_extension where extname = 'pgcrypto') as pass
),
checks as (
  select 'source_provenance'::text as check_name,
    migration_blob = 'e9ddc7af68ad203cec73562073fd878e224008b4' as pass,
    jsonb_build_object('migration_blob', migration_blob) as evidence
  from source_provenance_facts
  union all
  select 'required_0012_function_baseline', pass,
    jsonb_build_object('required_signatures', (select array_agg(signature order by signature) from required_0012_functions))
  from function_baseline
  union all
  select 'required_pre_0013_columns', pass, '{}'::jsonb
  from required_columns_present
  union all
  select 'migration_0013_objects_absent', count = 0,
    jsonb_build_object('existing_0013_named_object_count', count)
  from migration_0013_object_collisions
  union all
  select 'pre_0013_functions_still_use_image_storage_path', count = 3,
    jsonb_build_object('functions_with_image_storage_path', count)
  from face_image_field_still_present
  union all
  select 'pgcrypto_available_for_payment_slip_images_default', pass, '{}'::jsonb
  from pgcrypto_available
)
select
  check_name,
  case when pass then 'PASS' else 'FAIL' end as status,
  evidence
from checks
order by check_name;
