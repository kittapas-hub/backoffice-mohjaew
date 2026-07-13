-- ============================================================================
-- READ-ONLY applied-schema verification report (REL-002)
-- ============================================================================
-- Purpose: produce the authoritative evidence of what is actually applied in
-- an environment (staging / production) so it can be reconciled against
-- repository migrations 0001–0010 and committed as a migration ledger.
--
-- SAFETY: this script consists exclusively of SELECT statements against
-- pg_catalog / information_schema / storage.buckets. It performs no INSERT,
-- UPDATE, DELETE, ALTER, CREATE, DROP, GRANT, REVOKE, TRUNCATE, and calls no
-- application RPC. It is safe to run with a read-only role. Run each
-- statement in the Supabase SQL editor (or psql) and capture ALL output.
--
-- DO NOT run against production without explicit authorization.

-- ----------------------------------------------------------------------------
-- 1. Migration ledger (present only if migrations were ever applied via the
--    Supabase CLI; this project historically applied SQL manually, so an
--    empty/missing table is itself a finding to record).
-- ----------------------------------------------------------------------------
select 'ledger' as section, n.nspname, c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('supabase_migrations', 'schema_migrations')
    or c.relname in ('schema_migrations', 'migrations');

-- If the previous query returned supabase_migrations.schema_migrations:
-- select 'ledger_rows' as section, version, name
--   from supabase_migrations.schema_migrations order by version;

-- ----------------------------------------------------------------------------
-- 2. Signature-object presence matrix: which repo migration left its marks.
-- ----------------------------------------------------------------------------
with sig(migration, kind, name) as (
  values
    ('0001', 'table',    'booking_sessions'),
    ('0001', 'table',    'bookings'),
    ('0001', 'table',    'booking_images'),
    ('0001', 'table',    'line_webhook_events'),
    ('0002', 'table',    'booking_slots'),
    ('0002', 'table',    'api_rate_limits'),
    ('0002', 'function', 'create_booking'),
    ('0002', 'function', 'transition_slot_booking'),
    ('0002', 'function', 'expire_pending_bookings'),
    ('0002', 'function', 'get_open_slots'),
    ('0002', 'function', 'record_rate_hit'),
    ('0003', 'table',    'booking_face_uploads'),
    ('0004', 'function', 'claim_expired_face_uploads_for_cleanup'),
    ('0004', 'function', 'complete_face_upload_cleanup'),
    ('0005', 'table',    'payment_orders'),
    ('0005', 'table',    'payment_webhook_events'),
    ('0005', 'table',    'notification_deliveries'),
    ('0005', 'function', 'create_payment_order'),
    ('0005', 'function', 'process_payment_paid_event'),
    ('0005', 'function', 'expire_due_payment_orders'),
    ('0007', 'function', 'claim_team_notification_deliveries'),
    ('0007', 'function', 'complete_notification_delivery'),
    ('0010', 'table',    'payment_slip_verifications'),
    ('0010', 'table',    'payment_transactions'),
    ('0010', 'function', 'confirm_slip_payment')
)
select 'presence' as section, s.migration, s.kind, s.name,
       case s.kind
         when 'table' then exists (
           select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = s.name and c.relkind = 'r')
         when 'function' then exists (
           select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = s.name)
       end as present
  from sig s
 order by s.migration, s.kind, s.name;

-- Version-discriminating checks for migrations that only REPLACE objects:
-- 0006: get_open_slots is read-only iff its body no longer calls
--        expire_pending_bookings.
-- 0008: transition_slot_booking rejects lapsed holds iff its body contains
--        'hold_expired'.
select 'replaced_fn_versions' as section, p.proname,
       position('expire_pending_bookings' in pg_get_functiondef(p.oid)) > 0
         as calls_expire_pending_bookings, -- true ⇒ pre-0006 get_open_slots
       position('hold_expired' in pg_get_functiondef(p.oid)) > 0
         as has_hold_expired_guard         -- true ⇒ 0008 applied
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('get_open_slots', 'transition_slot_booking');

-- 0007: lease columns on notification_deliveries.
select '0007_lease_columns' as section, column_name
  from information_schema.columns
 where table_schema = 'public' and table_name = 'notification_deliveries'
   and column_name in ('locked_by', 'locked_at');

-- 0009: data-only cutover — canonical session slots exist on/after 2026-07-12
-- and hourly slots on/after that date are closed.
select '0009_session_cutover' as section,
       count(*) filter (where (start_time, end_time) in
         (('09:00'::time,'12:00'::time),('13:00'::time,'16:00'::time),
          ('18:00'::time,'21:00'::time),('22:00'::time,'23:00'::time)))
         as session_slots,
       count(*) filter (where (end_time - start_time) = interval '1 hour'
                          and is_open) as open_hourly_slots
  from public.booking_slots
 where booking_date >= date '2026-07-12';

-- ----------------------------------------------------------------------------
-- 3. Full column inventory of every relevant table.
-- ----------------------------------------------------------------------------
select 'columns' as section, table_name, ordinal_position, column_name,
       data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name in (
     'booking_sessions','bookings','booking_images','line_webhook_events',
     'booking_slots','api_rate_limits','booking_face_uploads',
     'payment_orders','payment_webhook_events','notification_deliveries',
     'payment_slip_verifications','payment_transactions')
 order by table_name, ordinal_position;

