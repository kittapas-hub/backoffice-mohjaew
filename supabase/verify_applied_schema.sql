-- Mohjaew Gate A catalog report (REL-002)
--
-- Authorized manual execution only. This file is one catalog/reporting query.
-- It invokes no application function and requests no booking, payment,
-- customer, image, or message rows.
--
-- Capture the single result table in full for both staging and production.
-- Migration 0011 remains blocked until reconciliation migration 0010 is verified.

with
database_identity as (
  select
    10 as ordinal,
    'database_identity'::text as section,
    jsonb_build_object(
      'database_name', current_database(),
      'report_role', current_user,
      'server_version', current_setting('server_version'),
      'server_version_number', current_setting('server_version_num'),
      'complete_server_version', version()
    ) as result_json
),
migration_ledger_relations as (
  select
    20 as ordinal,
    'migration_ledger_relations'::text as section,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'schema_name', n.nspname,
          'relation_name', c.relname,
          'relation_kind', case c.relkind
            when 'r' then 'table'
            when 'p' then 'partitioned_table'
            when 'v' then 'view'
            when 'm' then 'materialized_view'
            else c.relkind::text
          end,
          'owner', pg_get_userbyid(c.relowner)
        ) order by n.nspname, c.relname
      ),
      '[]'::jsonb
    ) as result_json
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('supabase_migrations', 'schema_migrations', 'public')
    and c.relname in ('schema_migrations', 'migrations')
),
migration_ledger_columns as (
  select
    30 as ordinal,
    'migration_ledger_columns'::text as section,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'schema_name', n.nspname,
          'relation_name', c.relname,
          'ordinal_position', a.attnum,
          'column_name', a.attname,
          'formatted_type', format_type(a.atttypid, a.atttypmod),
          'nullable', not a.attnotnull
        ) order by n.nspname, c.relname, a.attnum
      ),
      '[]'::jsonb
    ) as result_json
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid
  where n.nspname in ('supabase_migrations', 'schema_migrations', 'public')
    and c.relname in ('schema_migrations', 'migrations')
    and a.attnum > 0
    and not a.attisdropped
),
migration_ledger_candidates(schema_name, relation_name) as (
  values
    ('supabase_migrations', 'schema_migrations'),
    ('schema_migrations', 'schema_migrations'),
    ('public', 'schema_migrations'),
    ('public', 'migrations')
),
migration_ledger_rows as (
  select
    40 as ordinal,
    'migration_ledger_rows'::text as section,
    jsonb_agg(
      jsonb_build_object(
        'schema_name', schema_name,
        'relation_name', relation_name,
        'present', to_regclass(format('%I.%I', schema_name, relation_name)) is not null,
        'complete_rows', (
          case
            when to_regclass(format('%I.%I', schema_name, relation_name)) is null
              then null
            else query_to_xml(
              format('select * from %I.%I order by 1', schema_name, relation_name),
              true,
              false,
              ''
            )
          end
        )::text
      ) order by schema_name, relation_name
    ) as result_json
  from migration_ledger_candidates
),
migration_signatures(migration, object_kind, object_name) as (
  values
    ('0001', 'extension', 'pgcrypto'),
    ('0001', 'table', 'booking_sessions'),
    ('0001', 'table', 'bookings'),
    ('0001', 'table', 'booking_images'),
    ('0001', 'table', 'line_webhook_events'),
    ('0002', 'table', 'booking_slots'),
    ('0002', 'table', 'api_rate_limits'),
    ('0002', 'function', 'create_booking'),
    ('0002', 'function', 'transition_slot_booking'),
    ('0002', 'function', 'expire_pending_bookings'),
    ('0002', 'function', 'get_open_slots'),
    ('0002', 'function', 'record_rate_hit'),
    ('0003', 'table', 'booking_face_uploads'),
    ('0004', 'function', 'claim_expired_face_uploads_for_cleanup'),
    ('0004', 'function', 'complete_face_upload_cleanup'),
    ('0005', 'table', 'payment_orders'),
    ('0005', 'table', 'payment_webhook_events'),
    ('0005', 'table', 'notification_deliveries'),
    ('0005', 'function', 'create_payment_order'),
    ('0005', 'function', 'process_payment_paid_event'),
    ('0005', 'function', 'expire_due_payment_orders'),
    ('0007', 'function', 'claim_team_notification_deliveries'),
    ('0007', 'function', 'complete_notification_delivery'),
    ('0011', 'table', 'payment_slip_verifications'),
    ('0011', 'table', 'payment_transactions'),
    ('0011', 'function', 'confirm_slip_payment')
),
migration_signature_rows as (
  select
    s.migration,
    s.object_kind,
    s.object_name,
    case s.object_kind
      when 'extension' then exists (
        select 1
        from pg_extension e
        where e.extname = s.object_name
      )
      when 'table' then exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = s.object_name
          and c.relkind in ('r', 'p')
      )
      when 'function' then exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = s.object_name
      )
    end as present
  from migration_signatures s
),
migration_signature_presence as (
  select
    50 as ordinal,
    'migration_signature_presence'::text as section,
    coalesce(
      jsonb_agg(to_jsonb(r) order by r.migration, r.object_kind, r.object_name),
      '[]'::jsonb
    ) as result_json
  from migration_signature_rows r
),
replacement_function_rows as (
  select
    p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    position('expire_pending_bookings' in pg_get_functiondef(p.oid)) > 0
      as calls_expire_pending_bookings,
    position('hold_expired' in pg_get_functiondef(p.oid)) > 0
      as has_hold_expired_guard,
    pg_get_functiondef(p.oid) as complete_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('get_open_slots', 'transition_slot_booking')
),
replacement_function_markers as (
  select
    60 as ordinal,
    'replacement_function_markers'::text as section,
    coalesce(
      jsonb_agg(to_jsonb(r) order by r.function_name, r.identity_arguments),
      '[]'::jsonb
    ) as result_json
  from replacement_function_rows r
),
notification_lease_rows as (
  select
    a.attname as column_name,
    format_type(a.atttypid, a.atttypmod) as formatted_type,
    not a.attnotnull as nullable
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'notification_deliveries'
    and a.attname in ('locked_by', 'locked_at')
    and a.attnum > 0
    and not a.attisdropped
),
notification_lease_columns as (
  select
    70 as ordinal,
    'notification_lease_columns'::text as section,
    coalesce(
      jsonb_agg(to_jsonb(r) order by r.column_name),
      '[]'::jsonb
    ) as result_json
  from notification_lease_rows r
),
queue_session_cutover_0009 as (
  select
    80 as ordinal,
    'queue_session_cutover_0009'::text as section,
    jsonb_build_object(
      'booking_slots_present', to_regclass('public.booking_slots') is not null,
      'aggregate_result', (
        case
          when to_regclass('public.booking_slots') is null then null
          else query_to_xml(
            $report$
              with horizon as (
                select count(distinct booking_date)::bigint as seeded_dates
                from public.booking_slots
                where booking_date >= date '2026-07-12'
              ), observed as (
                select
                  count(*) filter (
                    where (start_time, end_time) in (
                      ('09:00'::time, '12:00'::time),
                      ('13:00'::time, '16:00'::time),
                      ('18:00'::time, '21:00'::time),
                      ('22:00'::time, '23:00'::time)
                    )
                  ) as canonical_session_rows,
                  count(*) filter (
                    where (start_time, end_time) in (
                      ('09:00'::time, '12:00'::time),
                      ('13:00'::time, '16:00'::time),
                      ('18:00'::time, '21:00'::time)
                    ) and capacity = 5
                  ) + count(*) filter (
                    where start_time = '22:00'::time
                      and end_time = '23:00'::time
                      and capacity = 2
                  ) as canonical_rows_with_expected_capacity,
                  count(*) filter (
                    where (end_time - start_time) = interval '1 hour'
                      and start_time >= '09:00'::time
                      and end_time <= '21:00'::time
                      and (start_time, end_time) not in (
                        ('09:00'::time, '12:00'::time),
                        ('13:00'::time, '16:00'::time),
                        ('18:00'::time, '21:00'::time),
                        ('22:00'::time, '23:00'::time)
                      )
                  ) as legacy_hourly_rows,
                  count(*) filter (
                    where (end_time - start_time) = interval '1 hour'
                      and start_time >= '09:00'::time
                      and end_time <= '21:00'::time
                      and (start_time, end_time) not in (
                        ('09:00'::time, '12:00'::time),
                        ('13:00'::time, '16:00'::time),
                        ('18:00'::time, '21:00'::time),
                        ('22:00'::time, '23:00'::time)
                      )
                      and is_open
                  ) as unexpected_open_legacy_hourly_rows
                from public.booking_slots
                where booking_date >= date '2026-07-12'
              )
              select
                horizon.seeded_dates,
                horizon.seeded_dates * 4 as expected_canonical_session_rows,
                observed.canonical_session_rows,
                observed.canonical_rows_with_expected_capacity,
                observed.legacy_hourly_rows,
                observed.unexpected_open_legacy_hourly_rows
              from horizon
              cross join observed
            $report$,
            true,
            false,
            ''
          )
        end
      )::text
    ) as result_json
),
relevant_relation_rows as (
  select
    c.relname as relation_name,
    case c.relkind
      when 'r' then 'table'
      when 'p' then 'partitioned_table'
      when 'v' then 'view'
      when 'm' then 'materialized_view'
      else c.relkind::text
    end as relation_kind,
    pg_get_userbyid(c.relowner) as owner
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'booking_sessions', 'bookings', 'booking_images', 'line_webhook_events',
      'booking_slots', 'api_rate_limits', 'booking_face_uploads',
      'payment_orders', 'payment_webhook_events', 'notification_deliveries',
      'payment_slip_verifications', 'payment_transactions'
    )
),
relevant_relations as (
  select
    90 as ordinal,
    'relevant_relations'::text as section,
    coalesce(
      jsonb_agg(to_jsonb(r) order by r.relation_name),
      '[]'::jsonb
    ) as result_json
  from relevant_relation_rows r
),
column_rows as (
  select
    c.relname as table_name,
    a.attnum as ordinal_position,
    a.attname as column_name,
    format_type(a.atttypid, a.atttypmod) as formatted_type,
    t.typname as underlying_type,
    not a.attnotnull as nullable,
    pg_get_expr(d.adbin, d.adrelid) as default_expression,
    col_description(c.oid, a.attnum) as column_comment
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid
  join pg_type t on t.oid = a.atttypid
  left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
  where n.nspname = 'public'
    and c.relname in (
      'booking_sessions', 'bookings', 'booking_images', 'line_webhook_events',
      'booking_slots', 'api_rate_limits', 'booking_face_uploads',
      'payment_orders', 'payment_webhook_events', 'notification_deliveries',
      'payment_slip_verifications', 'payment_transactions'
    )
    and a.attnum > 0
    and not a.attisdropped
),
columns_section as (
  select
    100 as ordinal,
    'columns'::text as section,
    coalesce(
      jsonb_agg(to_jsonb(r) order by r.table_name, r.ordinal_position),
      '[]'::jsonb
    ) as result_json
  from column_rows r
),
constraint_rows as (
  select
    rel.relname as table_name,
    con.conname as constraint_name,
    case con.contype
      when 'c' then 'check'
      when 'u' then 'unique'
      when 'p' then 'primary_key'
      when 'f' then 'foreign_key'
      when 'x' then 'exclusion'
      else con.contype::text
    end as constraint_type,
    con.convalidated as validated,
    pg_get_constraintdef(con.oid, true) as complete_definition
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
  where n.nspname = 'public'
    and rel.relname in (
      'booking_sessions', 'bookings', 'booking_images', 'line_webhook_events',
      'booking_slots', 'api_rate_limits', 'booking_face_uploads',
      'payment_orders', 'payment_webhook_events', 'notification_deliveries',
      'payment_slip_verifications', 'payment_transactions'
    )
),
constraints_section as (
  select
    110 as ordinal,
    'constraints'::text as section,
    coalesce(
      jsonb_agg(
        to_jsonb(r) order by r.table_name, r.constraint_type, r.constraint_name
      ),
      '[]'::jsonb
    ) as result_json
  from constraint_rows r
),
foreign_key_rows as (
  select
    source_rel.relname as source_table,
    con.conname as constraint_name,
    target_ns.nspname as target_schema,
    target_rel.relname as target_table,
    pg_get_constraintdef(con.oid, true) as complete_definition
  from pg_constraint con
  join pg_class source_rel on source_rel.oid = con.conrelid
  join pg_namespace source_ns on source_ns.oid = source_rel.relnamespace
  join pg_class target_rel on target_rel.oid = con.confrelid
  join pg_namespace target_ns on target_ns.oid = target_rel.relnamespace
  where source_ns.nspname = 'public'
    and con.contype = 'f'
    and source_rel.relname in (
      'booking_sessions', 'bookings', 'booking_images', 'line_webhook_events',
      'booking_slots', 'api_rate_limits', 'booking_face_uploads',
      'payment_orders', 'payment_webhook_events', 'notification_deliveries',
      'payment_slip_verifications', 'payment_transactions'
    )
),
foreign_keys as (
  select
    120 as ordinal,
    'foreign_keys'::text as section,
    coalesce(
      jsonb_agg(to_jsonb(r) order by r.source_table, r.constraint_name),
      '[]'::jsonb
    ) as result_json
  from foreign_key_rows r
),
index_rows as (
  select
    tablename as table_name,
    indexname as index_name,
    indexdef as complete_definition
  from pg_indexes
  where schemaname = 'public'
    and tablename in (
      'booking_sessions', 'bookings', 'booking_images', 'line_webhook_events',
      'booking_slots', 'api_rate_limits', 'booking_face_uploads',
      'payment_orders', 'payment_webhook_events', 'notification_deliveries',
      'payment_slip_verifications', 'payment_transactions'
    )
),
indexes_section as (
  select
    130 as ordinal,
    'indexes'::text as section,
    coalesce(
      jsonb_agg(to_jsonb(r) order by r.table_name, r.index_name),
      '[]'::jsonb
    ) as result_json
  from index_rows r
),
rls_status_rows as (
  select
    c.relname as table_name,
    c.relrowsecurity as rls_enabled,
    c.relforcerowsecurity as rls_forced
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
),
rls_status as (
  select
    140 as ordinal,
    'rls_status'::text as section,
    coalesce(
      jsonb_agg(to_jsonb(r) order by r.table_name),
      '[]'::jsonb
    ) as result_json
  from rls_status_rows r
),
rls_policy_rows as (
  select
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
  from pg_policies
  where schemaname = 'public'
),
rls_policies as (
  select
    150 as ordinal,
    'rls_policies'::text as section,
    coalesce(
      jsonb_agg(to_jsonb(r) order by r.tablename, r.policyname),
      '[]'::jsonb
    ) as result_json
  from rls_policy_rows r
),
relevant_rpc_rows as (
  select
    p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    pg_get_function_result(p.oid) as result_type,
    pg_get_userbyid(p.proowner) as owner,
    p.prosecdef as security_definer,
    p.provolatile as volatility_code,
    p.proparallel as parallel_code,
    p.proconfig as function_settings,
    pg_get_functiondef(p.oid) as complete_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (
      p.proname in (
        'create_booking', 'transition_slot_booking', 'expire_pending_bookings',
        'get_open_slots', 'record_rate_hit',
        'claim_expired_face_uploads_for_cleanup',
        'complete_face_upload_cleanup', 'create_payment_order',
        'process_payment_paid_event', 'expire_due_payment_orders',
        'claim_team_notification_deliveries',
        'complete_notification_delivery', 'confirm_slip_payment'
      )
      or p.proname ~ '(booking|payment|notification|slot|rate|face)'
    )
),
relevant_rpcs as (
  select
    160 as ordinal,
    'relevant_rpcs'::text as section,
    coalesce(
      jsonb_agg(to_jsonb(r) order by r.function_name, r.identity_arguments),
      '[]'::jsonb
    ) as result_json
  from relevant_rpc_rows r
),
rpc_acl_rows as (
  select
    p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    case
      when acl.grantee = 0 then 'PUBLIC'
      else pg_get_userbyid(acl.grantee)
    end as grantee,
    pg_get_userbyid(acl.grantor) as grantor,
    acl.privilege_type,
    acl.is_grantable
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
  where n.nspname = 'public'
    and (
      p.proname in (
        'create_booking', 'transition_slot_booking', 'expire_pending_bookings',
        'get_open_slots', 'record_rate_hit',
        'claim_expired_face_uploads_for_cleanup',
        'complete_face_upload_cleanup', 'create_payment_order',
        'process_payment_paid_event', 'expire_due_payment_orders',
        'claim_team_notification_deliveries',
        'complete_notification_delivery', 'confirm_slip_payment'
      )
      or p.proname ~ '(booking|payment|notification|slot|rate|face)'
    )
),
rpc_acl_entries as (
  select
    170 as ordinal,
    'rpc_acl_entries'::text as section,
    coalesce(
      jsonb_agg(
        to_jsonb(r)
        order by r.function_name, r.identity_arguments, r.grantee, r.privilege_type
      ),
      '[]'::jsonb
    ) as result_json
  from rpc_acl_rows r
),
rpc_effective_role_rows as (
  select
    p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    case when to_regrole('anon') is null then null
      else has_function_privilege(to_regrole('anon'), p.oid, 'execute')
    end as anon_execute,
    case when to_regrole('authenticated') is null then null
      else has_function_privilege(to_regrole('authenticated'), p.oid, 'execute')
    end as authenticated_execute,
    case when to_regrole('service_role') is null then null
      else has_function_privilege(to_regrole('service_role'), p.oid, 'execute')
    end as service_role_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (
      p.proname in (
        'create_booking', 'transition_slot_booking', 'expire_pending_bookings',
        'get_open_slots', 'record_rate_hit',
        'claim_expired_face_uploads_for_cleanup',
        'complete_face_upload_cleanup', 'create_payment_order',
        'process_payment_paid_event', 'expire_due_payment_orders',
        'claim_team_notification_deliveries',
        'complete_notification_delivery', 'confirm_slip_payment'
      )
      or p.proname ~ '(booking|payment|notification|slot|rate|face)'
    )
),
rpc_effective_role_access as (
  select
    180 as ordinal,
    'rpc_effective_role_access'::text as section,
    coalesce(
      jsonb_agg(to_jsonb(r) order by r.function_name, r.identity_arguments),
      '[]'::jsonb
    ) as result_json
  from rpc_effective_role_rows r
),
table_acl_rows as (
  select
    c.relname as table_name,
    case
      when acl.grantee = 0 then 'PUBLIC'
      else pg_get_userbyid(acl.grantee)
    end as grantee,
    pg_get_userbyid(acl.grantor) as grantor,
    acl.privilege_type,
    acl.is_grantable
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
  where n.nspname = 'public'
    and c.relname in (
      'booking_sessions', 'bookings', 'booking_images', 'line_webhook_events',
      'booking_slots', 'api_rate_limits', 'booking_face_uploads',
      'payment_orders', 'payment_webhook_events', 'notification_deliveries',
      'payment_slip_verifications', 'payment_transactions'
    )
),
table_acl_entries as (
  select
    190 as ordinal,
    'table_acl_entries'::text as section,
    coalesce(
      jsonb_agg(
        to_jsonb(r) order by r.table_name, r.grantee, r.privilege_type
      ),
      '[]'::jsonb
    ) as result_json
  from table_acl_rows r
),
storage_bucket_presence as (
  select
    200 as ordinal,
    'storage_bucket_presence'::text as section,
    jsonb_build_object(
      'storage_buckets_present', to_regclass('storage.buckets') is not null,
      'bucket_metadata', (
        case
          when to_regclass('storage.buckets') is null then null
          else query_to_xml(
            'select id, name, public from storage.buckets order by id',
            true,
            false,
            ''
          )
        end
      )::text
    ) as result_json
),
report as (
  select * from database_identity
  union all select * from migration_ledger_relations
  union all select * from migration_ledger_columns
  union all select * from migration_ledger_rows
  union all select * from migration_signature_presence
  union all select * from replacement_function_markers
  union all select * from notification_lease_columns
  union all select * from queue_session_cutover_0009
  union all select * from relevant_relations
  union all select * from columns_section
  union all select * from constraints_section
  union all select * from foreign_keys
  union all select * from indexes_section
  union all select * from rls_status
  union all select * from rls_policies
  union all select * from relevant_rpcs
  union all select * from rpc_acl_entries
  union all select * from rpc_effective_role_access
  union all select * from table_acl_entries
  union all select * from storage_bucket_presence
)
select section, result_json
from report
order by ordinal;
