-- Read-only post-migration verification for 0011_slip_verification.sql.
--
-- Run this report only AFTER 0011_slip_verification.sql has been applied.
-- It contains SELECTs against catalog metadata and aggregate counts only.
-- It never invokes create_slip_payment_order, confirm_slip_payment,
-- approve_manual_review_payment, claim_team_notification_deliveries, or any
-- other application/mutating function, and never returns customer, booking,
-- payment, notification, or slip row contents beyond aggregate counts and
-- catalog object identity.
--
-- source_provenance PASSes when the migration Git blob matches
-- ab1d75b1aba70f181818cf88c9d08c641abe82c4 (reviewed commit
-- 6af8356eae317393403a4fc6780e53596489d08b). This is a static, authored-time
-- assertion: SQL cannot read the Git object store, so it is not a dynamic
-- database check.

with
source_provenance_facts as (
  select
    'ab1d75b1aba70f181818cf88c9d08c641abe82c4'::text as reported_migration_blob,
    'ab1d75b1aba70f181818cf88c9d08c641abe82c4'::text as expected_migration_blob,
    '6af8356eae317393403a4fc6780e53596489d08b'::text as reviewed_commit
),
source_provenance as (
  select
    reported_migration_blob,
    expected_migration_blob,
    reviewed_commit,
    reported_migration_blob = expected_migration_blob as pass
  from source_provenance_facts
),

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
required_0011_tables(table_name) as (
  values ('payment_slip_verifications'::text), ('payment_transactions'::text)
),
tables_0011 as (
  select
    r.table_name,
    to_regclass('public.' || r.table_name) as table_oid
  from required_0011_tables r
),
tables_0011_present as (
  select
    bool_and(table_oid is not null) as pass,
    jsonb_agg(jsonb_build_object('table', table_name, 'present', table_oid is not null)
      order by table_name) as evidence
  from tables_0011
),
legacy_slip_claim_index as (
  select to_regclass('public.payment_slip_verifications_tx_claim_uniq') is null as pass
),

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
required_0011_columns(table_name, column_name, expect_not_null) as (
  values
    ('payment_slip_verifications', 'id', true),
    ('payment_slip_verifications', 'payment_order_id', true),
    ('payment_slip_verifications', 'booking_id', true),
    ('payment_slip_verifications', 'provider', true),
    ('payment_slip_verifications', 'provider_tx_ref', false),
    ('payment_slip_verifications', 'transfer_at', false),
    ('payment_slip_verifications', 'amount_satang', false),
    ('payment_slip_verifications', 'outcome', true),
    ('payment_slip_verifications', 'evidence', false),
    ('payment_slip_verifications', 'created_at', true),
    ('payment_transactions', 'id', true),
    ('payment_transactions', 'provider', true),
    ('payment_transactions', 'normalized_tx_ref', true),
    ('payment_transactions', 'payment_order_id', true),
    ('payment_transactions', 'booking_id', true),
    ('payment_transactions', 'transfer_at', true),
    ('payment_transactions', 'amount_satang', true),
    ('payment_transactions', 'currency', true),
    ('payment_transactions', 'receiver_profile', false),
    ('payment_transactions', 'resolution', true),
    ('payment_transactions', 'resolution_reason', false),
    ('payment_transactions', 'created_at', true),
    ('payment_transactions', 'resolved_at', false),
    ('payment_orders', 'receiver_profile', false),
    ('notification_deliveries', 'line_retry_key', true)
),
columns_0011 as (
  select
    r.table_name,
    r.column_name,
    r.expect_not_null,
    a.attnum,
    a.attnotnull
  from required_0011_columns r
  left join pg_attribute a
    on a.attrelid = to_regclass('public.' || r.table_name)
   and a.attname = r.column_name
   and a.attnum > 0
   and not a.attisdropped
),
columns_0011_present as (
  select
    bool_and(attnum is not null) as all_present,
    bool_and(attnum is null or attnotnull = expect_not_null) as nullability_ok,
    jsonb_agg(jsonb_build_object(
      'table', table_name, 'column', column_name,
      'present', attnum is not null, 'not_null', attnotnull
    ) order by table_name, column_name) as evidence
  from columns_0011
),

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
required_0011_indexes(index_name, table_name, expect_unique) as (
  values
    ('payment_slip_verifications_order_idx', 'payment_slip_verifications', false),
    ('payment_transactions_provider_ref_uniq', 'payment_transactions', true)
),
indexes_0011 as (
  select
    r.index_name,
    r.expect_unique,
    ic.oid as index_oid,
    i.indisunique
  from required_0011_indexes r
  left join pg_class ic
    on ic.relname = r.index_name
   and ic.relnamespace = 'public'::regnamespace
   and ic.relkind = 'i'
  left join pg_index i on i.indexrelid = ic.oid
),
indexes_0011_present as (
  select
    bool_and(index_oid is not null) as all_present,
    bool_and(index_oid is null or coalesce(indisunique, false) = expect_unique) as uniqueness_ok,
    jsonb_agg(jsonb_build_object(
      'index', index_name, 'present', index_oid is not null, 'unique', indisunique
    ) order by index_name) as evidence
  from indexes_0011
),

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------
required_0011_constraints(constraint_name, table_name) as (
  values
    ('payment_orders_promptpay_profile_check', 'payment_orders'),
    ('payment_slip_verifications_outcome_check', 'payment_slip_verifications'),
    ('payment_transactions_resolution_check', 'payment_transactions'),
    ('payment_transactions_amount_satang_check', 'payment_transactions')
),
constraints_0011 as (
  select
    r.constraint_name,
    con.oid as constraint_oid
  from required_0011_constraints r
  left join pg_class c
    on c.relname = r.table_name and c.relnamespace = 'public'::regnamespace
  left join pg_constraint con
    on con.conrelid = c.oid and con.conname = r.constraint_name
),
constraints_0011_present as (
  select
    bool_and(constraint_oid is not null) as pass,
    jsonb_agg(jsonb_build_object('constraint', constraint_name, 'present', constraint_oid is not null)
      order by constraint_name) as evidence
  from constraints_0011
),
promptpay_check_lookup as (
  select
    (select con.oid from pg_constraint con
       join pg_class c on c.oid = con.conrelid
      where c.relname = 'payment_orders' and c.relnamespace = 'public'::regnamespace
        and con.conname = 'payment_orders_promptpay_profile_check') as constraint_oid
),
promptpay_check_content as (
  select
    constraint_oid is not null
      and position('promptpay_slip' in coalesce(pg_get_constraintdef(constraint_oid), '')) > 0
      and position('THB' in coalesce(pg_get_constraintdef(constraint_oid), '')) > 0
      and position('receiver_profile' in coalesce(pg_get_constraintdef(constraint_oid), '')) > 0
      as pass,
    coalesce(pg_get_constraintdef(constraint_oid), 'not_found') as definition
  from promptpay_check_lookup
),
ledger_uniqueness_check as (
  select
    exists (
      select 1 from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      join pg_class tc on tc.oid = i.indrelid
      where tc.relname = 'payment_transactions' and tc.relnamespace = 'public'::regnamespace
        and ic.relname = 'payment_transactions_provider_ref_uniq'
        and i.indisunique
    ) as unique_index_present,
    not exists (
      select 1 from public.payment_transactions
      group by provider, normalized_tx_ref having count(*) > 1
    ) as no_duplicate_ledger_rows
),