-- ----------------------------------------------------------------------------
-- 4. Constraints (checks, uniques, FKs) on those tables — the bookings and
--    payment_orders status CHECKs discriminate 0002 vs 0005 baselines.
-- ----------------------------------------------------------------------------
select 'constraints' as section, rel.relname as table_name, con.conname,
       pg_get_constraintdef(con.oid) as definition
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
 where n.nspname = 'public'
   and rel.relname in (
     'booking_sessions','bookings','booking_images','line_webhook_events',
     'booking_slots','api_rate_limits','booking_face_uploads',
     'payment_orders','payment_webhook_events','notification_deliveries',
     'payment_slip_verifications','payment_transactions')
 order by rel.relname, con.conname;

-- ----------------------------------------------------------------------------
-- 5. Indexes on those tables (partial unique indexes carry invariants).
-- ----------------------------------------------------------------------------
select 'indexes' as section, tablename, indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and tablename in (
     'booking_sessions','bookings','booking_images','line_webhook_events',
     'booking_slots','api_rate_limits','booking_face_uploads',
     'payment_orders','payment_webhook_events','notification_deliveries',
     'payment_slip_verifications','payment_transactions')
 order by tablename, indexname;

-- ----------------------------------------------------------------------------
-- 6. Complete definitions of every relevant RPC (capture full output).
-- ----------------------------------------------------------------------------
select 'functions' as section, p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer,
       pg_get_functiondef(p.oid) as definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in (
     'create_booking','transition_slot_booking','expire_pending_bookings',
     'get_open_slots','record_rate_hit',
     'claim_expired_face_uploads_for_cleanup','complete_face_upload_cleanup',
     'create_payment_order','process_payment_paid_event',
     'expire_due_payment_orders',
     'claim_team_notification_deliveries','complete_notification_delivery',
     'confirm_slip_payment')
 order by p.proname;

-- ----------------------------------------------------------------------------
-- 7. Function privileges for anon / authenticated / service_role.
-- ----------------------------------------------------------------------------
select 'fn_privileges' as section, p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       has_function_privilege('anon', p.oid, 'execute')          as anon_execute,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
       has_function_privilege('service_role', p.oid, 'execute')  as service_role_execute
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in (
     'create_booking','transition_slot_booking','expire_pending_bookings',
     'get_open_slots','record_rate_hit',
     'claim_expired_face_uploads_for_cleanup','complete_face_upload_cleanup',
     'create_payment_order','process_payment_paid_event',
     'expire_due_payment_orders',
     'claim_team_notification_deliveries','complete_notification_delivery',
     'confirm_slip_payment')
 order by p.proname;

-- ----------------------------------------------------------------------------
-- 8. Table privileges for anon / authenticated / service_role.
-- ----------------------------------------------------------------------------
select 'table_privileges' as section, table_name, grantee,
       string_agg(privilege_type, ',' order by privilege_type) as privileges
  from information_schema.role_table_grants
 where table_schema = 'public'
   and grantee in ('anon', 'authenticated', 'service_role')
   and table_name in (
     'booking_sessions','bookings','booking_images','line_webhook_events',
     'booking_slots','api_rate_limits','booking_face_uploads',
     'payment_orders','payment_webhook_events','notification_deliveries',
     'payment_slip_verifications','payment_transactions')
 group by table_name, grantee
 order by table_name, grantee;

-- ----------------------------------------------------------------------------
-- 9. RLS status and policies.
-- ----------------------------------------------------------------------------
select 'rls_status' as section, c.relname as table_name,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by c.relname;

select 'rls_policies' as section, schemaname, tablename, policyname,
       permissive, roles, cmd, qual, with_check
  from pg_policies
 where schemaname = 'public'
 order by tablename, policyname;

-- ----------------------------------------------------------------------------
-- 10. Storage buckets (0001 creates 'booking-faces'; Phase 1 stores no slips).
-- ----------------------------------------------------------------------------
select 'buckets' as section, id, name, public
  from storage.buckets
 order by id;

-- ============================================================================
-- Output REQUIRED before migration 0010 can be finalized:
--   * Sections 1–2 for BOTH staging and production, establishing exactly
--     which of 0001–0009 are applied (in particular: whether get_open_slots
--     is the 0006 read-only version, whether transition_slot_booking has the
--     0008 hold_expired guard, whether 0007 lease columns exist, and whether
--     the 0009 session cutover ran).
--   * Section 4's bookings_status_check and payment_orders_status_check
--     definitions (0005 baseline evidence).
--   * Sections 6–9 confirming no drift from the repository definitions and
--     no unexpected policies/grants.
--   * Confirmation that payment_slip_verifications / payment_transactions /
--     confirm_slip_payment do NOT yet exist.
-- The reconciled result must be committed as an authoritative ledger
-- (docs/migration-ledger.md) before 0010 is numbered/final and before any
-- environment applies it.
-- ============================================================================
