-- Read-only post-migration verification for 0013_payment_slip_notification_image.sql.
-- Safe for a disposable PostgreSQL database or the Supabase Production SQL
-- Editor. Returns PASS/FAIL rows only; it never selects customer, booking,
-- payment, or slip-image row contents.
with
roles as (
  select
    to_regrole('anon') as anon_oid,
    to_regrole('authenticated') as authenticated_oid,
    to_regrole('service_role') as service_oid
),
bucket_summary as (
  select
    count(*)::bigint as matching_buckets,
    count(*) filter (where b."public" is false)::bigint as private_buckets,
    count(*) filter (where b."public" is null)::bigint as null_visibility_buckets
  from storage.buckets b
  where b.id = 'payment-slips'
),
required_columns(table_name, column_name, expect_not_null) as (
  values
    ('payment_slip_images', 'payment_order_id', true),
    ('payment_slip_images', 'booking_id', true),
    ('payment_slip_images', 'storage_path', true),
    ('payment_slip_images', 'mime_type', true),
    ('payment_slip_images', 'created_at', true)
),
column_summary as (
  select
    count(*)::int as expected_count,
    count(a.attname)::int as present_count,
    count(*) filter (where a.attname is not null and (not r.expect_not_null or a.attnotnull))::int as valid_count
  from required_columns r
  left join pg_attribute a
    on a.attrelid = to_regclass('public.' || r.table_name)
   and a.attname = r.column_name
   and a.attnum > 0
   and not a.attisdropped
),
required_indexes(index_name, expect_unique) as (
  values
    ('payment_slip_images_order_idx', false)
),
index_summary as (
  select
    count(*)::int as expected_count,
    count(i.indexrelid)::int as present_count,
    count(*) filter (
      where i.indexrelid is not null
        and i.indisvalid
        and i.indisready
        and i.indisunique = r.expect_unique
    )::int as valid_count
  from required_indexes r
  left join pg_class c on c.relname = r.index_name
  left join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  left join pg_index i on i.indexrelid = c.oid
),
sensitive_tables(table_name) as (
  values ('payment_slip_images')
),
table_security_summary as (
  select
    count(*)::int as expected_count,
    count(*) filter (
      where c.oid is not null
        and c.relrowsecurity
        and r.anon_oid is not null
        and r.authenticated_oid is not null
        and r.service_oid is not null
        and not coalesce(has_table_privilege(r.anon_oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE'), false)
        and not coalesce(has_table_privilege(r.authenticated_oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE'), false)
        and coalesce(has_table_privilege(r.service_oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE'), false)
    )::int as safe_count
  from sensitive_tables t
  left join pg_class c on c.oid = to_regclass('public.' || t.table_name)
  cross join roles r
),
required_functions(signature) as (
  values
    ('public.transition_slot_booking(uuid,text)'::text),
    ('public.confirm_slip_payment(uuid,text,text,timestamp with time zone,integer,text,text,jsonb)'::text),
    ('public.approve_manual_review_payment(uuid)'::text)
),
confirmation_functions as (
  select p.proname, p.prosrc
  from required_functions r
  join pg_proc p on p.oid = to_regprocedure(r.signature)
),
slip_field_summary as (
  select
    count(*) filter (
      where proname in ('confirm_slip_payment', 'approve_manual_review_payment')
        and position(quote_literal('slip_storage_path') in prosrc) > 0
    )::int as functions_with_slip_field,
    count(*) filter (
      where position(quote_literal('image_storage_path') in prosrc) > 0
    )::int as functions_still_with_face_field,
    count(*) filter (
      where proname = 'transition_slot_booking'
        and (position('booking_images' in prosrc) > 0 or position('payment_slip_images' in prosrc) > 0)
    )::int as admin_override_with_image_lookup
  from confirmation_functions
),
function_count as (
  select count(*)::int as n from confirmation_functions
),
debug_summary as (
  select count(*)::int as debug_functions
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname ~* '(mohjaew_test|debug|temp.*group|group.*temp)'
),
checks(check_name, pass, evidence) as (
  select 'payment_slips_bucket_private', matching_buckets = 1 and private_buckets = 1 and null_visibility_buckets = 0,
    format('matching_buckets=%s; private_buckets=%s', matching_buckets, private_buckets) from bucket_summary
  union all
  select 'required_0013_columns', expected_count = present_count and expected_count = valid_count,
    format('valid_columns=%s/%s', valid_count, expected_count) from column_summary
  union all
  select 'required_0013_indexes', expected_count = present_count and expected_count = valid_count,
    format('valid_indexes=%s/%s', valid_count, expected_count) from index_summary
  union all
  select 'payment_slip_images_rls_and_acl', expected_count = safe_count,
    format('safe_tables=%s/%s', safe_count, expected_count) from table_security_summary
  union all
  select 'confirmation_functions_present', n = 3,
    format('present=%s/3', n) from function_count
  union all
  select 'slip_storage_path_replaces_image_storage_path',
    (select n from function_count) = 3
      and functions_with_slip_field = 2
      and functions_still_with_face_field = 0,
    format('slip_field=%s/2; stale_face_field=%s', functions_with_slip_field, functions_still_with_face_field)
    from slip_field_summary
  union all
  select 'admin_override_never_attaches_an_image', admin_override_with_image_lookup = 0,
    format('admin_override_image_lookups=%s', admin_override_with_image_lookup) from slip_field_summary
  union all
  select 'no_debug_functions_remain', debug_functions = 0,
    format('debug_functions=%s', debug_functions) from debug_summary
)
select check_name, case when pass then 'PASS' else 'FAIL' end as status, evidence
from checks
order by check_name;
