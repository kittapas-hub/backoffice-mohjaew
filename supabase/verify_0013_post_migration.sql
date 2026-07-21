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
    ('payment_slip_evidence_failures', 'payment_order_id', true),
    ('payment_slip_evidence_failures', 'stage', true),
    ('notification_image_deliveries', 'notification_delivery_id', true),
    ('notification_image_deliveries', 'image_kind', true),
    ('notification_image_deliveries', 'storage_path', true),
    ('notification_image_deliveries', 'status', true),
    ('notification_image_deliveries', 'attempt_count', true),
    ('notification_image_deliveries', 'line_retry_key', true)
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
    ('payment_slip_images_order_idx', false),
    ('payment_slip_evidence_failures_order_idx', false),
    ('notification_image_deliveries_due_idx', false),
    ('notification_image_deliveries_locked_idx', false),
    ('notification_image_deliveries_line_retry_key_uniq', true)
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
notification_image_deliveries_unique_pair as (
  select count(*)::int as n
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = c.relnamespace
  where nsp.nspname = 'public' and c.relname = 'notification_image_deliveries'
    and con.contype = 'u'
    and (
      select array_agg(attname::text order by attname)
      from pg_attribute
      where attrelid = con.conrelid and attnum = any(con.conkey)
    ) = array['image_kind', 'notification_delivery_id']
),
sensitive_tables(table_name) as (
  values ('payment_slip_images'), ('payment_slip_evidence_failures'), ('notification_image_deliveries')
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
required_image_rpcs(signature, expect_definer, require_pinned_path) as (
  values
    ('public.claim_notification_image_deliveries(text,integer)'::text, true, true),
    ('public.complete_notification_image_delivery(uuid,text,text,text)'::text, true, true)
),
image_rpc_rows as (
  select r.*, p.oid, p.prosecdef, p.proconfig
  from required_image_rpcs r
  left join pg_proc p on p.oid = to_regprocedure(r.signature)
),
image_rpc_summary as (
  select
    count(*)::int as expected_count,
    count(oid)::int as present_count,
    count(*) filter (
      where oid is not null
        and prosecdef = expect_definer
        and coalesce(proconfig, '{}'::text[]) @> array['search_path=public, pg_temp']
    )::int as hardened_count
  from image_rpc_rows
),
image_rpc_acl_summary as (
  select
    count(*)::int as expected_count,
    count(*) filter (
      where f.oid is not null
        and r.anon_oid is not null
        and r.authenticated_oid is not null
        and r.service_oid is not null
        and not coalesce(has_function_privilege(r.anon_oid, f.oid, 'EXECUTE'), false)
        and not coalesce(has_function_privilege(r.authenticated_oid, f.oid, 'EXECUTE'), false)
        and coalesce(has_function_privilege(r.service_oid, f.oid, 'EXECUTE'), false)
    )::int as safe_count
  from image_rpc_rows f
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
image_task_summary as (
  select
    count(*) filter (
      where proname in ('confirm_slip_payment', 'transition_slot_booking')
        and position(quote_literal('face') in prosrc) > 0
        and position('notification_image_deliveries' in prosrc) > 0
    )::int as functions_enqueue_face,
    count(*) filter (
      where proname = 'confirm_slip_payment'
        and position(quote_literal('payment_slip') in prosrc) > 0
    )::int as confirm_slip_payment_enqueues_slip,
    count(*) filter (
      where proname = 'transition_slot_booking'
        and position(quote_literal('payment_slip') in prosrc) > 0
    )::int as admin_override_enqueues_slip,
    count(*) filter (
      where proname = 'approve_manual_review_payment'
        and position('notification_image_deliveries' in prosrc) > 0
    )::int as approve_creates_image_rows,
    count(*) filter (
      where position(quote_literal('image_storage_path') in prosrc) > 0
    )::int as functions_still_with_retired_field
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
  select 'notification_image_deliveries_unique_per_kind', n = 1,
    format('unique_constraints=%s', n) from notification_image_deliveries_unique_pair
  union all
  select 'payment_slip_tables_rls_and_acl', expected_count = safe_count,
    format('safe_tables=%s/%s', safe_count, expected_count) from table_security_summary
  union all
  select 'image_delivery_rpcs_present_and_hardened', expected_count = present_count and expected_count = hardened_count,
    format('hardened=%s/%s', hardened_count, expected_count) from image_rpc_summary
  union all
  select 'image_delivery_rpc_acl_service_role_only', expected_count = safe_count,
    format('safe=%s/%s', safe_count, expected_count) from image_rpc_acl_summary
  union all
  select 'confirmation_functions_present', n = 3,
    format('present=%s/3', n) from function_count
  union all
  select 'confirm_slip_payment_and_admin_override_enqueue_face',
    (select n from function_count) = 3 and functions_enqueue_face = 2,
    format('face_enqueuers=%s/2', functions_enqueue_face) from image_task_summary
  union all
  select 'only_confirm_slip_payment_enqueues_slip',
    confirm_slip_payment_enqueues_slip = 1 and admin_override_enqueues_slip = 0,
    format('confirm_slip_payment=%s; admin_override=%s', confirm_slip_payment_enqueues_slip, admin_override_enqueues_slip)
    from image_task_summary
  union all
  select 'approve_manual_review_payment_creates_no_image_rows', approve_creates_image_rows = 0,
    format('image_row_inserts=%s', approve_creates_image_rows) from image_task_summary
  union all
  select 'retired_image_storage_path_field_absent_from_payload',
    functions_still_with_retired_field = 0,
    format('functions_with_retired_field=%s', functions_still_with_retired_field) from image_task_summary
  union all
  select 'no_debug_functions_remain', debug_functions = 0,
    format('debug_functions=%s', debug_functions) from debug_summary
)
select check_name, case when pass then 'PASS' else 'FAIL' end as status, evidence
from checks
order by check_name;