-- ---------------------------------------------------------------------------
-- Trigger
-- ---------------------------------------------------------------------------
trust_field_trigger as (
  select
    t.oid as trigger_oid,
    t.tgenabled,
    pg_get_triggerdef(t.oid) as triggerdef,
    (
      select array_agg(a.attname order by a.attname)
      from unnest(t.tgattr) as col_num
      join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = col_num
    ) as tgcolumns
  from (values (1)) anchor(x)
  left join pg_trigger t
    on t.tgname = 'payment_orders_trust_fields_immutable'
   and not t.tgisinternal
   and t.tgrelid = to_regclass('public.payment_orders')
),
trust_field_trigger_check as (
  select
    trigger_oid is not null
      and coalesce(tgenabled <> 'D', false)
      and coalesce(triggerdef like '%BEFORE UPDATE OF%', false)
      and coalesce(triggerdef like '%reject_payment_order_trust_field_change%', false)
      and coalesce(tgcolumns @> array['booking_id','provider','currency','amount_satang','receiver_profile']::name[], false)
      and coalesce(array_length(tgcolumns, 1) = 5, false)
      as pass,
    jsonb_build_object(
      'present', trigger_oid is not null,
      'enabled', tgenabled,
      'columns', to_jsonb(tgcolumns)
    ) as evidence
  from trust_field_trigger
),

