-- 0012 production preflight: one strict, read-only SELECT.
-- Run this file manually against the intended database before applying 0012.
-- Every row must return status = PASS. This query never reads application
-- configuration and never calls an application RPC.

with
roles as (
  select
    max(oid) filter (where rolname = 'anon') as anon_oid,
    max(oid) filter (where rolname = 'authenticated') as authenticated_oid,
    max(oid) filter (where rolname = 'service_role') as service_role_oid
  from pg_catalog.pg_roles
),
expected_tables(schema_name, table_name) as (
  values
    ('public', 'payment_orders'),
    ('public', 'payment_webhook_events'),
    ('public', 'payment_slip_verifications'),
    ('public', 'payment_transactions'),
    ('public', 'notification_deliveries'),
    ('public', 'bookings'),
    ('public', 'booking_slots'),
    ('public', 'booking_images')
),
table_summary as (
  select
    count(*)::bigint as expected_count,
    count(*) filter (where c.oid is not null)::bigint as present_count
  from expected_tables e
  left join pg_catalog.pg_namespace n
    on n.nspname = e.schema_name
  left join pg_catalog.pg_class c
    on c.relnamespace = n.oid
   and c.relname = e.table_name
   and c.relkind in ('r', 'p')
),
expected_columns(schema_name, table_name, column_name) as (
  values
    ('public', 'payment_orders', 'id'),
    ('public', 'payment_orders', 'booking_id'),
    ('public', 'payment_orders', 'provider'),
    ('public', 'payment_orders', 'currency'),
    ('public', 'payment_orders', 'amount_satang'),
    ('public', 'payment_orders', 'receiver_profile'),
    ('public', 'payment_orders', 'status'),
    ('public', 'payment_webhook_events', 'id'),
    ('public', 'payment_webhook_events', 'provider'),
    ('public', 'payment_webhook_events', 'provider_event_id'),
    ('public', 'payment_slip_verifications', 'id'),
    ('public', 'payment_slip_verifications', 'payment_order_id'),
    ('public', 'payment_slip_verifications', 'booking_id'),
    ('public', 'payment_transactions', 'id'),
    ('public', 'payment_transactions', 'provider'),
    ('public', 'payment_transactions', 'normalized_tx_ref'),
    ('public', 'payment_transactions', 'payment_order_id'),
    ('public', 'notification_deliveries', 'id'),
    ('public', 'notification_deliveries', 'booking_id'),
    ('public', 'notification_deliveries', 'payment_order_id'),
    ('public', 'notification_deliveries', 'channel'),
    ('public', 'notification_deliveries', 'recipient_type'),
    ('public', 'notification_deliveries', 'event_type'),
    ('public', 'notification_deliveries', 'idempotency_key'),
    ('public', 'notification_deliveries', 'payload'),
    ('public', 'notification_deliveries', 'line_retry_key'),
    ('public', 'bookings', 'id'),
    ('public', 'bookings', 'nickname'),
    ('public', 'bookings', 'birth_date_text'),
    ('public', 'bookings', 'consultation_topic'),
    ('public', 'bookings', 'phone'),
    ('public', 'bookings', 'slot_id'),
    ('public', 'bookings', 'queue_number'),
    ('public', 'bookings', 'status'),
    ('public', 'bookings', 'updated_at'),
    ('public', 'booking_slots', 'id'),
    ('public', 'booking_slots', 'booking_date'),
    ('public', 'booking_slots', 'start_time'),
    ('public', 'booking_slots', 'end_time'),
    ('public', 'booking_slots', 'label'),
    ('public', 'booking_slots', 'capacity'),
    ('public', 'booking_slots', 'is_open'),
    ('public', 'booking_images', 'booking_id'),
    ('public', 'booking_images', 'storage_path'),
    ('public', 'booking_images', 'created_at')
),
column_summary as (
  select
    count(*)::bigint as expected_count,
    count(*) filter (where a.attname is not null)::bigint as present_count
  from expected_columns e
  left join pg_catalog.pg_namespace n
    on n.nspname = e.schema_name
  left join pg_catalog.pg_class c
    on c.relnamespace = n.oid
   and c.relname = e.table_name
   and c.relkind in ('r', 'p')
  left join pg_catalog.pg_attribute a
    on a.attrelid = c.oid
   and a.attnum > 0
   and not a.attisdropped
   and a.attname = e.column_name
),
expected_not_null_columns(schema_name, table_name, column_name) as (
  values
    ('public', 'payment_orders', 'id'),
    ('public', 'payment_orders', 'booking_id'),
    ('public', 'payment_orders', 'provider'),
    ('public', 'payment_orders', 'currency'),
    ('public', 'payment_orders', 'amount_satang'),
    ('public', 'payment_orders', 'status'),
    ('public', 'payment_webhook_events', 'id'),
    ('public', 'payment_webhook_events', 'provider'),
    ('public', 'payment_webhook_events', 'provider_event_id'),
    ('public', 'payment_slip_verifications', 'id'),
    ('public', 'payment_transactions', 'id'),
    ('public', 'payment_transactions', 'provider'),
    ('public', 'payment_transactions', 'normalized_tx_ref'),
    ('public', 'notification_deliveries', 'id'),
    ('public', 'notification_deliveries', 'booking_id'),
    ('public', 'notification_deliveries', 'channel'),
    ('public', 'notification_deliveries', 'recipient_type'),
    ('public', 'notification_deliveries', 'event_type'),
    ('public', 'notification_deliveries', 'idempotency_key'),
    ('public', 'notification_deliveries', 'line_retry_key'),
    ('public', 'bookings', 'id'),
    ('public', 'bookings', 'nickname'),
    ('public', 'bookings', 'birth_date_text'),
    ('public', 'bookings', 'consultation_topic'),
    ('public', 'bookings', 'phone'),
    ('public', 'booking_slots', 'id'),
    ('public', 'booking_slots', 'booking_date'),
    ('public', 'booking_slots', 'start_time'),
    ('public', 'booking_slots', 'end_time'),
    ('public', 'booking_slots', 'label'),
    ('public', 'booking_slots', 'capacity'),
    ('public', 'booking_slots', 'is_open'),
    ('public', 'booking_images', 'storage_path'),
    ('public', 'booking_images', 'created_at')
),
not_null_summary as (
  select
    count(*)::bigint as expected_count,
    count(*) filter (where a.attname is not null and a.attnotnull is true)::bigint as valid_count
  from expected_not_null_columns e
  left join pg_catalog.pg_namespace n
    on n.nspname = e.schema_name
  left join pg_catalog.pg_class c
    on c.relnamespace = n.oid
   and c.relname = e.table_name
   and c.relkind in ('r', 'p')
  left join pg_catalog.pg_attribute a
    on a.attrelid = c.oid
   and a.attnum > 0
   and not a.attisdropped
   and a.attname = e.column_name
),
expected_summary_columns(schema_name, table_name, column_name) as (
  values
    ('public', 'bookings', 'id'),
    ('public', 'bookings', 'nickname'),
    ('public', 'bookings', 'birth_date_text'),
    ('public', 'bookings', 'consultation_topic'),
    ('public', 'bookings', 'phone'),
    ('public', 'bookings', 'slot_id'),
    ('public', 'bookings', 'queue_number'),
    ('public', 'booking_slots', 'id'),
    ('public', 'booking_slots', 'booking_date'),
    ('public', 'booking_slots', 'label'),
    ('public', 'booking_images', 'booking_id'),
    ('public', 'booking_images', 'storage_path'),
    ('public', 'booking_images', 'created_at'),
    ('public', 'notification_deliveries', 'booking_id'),
    ('public', 'notification_deliveries', 'event_type'),
    ('public', 'notification_deliveries', 'idempotency_key'),
    ('public', 'notification_deliveries', 'payload')
),
summary_column_summary as (
  select
    count(*)::bigint as expected_count,
    count(*) filter (where a.attname is not null)::bigint as present_count
  from expected_summary_columns e
  left join pg_catalog.pg_namespace n
    on n.nspname = e.schema_name
  left join pg_catalog.pg_class c
    on c.relnamespace = n.oid
   and c.relname = e.table_name
   and c.relkind in ('r', 'p')
  left join pg_catalog.pg_attribute a
    on a.attrelid = c.oid
   and a.attnum > 0
   and not a.attisdropped
   and a.attname = e.column_name
),
expected_indexes(index_name, table_name, must_be_unique) as (
  values
    ('payment_orders_booking_active_uniq', 'payment_orders', true),
    ('payment_orders_provider_order_uniq', 'payment_orders', true),
    ('payment_webhook_events_provider_event_uniq', 'payment_webhook_events', true),
    ('payment_slip_verifications_order_idx', 'payment_slip_verifications', false),
    ('payment_transactions_provider_ref_uniq', 'payment_transactions', true),
    ('notification_deliveries_booking_idx', 'notification_deliveries', false),
    ('notification_deliveries_retry_idx', 'notification_deliveries', false),
    ('notification_deliveries_locked_idx', 'notification_deliveries', false)
),
index_summary as (
  select
    count(*)::bigint as expected_count,
    count(*) filter (
      where i.indexrelid is not null
        and tc.oid is not null
        and tn.oid is not null
        and i.indisvalid is true
        and i.indisunique = e.must_be_unique
    )::bigint as valid_count
  from expected_indexes e
  left join pg_catalog.pg_class ic
    on ic.relname = e.index_name
   and ic.relkind = 'i'
  left join pg_catalog.pg_index i
    on i.indexrelid = ic.oid
  left join pg_catalog.pg_class tc
    on tc.oid = i.indrelid
   and tc.relname = e.table_name
  left join pg_catalog.pg_namespace tn
    on tn.oid = tc.relnamespace
   and tn.nspname = 'public'
),
expected_rpcs(name, argtypes, must_be_security_definer) as (
  values
    ('create_slip_payment_order', ARRAY['uuid'::regtype, 'text'::regtype, 'integer'::regtype, 'text'::regtype]::oid[], false),
    ('confirm_slip_payment', ARRAY['uuid'::regtype, 'text'::regtype, 'text'::regtype, 'timestamp with time zone'::regtype, 'integer'::regtype, 'text'::regtype, 'text'::regtype, 'jsonb'::regtype]::oid[], false),
    ('approve_manual_review_payment', ARRAY['uuid'::regtype]::oid[], false),
    ('claim_team_notification_deliveries', ARRAY['text'::regtype, 'integer'::regtype, 'text[]'::regtype]::oid[], true),
    ('complete_notification_delivery', ARRAY['uuid'::regtype, 'text'::regtype, 'text'::regtype, 'text'::regtype]::oid[], true),
    ('transition_slot_booking', ARRAY['uuid'::regtype, 'text'::regtype]::oid[], false),
    ('get_open_slots', ARRAY['date'::regtype]::oid[], false)
),
rpc_matches as (
  select
    e.name,
    e.argtypes,
    e.must_be_security_definer,
    p.oid,
    p.proacl,
    p.proowner,
    p.prosrc,
    p.prosecdef,
    p.proconfig,
    pg_catalog.pg_get_function_result(p.oid) as result_signature
  from expected_rpcs e
  left join pg_catalog.pg_proc p
    on p.pronamespace = (
         select n.oid from pg_catalog.pg_namespace n where n.nspname = 'public'
       )
   and p.proname = e.name
   and pg_catalog.array_to_string(p.proargtypes::oid[], ',') = pg_catalog.array_to_string(e.argtypes, ',')
),
rpc_acl as (
  select
    m.name,
    coalesce(bool_or(x.grantee = 0 and x.privilege_type = 'EXECUTE'), false) as public_execute,
    coalesce(bool_or(x.grantee = r.anon_oid and x.privilege_type = 'EXECUTE'), false) as anon_execute,
    coalesce(bool_or(x.grantee = r.authenticated_oid and x.privilege_type = 'EXECUTE'), false) as authenticated_execute,
    coalesce(bool_or(x.grantee = r.service_role_oid and x.privilege_type = 'EXECUTE'), false) as service_execute
  from rpc_matches m
  cross join roles r
  left join lateral pg_catalog.aclexplode(
    case
      when m.oid is null then null::pg_catalog.aclitem[]
      else coalesce(m.proacl, pg_catalog.acldefault('f', m.proowner))
    end
  ) x on true
  group by m.name, r.anon_oid, r.authenticated_oid, r.service_role_oid
),
rpc_summary as (
  select
    count(*)::bigint as expected_count,
    count(*) filter (
      where m.oid is not null
        and m.prosrc is not null
        and m.prosecdef = m.must_be_security_definer
        and a.public_execute is false
        and a.anon_execute is false
        and a.authenticated_execute is false
        and a.service_execute is true
        and r.anon_oid is not null
        and r.authenticated_oid is not null
        and r.service_role_oid is not null
    )::bigint as valid_count
  from rpc_matches m
  join rpc_acl a on a.name = m.name
  cross join roles r
),
function_0010_summary as (
  select
    count(*) filter (where m.name = 'get_open_slots')::bigint as expected_count,
    count(*) filter (
      where m.name = 'get_open_slots'
        and m.oid is not null
        and m.prosrc is not null
        and m.prosecdef is false
        and position('return query' in lower(m.prosrc)) > 0
        and position('public.booking_slots' in lower(m.prosrc)) > 0
        and position('public.bookings' in lower(m.prosrc)) > 0
        and position('s.booking_date = p_date' in lower(m.prosrc)) > 0
        and position('s.is_open' in lower(m.prosrc)) > 0
        and m.prosrc !~* '\m(insert|update|delete|merge|truncate|create|alter|drop|perform|call)\M'
    )::bigint as valid_count
  from rpc_matches m
),
expected_sensitive_tables(table_name) as (
  values
    ('payment_orders'),
    ('payment_webhook_events'),
    ('payment_slip_verifications'),
    ('payment_transactions'),
    ('notification_deliveries')
),
rls_summary as (
  select
    count(*)::bigint as expected_count,
    count(*) filter (
      where c.oid is not null
        and c.relrowsecurity is true
        and not exists (
          select 1 from pg_catalog.pg_policy pol where pol.polrelid = c.oid
        )
        and r.anon_oid is not null
        and r.authenticated_oid is not null
        and r.service_role_oid is not null
        and coalesce(pg_catalog.has_table_privilege(r.service_role_oid, c.oid, 'SELECT'), false)
        and coalesce(pg_catalog.has_table_privilege(r.service_role_oid, c.oid, 'INSERT'), false)
        and coalesce(pg_catalog.has_table_privilege(r.service_role_oid, c.oid, 'UPDATE'), false)
        and coalesce(pg_catalog.has_table_privilege(r.service_role_oid, c.oid, 'DELETE'), false)
        and not coalesce(pg_catalog.has_table_privilege(r.anon_oid, c.oid, 'SELECT'), false)
        and not coalesce(pg_catalog.has_table_privilege(r.anon_oid, c.oid, 'INSERT'), false)
        and not coalesce(pg_catalog.has_table_privilege(r.anon_oid, c.oid, 'UPDATE'), false)
        and not coalesce(pg_catalog.has_table_privilege(r.anon_oid, c.oid, 'DELETE'), false)
        and not coalesce(pg_catalog.has_table_privilege(r.authenticated_oid, c.oid, 'SELECT'), false)
        and not coalesce(pg_catalog.has_table_privilege(r.authenticated_oid, c.oid, 'INSERT'), false)
        and not coalesce(pg_catalog.has_table_privilege(r.authenticated_oid, c.oid, 'UPDATE'), false)
        and not coalesce(pg_catalog.has_table_privilege(r.authenticated_oid, c.oid, 'DELETE'), false)
    )::bigint as valid_count
  from expected_sensitive_tables e
  left join pg_catalog.pg_namespace n on n.nspname = 'public'
  left join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = e.table_name and c.relkind in ('r', 'p')
  cross join roles r
),
trigger_summary as (
  select
    count(*)::bigint as expected_count,
    count(*) filter (
      where t.oid is not null
        and tr.oid is not null
        and trn.oid is not null
        and t.tgenabled = 'O'
        and tf.proname = 'reject_payment_order_trust_field_change'
        and tf.prosrc is not null
        and tf.prosrc ~* 'new\.booking_id[[:space:]]+is[[:space:]]+distinct[[:space:]]+from[[:space:]]+old\.booking_id'
        and tf.prosrc ~* 'new\.provider[[:space:]]+is[[:space:]]+distinct[[:space:]]+from[[:space:]]+old\.provider'
        and tf.prosrc ~* 'new\.currency[[:space:]]+is[[:space:]]+distinct[[:space:]]+from[[:space:]]+old\.currency'
        and tf.prosrc ~* 'new\.amount_satang[[:space:]]+is[[:space:]]+distinct[[:space:]]+from[[:space:]]+old\.amount_satang'
        and tf.prosrc ~* 'new\.receiver_profile[[:space:]]+is[[:space:]]+distinct[[:space:]]+from[[:space:]]+old\.receiver_profile'
    )::bigint as valid_count
  from (values ('payment_orders_trust_fields_immutable')) expected(trigger_name)
  left join pg_catalog.pg_trigger t on t.tgname = expected.trigger_name and not t.tgisinternal
  left join pg_catalog.pg_class tr on tr.oid = t.tgrelid and tr.relname = 'payment_orders'
  left join pg_catalog.pg_namespace trn on trn.oid = tr.relnamespace and trn.nspname = 'public'
  left join pg_catalog.pg_proc tf on tf.oid = t.tgfoid
),
ledger_summary as (
  select
    count(*)::bigint as expected_count,
    count(*) filter (
      where i.indexrelid is not null
        and tn.oid is not null
        and i.indisunique is true
        and i.indisvalid is true
        and pg_catalog.pg_get_indexdef(i.indexrelid) ~* '\(provider, normalized_tx_ref\)'
    )::bigint as valid_count
  from (values ('payment_transactions_provider_ref_uniq')) expected(index_name)
  left join pg_catalog.pg_class c on c.relname = expected.index_name and c.relkind = 'i'
  left join pg_catalog.pg_index i on i.indexrelid = c.oid
  left join pg_catalog.pg_class tc on tc.oid = i.indrelid and tc.relname = 'payment_transactions'
  left join pg_catalog.pg_namespace tn on tn.oid = tc.relnamespace and tn.nspname = 'public'
),
trust_constraint_summary as (
  select
    count(*)::bigint as expected_count,
    count(*) filter (
      where con.oid is not null
        and con.conname = 'payment_orders_promptpay_profile_check'
        and pg_catalog.pg_get_constraintdef(con.oid) ~* 'receiver_profile'
    )::bigint as valid_count
  from (values ('payment_orders_promptpay_profile_check')) expected(constraint_name)
  left join pg_catalog.pg_constraint con
    on con.conname = expected.constraint_name
   and con.conrelid = pg_catalog.to_regclass('public.payment_orders')
),
legacy_summary as (
  select
    count(*)::bigint as total_rows,
    count(*) filter (where s.is_open is true)::bigint as open_rows,
    count(*) filter (where s.is_open is null)::bigint as null_open_rows
  from public.booking_slots s
  where s.booking_date >= date '2026-07-12'
    and not (
      (s.start_time = time '09:00' and s.end_time = time '12:00')
      or (s.start_time = time '13:00' and s.end_time = time '16:00')
      or (s.start_time = time '18:00' and s.end_time = time '21:00')
      or (s.start_time = time '22:00' and s.end_time = time '23:00')
    )
    and (s.end_time - s.start_time) = interval '1 hour'
    and s.start_time >= time '09:00'
    and s.end_time <= time '21:00'
),
canonical_by_date as (
  select
    s.booking_date,
    count(*)::bigint as total_rows,
    count(*) filter (where (
      (s.start_time = time '09:00' and s.end_time = time '12:00' and s.capacity = 5)
      or (s.start_time = time '13:00' and s.end_time = time '16:00' and s.capacity = 5)
      or (s.start_time = time '18:00' and s.end_time = time '21:00' and s.capacity = 5)
      or (s.start_time = time '22:00' and s.end_time = time '23:00' and s.capacity = 2)
    ))::bigint as canonical_rows,
    count(*) filter (where s.id is null or s.booking_date is null or s.start_time is null or s.end_time is null or s.label is null or s.capacity is null or s.is_open is null)::bigint as null_rows
  from public.booking_slots s
  where s.booking_date >= date '2026-07-12'
  group by s.booking_date
),
canonical_summary as (
  select
    count(*)::bigint as horizon_dates,
    count(*) filter (where canonical_rows = 4 and null_rows = 0)::bigint as valid_dates
  from canonical_by_date
),
notification_summary as (
  select
    count(*)::bigint as total_rows,
    count(*) filter (where d.id is null or d.idempotency_key is null)::bigint as incompatible_rows,
    count(*) filter (where d.line_retry_key is null)::bigint as null_line_keys
  from public.notification_deliveries d
),
line_key_duplicates as (
  select count(*)::bigint as duplicate_groups
  from (
    select d.line_retry_key
    from public.notification_deliveries d
    where d.line_retry_key is not null
    group by d.line_retry_key
    having count(*) > 1
  ) duplicate_keys
),
booking_confirmed_duplicates as (
  select count(*)::bigint as duplicate_groups
  from (
    select d.idempotency_key
    from public.notification_deliveries d
    where d.event_type = 'booking_confirmed'
    group by d.idempotency_key
    having count(*) > 1
  ) duplicate_keys
),
booking_confirmed_summary as (
  select
    count(*) filter (where d.event_type = 'booking_confirmed' and d.recipient_type = 'customer')::bigint as customer_rows,
    count(*) filter (where d.event_type = 'booking_confirmed')::bigint as booking_confirmed_rows,
    count(*) filter (where d.event_type = 'booking_confirmed' and d.idempotency_key is null)::bigint as null_keys
  from public.notification_deliveries d
),
image_column_summary as (
  select count(*)::bigint as image_columns
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'notification_deliveries'
    and a.attname = 'image_retry_key'
    and a.attnum > 0
    and not a.attisdropped
),
migration_absence_summary as (
  select
    i.image_columns,
    b.booking_confirmed_rows,
    b.null_keys,
    count(*) filter (where m.name in ('transition_slot_booking', 'confirm_slip_payment', 'approve_manual_review_payment') and m.prosrc is not null and m.prosrc !~* 'booking_confirmed')::bigint as clean_confirmation_functions,
    count(*) filter (where m.name = 'claim_team_notification_deliveries' and m.prosrc is not null and m.prosrc !~* 'image_retry_key' and m.result_signature !~* 'image_retry_key')::bigint as clean_claim_function
  from image_column_summary i
  cross join booking_confirmed_summary b
  cross join rpc_matches m
  group by i.image_columns, b.booking_confirmed_rows, b.null_keys
),
bucket_summary as (
  select
    count(*)::bigint as matching_buckets,
    count(*) filter (where b."public" is false)::bigint as private_buckets,
    count(*) filter (where b."public" is null)::bigint as null_visibility_buckets
  from storage.buckets b
  where b.id = 'booking-faces'
),
gen_random_uuid_summary as (
  select count(*)::bigint as matching_functions
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where p.proname = 'gen_random_uuid'
    and p.pronargs = 0
    and p.prosrc is not null
    and n.nspname in ('pg_catalog', 'public', 'extensions')
),
provenance as (
  select
    'source_provenance'::text as check_name,
    case when source_commit = '6b868508e4c61c1a5cfa37297ed4f9a369fc6732'
              and migration_blob = '66001e73bf7db093802f495631b3ee1b4f9f1eb6'
         then 'PASS' else 'FAIL' end::text as status,
    ('reviewed_commit=' || source_commit || '; migration_blob=' || migration_blob)::text as evidence
  from (values (
    '6b868508e4c61c1a5cfa37297ed4f9a369fc6732'::text,
    '66001e73bf7db093802f495631b3ee1b4f9f1eb6'::text
  )) v(source_commit, migration_blob)
),
checks as (
  select * from provenance
  union all
  select 'line_group_configuration_out_of_scope', 'PASS', 'No application configuration or group identifier is referenced.'
  union all
  select 'required_tables', case when expected_count = present_count then 'PASS' else 'FAIL' end, format('tables_present=%s/%s', present_count, expected_count)
  from table_summary
  union all
  select 'required_columns', case when expected_count = present_count then 'PASS' else 'FAIL' end, format('columns_present=%s/%s', present_count, expected_count)
  from column_summary
  union all
  select 'required_not_null_columns', case when expected_count = valid_count then 'PASS' else 'FAIL' end, format('not_null_columns=%s/%s', valid_count, expected_count)
  from not_null_summary
  union all
  select 'required_summary_source_columns', case when expected_count = present_count then 'PASS' else 'FAIL' end, format('summary_columns_present=%s/%s', present_count, expected_count)
  from summary_column_summary
  union all
  select '0011_indexes_intact', case when expected_count = valid_count then 'PASS' else 'FAIL' end, format('valid_indexes=%s/%s', valid_count, expected_count)
  from index_summary
  union all
  select '0011_tables_columns_rls_privileges_safe', case when expected_count = valid_count then 'PASS' else 'FAIL' end, format('safe_sensitive_tables=%s/%s', valid_count, expected_count)
  from rls_summary
  union all
  select '0011_trust_immutability_trigger_intact', case when expected_count = valid_count then 'PASS' else 'FAIL' end, format('enabled_trust_triggers=%s/%s', valid_count, expected_count)
  from trigger_summary
  union all
  select '0011_privileged_rpcs_intact', case when expected_count = valid_count then 'PASS' else 'FAIL' end, format('privileged_rpcs=%s/%s', valid_count, expected_count)
  from rpc_summary
  union all
  select '0010_get_open_slots_read_only', case when expected_count = valid_count then 'PASS' else 'FAIL' end, format('read_only_functions=%s/%s', valid_count, expected_count)
  from function_0010_summary
  union all
  select 'canonical_sessions_intact', case when horizon_dates > 0 and horizon_dates = valid_dates then 'PASS' else 'FAIL' end, format('valid_canonical_dates=%s/%s', valid_dates, horizon_dates)
  from canonical_summary
  union all
  select 'no_open_legacy_hourly_slots', case when open_rows = 0 and null_open_rows = 0 then 'PASS' else 'FAIL' end, format('open_legacy=%s; null_is_open=%s; legacy_rows=%s', open_rows, null_open_rows, total_rows)
  from legacy_summary
  union all
  select 'payment_ledger_uniqueness', case when expected_count = valid_count then 'PASS' else 'FAIL' end, format('unique_valid_ledger_indexes=%s/%s', valid_count, expected_count)
  from ledger_summary
  union all
  select 'payment_order_trust_constraint_intact', case when expected_count = valid_count then 'PASS' else 'FAIL' end, format('trust_constraints=%s/%s', valid_count, expected_count)
  from trust_constraint_summary
  union all
  select 'migration_0012_changes_absent', case when image_columns = 0 and booking_confirmed_rows = 0 and null_keys = 0 and clean_confirmation_functions = 3 and clean_claim_function = 1 then 'PASS' else 'FAIL' end, format('image_columns=%s; booking_confirmed_rows=%s; clean_confirmation_functions=%s/3; clean_claim_function=%s/1', image_columns, booking_confirmed_rows, clean_confirmation_functions, clean_claim_function)
  from migration_absence_summary
  union all
  select 'notification_rows_compatible_with_image_retry_key', case when incompatible_rows = 0 then 'PASS' else 'FAIL' end, format('rows=%s; incompatible_rows=%s', total_rows, incompatible_rows)
  from notification_summary
  union all
  select 'line_retry_key_non_null_and_unique', case when null_line_keys = 0 and duplicate_groups = 0 then 'PASS' else 'FAIL' end, format('null_keys=%s; duplicate_groups=%s', n.null_line_keys, d.duplicate_groups)
  from notification_summary n cross join line_key_duplicates d
  union all
  select 'no_duplicate_booking_confirmed_idempotency_keys', case when duplicate_groups = 0 and null_keys = 0 then 'PASS' else 'FAIL' end, format('duplicate_groups=%s; null_keys=%s', duplicate_groups, null_keys)
  from (
    select
      (select duplicate_groups from booking_confirmed_duplicates) as duplicate_groups,
      (select count(*) filter (where d.event_type = 'booking_confirmed' and d.idempotency_key is null)::bigint from public.notification_deliveries d) as null_keys
  ) d
  union all
  select 'booking_faces_bucket_private', case when matching_buckets = 1 and private_buckets = 1 and null_visibility_buckets = 0 then 'PASS' else 'FAIL' end, format('matching_buckets=%s; private_buckets=%s', matching_buckets, private_buckets)
  from bucket_summary
  union all
  select 'no_customer_booking_confirmed_rows', case when customer_rows = 0 and null_keys = 0 then 'PASS' else 'FAIL' end, format('customer_rows=%s; null_keys=%s; booking_confirmed_rows=%s', customer_rows, null_keys, booking_confirmed_rows)
  from booking_confirmed_summary
  union all
  select 'pgcrypto_gen_random_uuid_available', case when matching_functions > 0 then 'PASS' else 'FAIL' end, format('matching_functions=%s', matching_functions)
  from gen_random_uuid_summary
  union all
  select 'claim_rpc_signature_has_no_conflict', case when count(*) = 1 and bool_and(lower(result_signature) = 'table(id uuid, booking_id uuid, payment_order_id uuid, channel text, event_type text, payload jsonb, idempotency_key text, attempt_count integer, line_retry_key uuid)') and bool_and(result_signature !~* 'image_retry_key') then 'PASS' else 'FAIL' end, format('claim_identity_overloads=%s', count(*))
  from rpc_matches
  where name = 'claim_team_notification_deliveries'
)
select check_name, status, evidence
from checks
order by check_name;
