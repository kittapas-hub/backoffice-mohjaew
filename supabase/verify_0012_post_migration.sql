-- Read-only post-migration verification for the final hardened 0012 schema.
-- Safe for a disposable PostgreSQL database or the Supabase Production SQL
-- Editor. Returns PASS/FAIL rows only; it never selects customer row data.
with
roles as (
  select
    to_regrole('anon') as anon_oid,
    to_regrole('authenticated') as authenticated_oid,
    to_regrole('service_role') as service_oid
),
required_columns(table_name, column_name, expect_not_null) as (
  values
    ('notification_deliveries', 'idempotency_key', true),
    ('notification_deliveries', 'line_retry_key', true),
    ('notification_deliveries', 'image_retry_key', true),
    ('notification_deliveries', 'payload', false),
    ('payment_orders', 'receiver_profile', false),
    ('payment_transactions', 'normalized_tx_ref', true),
    ('payment_slip_verifications', 'outcome', true)
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
    ('notification_deliveries_idempotency_key_key', true),
    ('notification_deliveries_booking_idx', false),
    ('notification_deliveries_retry_idx', false),
    ('notification_deliveries_line_retry_key_uniq', true),
    ('notification_deliveries_image_retry_key_uniq', true),
    ('payment_transactions_provider_ref_uniq', true)
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
required_functions(signature, expect_definer, require_pinned_path) as (
  values
    ('public.transition_slot_booking(uuid,text)', false, false),
    ('public.confirm_slip_payment(uuid,text,text,timestamp with time zone,integer,text,text,jsonb)', false, false),
    ('public.approve_manual_review_payment(uuid)', false, false),
    ('public.claim_team_notification_deliveries(text,integer,text[])', true, true),
    ('public.complete_notification_delivery(uuid,text,text,text)', true, true)
),
function_rows as (
  select
    r.*,
    p.oid,
    p.prosecdef,
    p.proconfig,
    p.prosrc,
    pg_get_function_result(p.oid) as result_signature
  from required_functions r
  left join pg_proc p on p.oid = to_regprocedure(r.signature)
),
function_summary as (
  select
    count(*)::int as expected_count,
    count(oid)::int as present_count,
    count(*) filter (
      where oid is not null
        and prosecdef = expect_definer
        and (
          not require_pinned_path
          or coalesce(proconfig, '{}'::text[]) @> array['search_path=public, pg_temp']
        )
    )::int as hardened_count
  from function_rows
),
function_acl_summary as (
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
  from function_rows f
  cross join roles r
),
sensitive_tables(table_name) as (
  values
    ('notification_deliveries'),
    ('payment_orders'),
    ('payment_transactions'),
    ('payment_slip_verifications')
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
claim_rpc_summary as (
  select
    count(*)::int as overload_count,
    count(*) filter (
      where pg_get_function_identity_arguments(p.oid) = 'p_worker_id text, p_batch integer, p_event_types text[]'
        and lower(pg_get_function_result(p.oid)) = lower(
          'TABLE(id uuid, booking_id uuid, payment_order_id uuid, channel text, event_type text, payload jsonb, idempotency_key text, attempt_count integer, line_retry_key uuid, image_retry_key uuid)'
        )
    )::int as compatible_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'claim_team_notification_deliveries'
),
confirmation_functions as (
  select p.proname, p.prosrc
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('transition_slot_booking', 'confirm_slip_payment', 'approve_manual_review_payment')
),
required_payload_fields(field_name) as (
  values
    ('booking_id'), ('reference_code'), ('customer_name'), ('birth_date'),
    ('consultation_topic'), ('phone'), ('booking_date'), ('session_time'),
    ('queue_number'), ('confirmation_method'), ('updated_at')
),
payload_summary as (
  select
    (select count(*) from confirmation_functions)::int as function_count,
    count(*)::int as expected_pairs,
    count(*) filter (where position(quote_literal(f.field_name) in c.prosrc) > 0)::int as present_pairs
  from confirmation_functions c
  cross join required_payload_fields f
),
semantic_summary as (
  select
    count(*) filter (where prosrc ~* 'booking_confirmed')::int as notification_functions,
    count(*) filter (
      where proname = 'approve_manual_review_payment'
        and prosrc ~* 'hold_expires_at[\s\S]*clock_timestamp'
        and prosrc ~* 'for update'
        and prosrc ~* 'slot_full'
    )::int as hardened_manual_functions,
    count(*) filter (
      where proname = 'confirm_slip_payment'
        and prosrc ~* 'hold_expires_at[\s\S]*clock_timestamp'
    )::int as hardened_automatic_functions
  from confirmation_functions
),
notification_data_summary as (
  select
    count(*) filter (where idempotency_key is null)::int as null_idempotency_keys,
    count(*) filter (where line_retry_key is null)::int as null_line_keys,
    count(*) filter (where image_retry_key is null)::int as null_image_keys,
    count(*) filter (where event_type = 'booking_confirmed' and recipient_type <> 'team')::int as wrong_recipients
  from public.notification_deliveries
),
duplicate_key_summary as (
  select count(*)::int as duplicate_groups
  from (
    select idempotency_key
    from public.notification_deliveries
    group by idempotency_key
    having count(*) > 1
  ) d
),
debug_summary as (
  select count(*)::int as debug_functions
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname ~* '(mohjaew_test|debug|temp.*group|group.*temp)'
),
checks(check_name, pass, evidence) as (
  select 'required_0012_columns', expected_count = present_count and expected_count = valid_count,
    format('valid_columns=%s/%s', valid_count, expected_count) from column_summary
  union all
  select 'required_idempotency_and_retry_indexes', expected_count = present_count and expected_count = valid_count,
    format('valid_indexes=%s/%s', valid_count, expected_count) from index_summary
  union all
  select 'rpc_signatures_and_security_modes', expected_count = present_count and expected_count = hardened_count,
    format('hardened_functions=%s/%s', hardened_count, expected_count) from function_summary
  union all
  select 'privileged_rpc_acl_service_role_only', expected_count = safe_count,
    format('safe_functions=%s/%s', safe_count, expected_count) from function_acl_summary
  union all
  select 'sensitive_table_rls_and_acl', expected_count = safe_count,
    format('safe_tables=%s/%s', safe_count, expected_count) from table_security_summary
  union all
  select 'notification_claim_return_signature', overload_count = 1 and compatible_count = 1,
    format('compatible=%s; overloads=%s', compatible_count, overload_count) from claim_rpc_summary
  union all
  select 'booking_confirmed_payload_fields', function_count = 3 and present_pairs = expected_pairs,
    format('payload_fields=%s/%s', present_pairs, expected_pairs) from payload_summary
  union all
  select 'booking_confirmation_semantics_present', notification_functions = 3 and hardened_manual_functions = 1 and hardened_automatic_functions = 1,
    format('notification_functions=%s/3; manual_guard=%s/1; automatic_guard=%s/1', notification_functions, hardened_manual_functions, hardened_automatic_functions) from semantic_summary
  union all
  select 'notification_rows_compatible', null_idempotency_keys = 0 and null_line_keys = 0 and null_image_keys = 0 and wrong_recipients = 0,
    format('null_idempotency=%s; null_line=%s; null_image=%s; wrong_recipients=%s', null_idempotency_keys, null_line_keys, null_image_keys, wrong_recipients) from notification_data_summary
  union all
  select 'notification_idempotency_keys_unique', duplicate_groups = 0,
    format('duplicate_groups=%s', duplicate_groups) from duplicate_key_summary
  union all
  select 'no_debug_functions_remain', debug_functions = 0,
    format('debug_functions=%s', debug_functions) from debug_summary
)
select check_name, case when pass then 'PASS' else 'FAIL' end as status, evidence
from checks
order by check_name;