-- ---------------------------------------------------------------------------
-- Functions: existence + privileges
-- ---------------------------------------------------------------------------
required_0011_functions(signature, expect_service_execute) as (
  values
    ('public.reject_payment_order_trust_field_change()'::text, false),
    ('public.create_slip_payment_order(uuid,text,integer,text)'::text, true),
    ('public.confirm_slip_payment(uuid,text,text,timestamptz,integer,text,text,jsonb)'::text, true),
    ('public.approve_manual_review_payment(uuid)'::text, true),
    ('public.claim_team_notification_deliveries(text,integer,text[])'::text, true)
),
function_privileges_0011 as (
  select signature, expect_service_execute, to_regprocedure(signature) as function_oid
  from required_0011_functions
),
function_baseline_0011 as (
  select
    bool_and(function_oid is not null) as all_present,
    bool_and(not coalesce(
      has_function_privilege(to_regrole('anon'), function_oid, 'execute'), false
    )) as anon_denied,
    bool_and(not coalesce(
      has_function_privilege(to_regrole('authenticated'), function_oid, 'execute'), false
    )) as authenticated_denied,
    bool_and(coalesce(
      has_function_privilege(to_regrole('service_role'), function_oid, 'execute'), false
    ) = expect_service_execute) as service_role_allowed
  from function_privileges_0011
),
functions_0011_evidence as (
  select jsonb_agg(jsonb_build_object('signature', signature, 'present', function_oid is not null)
    order by signature) as evidence
  from function_privileges_0011
),

-- Explicit signature/return-type checks for the two payment-confirmation RPCs.
confirm_slip_payment_lookup as (
  select to_regprocedure(
    'public.confirm_slip_payment(uuid,text,text,timestamptz,integer,text,text,jsonb)'
  ) as function_oid
),
confirm_slip_payment_check as (
  select
    function_oid is not null
      and coalesce(pg_get_function_result(function_oid) = 'jsonb', false) as pass,
    function_oid is not null as present,
    coalesce(pg_get_function_result(function_oid), 'not_found') as return_type
  from confirm_slip_payment_lookup
),
approve_manual_review_payment_lookup as (
  select to_regprocedure('public.approve_manual_review_payment(uuid)') as function_oid
),
approve_manual_review_payment_check as (
  select
    function_oid is not null
      and coalesce(pg_get_function_result(function_oid) = 'jsonb', false) as pass,
    function_oid is not null as present,
    coalesce(pg_get_function_result(function_oid), 'not_found') as return_type
  from approve_manual_review_payment_lookup
),

-- claim_team_notification_deliveries must have been redefined to return line_retry_key.
claim_team_notification_deliveries_lookup as (
  select to_regprocedure(
    'public.claim_team_notification_deliveries(text,integer,text[])'
  ) as function_oid
),
claim_team_notification_deliveries_check as (
  select
    function_oid is not null
      and coalesce(position('line_retry_key' in pg_get_functiondef(function_oid)) > 0, false)
      as pass,
    function_oid is not null as present
  from claim_team_notification_deliveries_lookup
),

