-- Read-only verification for 0010_reconcile_0006_0009.sql.
-- Returns one result table and no booking or customer details.

with
legacy_slots as (
  select
    s.id,
    s.booking_date,
    s.is_open
  from public.booking_slots s
  where s.booking_date >= date '2026-07-12'
    and not (
         (s.start_time = '09:00'::time and s.end_time = '12:00'::time)
      or (s.start_time = '13:00'::time and s.end_time = '16:00'::time)
      or (s.start_time = '18:00'::time and s.end_time = '21:00'::time)
      or (s.start_time = '22:00'::time and s.end_time = '23:00'::time)
    )
    and (s.end_time - s.start_time) = interval '1 hour'
    and s.start_time >= '09:00'::time
    and s.end_time <= '21:00'::time
),
legacy_slot_totals as (
  select
    booking_date,
    count(*) as legacy_slot_count,
    count(*) filter (where is_open) as open_legacy_slot_count
  from legacy_slots
  group by booking_date
),
legacy_booking_status_totals as (
  select
    slots.booking_date,
    bookings.status as booking_status,
    count(*) as booking_count
  from legacy_slots slots
  join public.bookings bookings on bookings.slot_id = slots.id
  group by slots.booking_date, bookings.status
),
legacy_booking_totals as (
  select
    booking_date,
    sum(booking_count) as referencing_booking_count,
    jsonb_object_agg(
      booking_status,
      booking_count
      order by booking_status
    ) as booking_status_counts
  from legacy_booking_status_totals
  group by booking_date
),
legacy_slot_booking_impact_0009 as (
  select
    10 as ordinal,
    'legacy_slot_booking_impact_0009'::text as section,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'booking_date', slots.booking_date,
          'legacy_slot_count', slots.legacy_slot_count,
          'open_legacy_slot_count', slots.open_legacy_slot_count,
          'referencing_booking_count',
            coalesce(bookings.referencing_booking_count, 0),
          'booking_status_counts',
            coalesce(bookings.booking_status_counts, '{}'::jsonb)
        )
        order by slots.booking_date
      ),
      '[]'::jsonb
    ) as result_json
  from legacy_slot_totals slots
  left join legacy_booking_totals bookings
    on bookings.booking_date = slots.booking_date
),
seeded_dates as (
  select distinct booking_date
  from public.booking_slots
  where booking_date >= date '2026-07-12'
),
cutover_date_rows as (
  select
    dates.booking_date,
    count(sessions.id) filter (
      where (
           (sessions.start_time = '09:00'::time and sessions.end_time = '12:00'::time)
        or (sessions.start_time = '13:00'::time and sessions.end_time = '16:00'::time)
        or (sessions.start_time = '18:00'::time and sessions.end_time = '21:00'::time)
        or (sessions.start_time = '22:00'::time and sessions.end_time = '23:00'::time)
      )
    ) as canonical_session_count,
    count(sessions.id) filter (
      where (
           (sessions.start_time = '09:00'::time and sessions.end_time = '12:00'::time and sessions.capacity = 5)
        or (sessions.start_time = '13:00'::time and sessions.end_time = '16:00'::time and sessions.capacity = 5)
        or (sessions.start_time = '18:00'::time and sessions.end_time = '21:00'::time and sessions.capacity = 5)
        or (sessions.start_time = '22:00'::time and sessions.end_time = '23:00'::time and sessions.capacity = 2)
      )
    ) as canonical_rows_with_expected_capacity,
    coalesce(max(legacy.open_legacy_slot_count), 0) as unexpected_open_legacy_slot_count
  from seeded_dates dates
  left join public.booking_slots sessions
    on sessions.booking_date = dates.booking_date
  left join legacy_slot_totals legacy
    on legacy.booking_date = dates.booking_date
  group by dates.booking_date
),
queue_session_cutover_by_date_0009 as (
  select
    20 as ordinal,
    'queue_session_cutover_by_date_0009'::text as section,
    coalesce(
      jsonb_agg(to_jsonb(rows) order by rows.booking_date),
      '[]'::jsonb
    ) as result_json
  from cutover_date_rows rows
),
reconciliation_function_rows as (
  select
    p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    pg_get_userbyid(p.proowner) as owner,
    p.prosecdef as security_definer,
    p.proconfig as function_settings,
    case
      when p.proname = 'get_open_slots' then
        position('expire_pending_bookings' in pg_get_functiondef(p.oid)) = 0
      else null
    end as get_open_slots_is_read_only,
    case
      when p.proname = 'transition_slot_booking' then
        position('hold_expired' in pg_get_functiondef(p.oid)) > 0
      else null
    end as hold_expired_guard_present,
    case when to_regrole('anon') is null then null
      else has_function_privilege(to_regrole('anon'), p.oid, 'execute')
    end as anon_execute,
    case when to_regrole('authenticated') is null then null
      else has_function_privilege(to_regrole('authenticated'), p.oid, 'execute')
    end as authenticated_execute,
    case when to_regrole('service_role') is null then null
      else has_function_privilege(to_regrole('service_role'), p.oid, 'execute')
    end as service_role_execute,
    md5(pg_get_functiondef(p.oid)) as definition_fingerprint,
    pg_get_functiondef(p.oid) as complete_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'get_open_slots',
      'claim_team_notification_deliveries',
      'complete_notification_delivery',
      'transition_slot_booking'
    )
),
reconciliation_function_state as (
  select
    30 as ordinal,
    'reconciliation_function_state'::text as section,
    coalesce(
      jsonb_agg(
        to_jsonb(rows)
        order by rows.function_name, rows.identity_arguments
      ),
      '[]'::jsonb
    ) as result_json
  from reconciliation_function_rows rows
),
slip_objects_absent_before_0011 as (
  select
    40 as ordinal,
    'slip_objects_absent_before_0011'::text as section,
    jsonb_build_object(
      'payment_slip_verifications_present',
        to_regclass('public.payment_slip_verifications') is not null,
      'payment_transactions_present',
        to_regclass('public.payment_transactions') is not null,
      'confirm_slip_payment_present', exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'confirm_slip_payment'
      ),
      'all_slip_objects_absent',
        to_regclass('public.payment_slip_verifications') is null
        and to_regclass('public.payment_transactions') is null
        and not exists (
          select 1
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname = 'confirm_slip_payment'
        )
    ) as result_json
),
report as (
  select * from legacy_slot_booking_impact_0009
  union all select * from queue_session_cutover_by_date_0009
  union all select * from reconciliation_function_state
  union all select * from slip_objects_absent_before_0011
)
select section, result_json
from report
order by ordinal;