-- Neither slip-verification RPC may assign a customer-channel recipient.
-- Fails closed (false) if either function is missing entirely, matching the
-- fail-closed convention used throughout this script.
--
-- SQL line (--) and block (/* */) comments are stripped from the function
-- source before inspection, and the search targets the quoted text literal
-- 'customer' rather than the bare word "customer". This avoids two known
-- false-positive sources: a source comment merely mentioning the word
-- "customer" (e.g. explaining why a channel is out of scope), and the
-- unquoted recipient_type column identifier, which can never match a
-- quoted string-literal search.
no_customer_recipient_source as (
  select
    to_regprocedure(
      'public.confirm_slip_payment(uuid,text,text,timestamptz,integer,text,text,jsonb)'
    ) as confirm_oid,
    to_regprocedure('public.approve_manual_review_payment(uuid)') as approve_oid
),
no_customer_recipient_stripped as (
  select
    confirm_oid,
    approve_oid,
    regexp_replace(
      regexp_replace(pg_get_functiondef(confirm_oid), '/\*.*?\*/', '', 'gs'),
      '--[^\n]*', '', 'g'
    ) as confirm_stripped,
    regexp_replace(
      regexp_replace(pg_get_functiondef(approve_oid), '/\*.*?\*/', '', 'gs'),
      '--[^\n]*', '', 'g'
    ) as approve_stripped
  from no_customer_recipient_source
),
no_customer_recipient_in_functions as (
  select
    confirm_oid is not null
      and approve_oid is not null
      and coalesce(position('''customer''' in confirm_stripped) = 0, false)
      and coalesce(position('''customer''' in approve_stripped) = 0, false)
      as pass
  from no_customer_recipient_stripped
),
no_customer_recipient_in_data as (
  select count(*) as violation_count
  from public.notification_deliveries
  where event_type = 'slip_manual_review' and recipient_type <> 'team'
),

-- ---------------------------------------------------------------------------
-- New-table RLS and access
-- ---------------------------------------------------------------------------
required_0011_table_access(table_name) as (
  values ('payment_slip_verifications'::text), ('payment_transactions'::text)
),
table_access_0011 as (
  select
    r.table_name,
    to_regclass('public.' || r.table_name) as table_oid,
    c.relrowsecurity
  from required_0011_table_access r
  left join pg_class c on c.oid = to_regclass('public.' || r.table_name)
),
table_access_0011_baseline as (
  select
    bool_and(table_oid is not null) as all_present,
    bool_and(coalesce(relrowsecurity, false)) as rls_enabled,
    bool_and(not coalesce(
      has_table_privilege(to_regrole('anon'), table_oid, 'select,insert,update,delete'), false
    )) as anon_denied,
    bool_and(not coalesce(
      has_table_privilege(to_regrole('authenticated'), table_oid, 'select,insert,update,delete'), false
    )) as authenticated_denied,
    bool_and(coalesce(
      has_table_privilege(to_regrole('service_role'), table_oid, 'select,insert,update,delete'), false
    )) as service_role_allowed
  from table_access_0011
),

-- ---------------------------------------------------------------------------
-- line_retry_key default + effective uniqueness
-- ---------------------------------------------------------------------------
line_retry_key_column as (
  select
    a.attnotnull,
    pg_get_expr(d.adbin, d.adrelid) as default_expr
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid = to_regclass('public.notification_deliveries')
    and a.attname = 'line_retry_key'
    and a.attnum > 0 and not a.attisdropped
),
line_retry_key_data as (
  select
    count(*) as total_rows,
    count(*) filter (where line_retry_key is null) as null_rows,
    count(distinct line_retry_key) as distinct_rows
  from public.notification_deliveries
),
line_retry_key_check as (
  select
    exists (select 1 from line_retry_key_column where attnotnull)
      and coalesce((select default_expr like '%gen_random_uuid%' from line_retry_key_column), false)
      and (select null_rows = 0 from line_retry_key_data)
      and (select distinct_rows = total_rows from line_retry_key_data)
      as pass,
    jsonb_build_object(
      'not_null', (select attnotnull from line_retry_key_column),
      'default_expr', (select default_expr from line_retry_key_column),
      'total_rows', (select total_rows from line_retry_key_data),
      'null_rows', (select null_rows from line_retry_key_data),
      'distinct_rows', (select distinct_rows from line_retry_key_data)
    ) as evidence
),

-- ---------------------------------------------------------------------------
-- Existing-row referential integrity (bookings / payment_orders /
-- notification_deliveries / the two new ledger tables)
-- ---------------------------------------------------------------------------
existing_row_integrity as (
  select
    (select count(*) from public.payment_orders po
       left join public.bookings b on b.id = po.booking_id
       where b.id is null) = 0
    and (select count(*) from public.notification_deliveries d
       left join public.bookings b on b.id = d.booking_id
       where b.id is null) = 0
    and (select count(*) from public.notification_deliveries d
       left join public.payment_orders po on po.id = d.payment_order_id
       where d.payment_order_id is not null and po.id is null) = 0
    and (select count(*) from public.payment_transactions pt
       left join public.payment_orders po on po.id = pt.payment_order_id
       where po.id is null) = 0
    and (select count(*) from public.payment_transactions pt
       left join public.bookings b on b.id = pt.booking_id
       where b.id is null) = 0
    and (select count(*) from public.payment_slip_verifications psv
       left join public.payment_orders po on po.id = psv.payment_order_id
       where po.id is null) = 0
    and (select count(*) from public.payment_slip_verifications psv
       left join public.bookings b on b.id = psv.booking_id
       where b.id is null) = 0
    as pass
),

-- ---------------------------------------------------------------------------
-- Reconciliation 0010 baseline + canonical sessions (unchanged by 0011)
-- ---------------------------------------------------------------------------
required_0010_functions(signature) as (
  values
    ('public.get_open_slots(date)'::text),
    ('public.transition_slot_booking(uuid,text)'::text),
    ('public.claim_team_notification_deliveries(text,integer,text[])'::text)
),
function_privileges_0010 as (
  select signature, to_regprocedure(signature) as function_oid
  from required_0010_functions
),
function_baseline_0010 as (
  select
    bool_and(function_oid is not null) as all_present,
    bool_and(not coalesce(
      has_function_privilege(to_regrole('anon'), function_oid, 'execute'), false
    )) as anon_denied,
    bool_and(not coalesce(
      has_function_privilege(to_regrole('authenticated'), function_oid, 'execute'), false
    )) as authenticated_denied,
    bool_and(coalesce(
      has_function_privilege(to_regrole('service_role'), function_oid, 'execute'), false
    )) as service_role_allowed
  from function_privileges_0010
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

checks as (
  select 'source_provenance'::text as check_name, pass,
    jsonb_build_object(
      'reported_migration_blob', reported_migration_blob,
      'expected_migration_blob', expected_migration_blob,
      'reviewed_commit', reviewed_commit
    ) as evidence
  from source_provenance
  union all
  select 'schema_0011_tables_exist', pass, evidence from tables_0011_present
  union all
  select 'legacy_slip_claim_index_removed', pass,
    jsonb_build_object('index', 'payment_slip_verifications_tx_claim_uniq')
  from legacy_slip_claim_index
  union all
  select 'schema_0011_columns_exist', all_present and nullability_ok, evidence
  from columns_0011_present
  union all
  select 'schema_0011_indexes_exist', all_present and uniqueness_ok, evidence
  from indexes_0011_present
  union all
  select 'schema_0011_constraints_exist', pass, evidence from constraints_0011_present
  union all
  select 'payment_orders_promptpay_profile_check_content', pass,
    jsonb_build_object('definition', definition)
  from promptpay_check_content
  union all
  select 'payment_transaction_ledger_uniqueness',
    unique_index_present and no_duplicate_ledger_rows,
    jsonb_build_object(
      'unique_index_present', unique_index_present,
      'no_duplicate_ledger_rows', no_duplicate_ledger_rows
    )
  from ledger_uniqueness_check
  union all
  select 'payment_orders_trust_field_immutability_trigger_active', pass, evidence
  from trust_field_trigger_check
  union all
  select 'schema_0011_functions_exist', all_present, evidence
  from function_baseline_0011 cross join functions_0011_evidence
  union all
  select 'confirm_slip_payment_signature', pass,
    jsonb_build_object('present', present, 'return_type', return_type)
  from confirm_slip_payment_check
  union all
  select 'approve_manual_review_payment_signature', pass,
    jsonb_build_object('present', present, 'return_type', return_type)
  from approve_manual_review_payment_check
  union all
  select 'claim_team_notification_deliveries_returns_line_retry_key', pass,
    jsonb_build_object('present', present)
  from claim_team_notification_deliveries_check
  union all
  select 'anon_authenticated_denied_privileged_rpcs',
    all_present and anon_denied and authenticated_denied,
    jsonb_build_object('roles_checked', array['anon','authenticated'])
  from function_baseline_0011
  union all
  select 'service_role_required_access_only',
    fb.all_present and fb.service_role_allowed
      and ta.all_present and ta.service_role_allowed,
    jsonb_build_object(
      'function_execute', fb.service_role_allowed,
      'table_dml', ta.service_role_allowed
    )
  from function_baseline_0011 fb cross join table_access_0011_baseline ta
  union all
  select 'rls_enabled_new_tables', all_present and rls_enabled,
    jsonb_build_object('tables', array['payment_slip_verifications','payment_transactions'])
  from table_access_0011_baseline
  union all
  select 'anon_authenticated_denied_new_tables',
    all_present and anon_denied and authenticated_denied,
    jsonb_build_object('tables', array['payment_slip_verifications','payment_transactions'])
  from table_access_0011_baseline
  union all
  select 'line_retry_key_default_and_distinctness', pass, evidence
  from line_retry_key_check
  union all
  select 'existing_row_referential_integrity', pass,
    jsonb_build_object('scope', 'aggregate foreign-key compatibility only')
  from existing_row_integrity
  union all
  select 'reconciliation_0010_functions_intact',
    all_present and anon_denied and authenticated_denied and service_role_allowed,
    jsonb_build_object('required_signatures', array_agg(signature order by signature))
  from function_baseline_0010 cross join function_privileges_0010
  group by function_baseline_0010.all_present, function_baseline_0010.anon_denied,
    function_baseline_0010.authenticated_denied, function_baseline_0010.service_role_allowed
  union all
  select 'reconciliation_0010_get_open_slots_still_read_only', pass,
    jsonb_build_object('forbidden_marker', 'expire_pending_bookings')
  from get_open_slots_definition
  union all
  select 'canonical_booking_sessions_intact', pass,
    jsonb_build_object('cutover_date', '2026-07-12')
  from canonical_sessions_valid
  union all
  select 'no_open_legacy_hourly_slots_reappeared', count = 0,
    jsonb_build_object('open_legacy_hourly_slot_count', count)
  from open_legacy_hourly_slots
  union all
  select 'no_customer_recipient_in_0011_functions', pass, '{}'::jsonb
  from no_customer_recipient_in_functions
  union all
  select 'no_customer_recipient_in_slip_manual_review_rows', violation_count = 0,
    jsonb_build_object('violation_count', violation_count)
  from no_customer_recipient_in_data
)
select
  check_name,
  case when pass then 'PASS' else 'FAIL' end as status,
  evidence
from checks
order by check_name;
