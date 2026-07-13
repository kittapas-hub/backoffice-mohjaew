-- Forward-only production-baseline reconciliation.
--
-- Verified baseline:
--   * the read-only get_open_slots(date) replacement from 0006 is absent;
--   * the later notification and hold-expiry changes are present;
--   * the 0009 queue-session cutover is absent;
--   * exactly 384 affected legacy slots are open;
--   * no booking references an affected legacy slot;
--   * no canonical session row exists on or after the cutover date.
--
-- This migration deliberately does not replay an earlier migration number.
-- It validates the verified physical baseline under row locks before the first
-- data change, performs the cutover, and installs the exact 0006 function body
-- in one transaction. Any failed assertion rolls back the entire migration.

begin;

do $$
declare
  v_cutover                    date   := date '2026-07-12';
  v_legacy_total               bigint;
  v_open_legacy                bigint;
  v_seeded_dates               bigint;
  v_existing_canonical         bigint;
  v_affected_bookings          bigint;
  v_closed                     bigint;
  v_inserted                   bigint;
  v_unexpected_open_legacy     bigint;
  v_bad_canonical_dates        bigint;
begin
  -- Lock every affected legacy row in the same deterministic order used by
  -- 0009. Booking creation locks its slot row first, so the booking check below
  -- observes any transaction that committed before these locks were acquired
  -- and prevents a new booking from racing the cutover afterward.
  perform s.id
    from public.booking_slots s
   where s.booking_date >= v_cutover
     and not (
           (s.start_time = '09:00'::time and s.end_time = '12:00'::time)
        or (s.start_time = '13:00'::time and s.end_time = '16:00'::time)
        or (s.start_time = '18:00'::time and s.end_time = '21:00'::time)
        or (s.start_time = '22:00'::time and s.end_time = '23:00'::time)
         )
     and (s.end_time - s.start_time) = interval '1 hour'
     and s.start_time >= '09:00'::time
     and s.end_time <= '21:00'::time
   order by s.booking_date, s.start_time, s.end_time
   for update;

  select
    count(*),
    count(*) filter (where s.is_open)
    into v_legacy_total, v_open_legacy
    from public.booking_slots s
   where s.booking_date >= v_cutover
     and not (
           (s.start_time = '09:00'::time and s.end_time = '12:00'::time)
        or (s.start_time = '13:00'::time and s.end_time = '16:00'::time)
        or (s.start_time = '18:00'::time and s.end_time = '21:00'::time)
        or (s.start_time = '22:00'::time and s.end_time = '23:00'::time)
         )
     and (s.end_time - s.start_time) = interval '1 hour'
     and s.start_time >= '09:00'::time
     and s.end_time <= '21:00'::time;

  if v_legacy_total <> 384 or v_open_legacy <> 384 then
    raise exception
      'reconciliation_baseline_changed: expected 384 legacy/open rows, found %/%',
      v_legacy_total, v_open_legacy;
  end if;

  select count(distinct s.booking_date)
    into v_seeded_dates
    from public.booking_slots s
   where s.booking_date >= v_cutover;

  select count(*)
    into v_existing_canonical
    from public.booking_slots s
   where s.booking_date >= v_cutover
     and (
           (s.start_time = '09:00'::time and s.end_time = '12:00'::time)
        or (s.start_time = '13:00'::time and s.end_time = '16:00'::time)
        or (s.start_time = '18:00'::time and s.end_time = '21:00'::time)
        or (s.start_time = '22:00'::time and s.end_time = '23:00'::time)
         );

  if v_existing_canonical <> 0 then
    raise exception
      'reconciliation_baseline_changed: expected zero canonical rows, found %',
      v_existing_canonical;
  end if;

  -- This is the final pre-mutation guard. It runs after all affected slot rows
  -- are locked. Any affected booking aborts before a slot or function changes.
  select count(*)
    into v_affected_bookings
    from public.bookings b
    join public.booking_slots s on s.id = b.slot_id
   where s.booking_date >= v_cutover
     and not (
           (s.start_time = '09:00'::time and s.end_time = '12:00'::time)
        or (s.start_time = '13:00'::time and s.end_time = '16:00'::time)
        or (s.start_time = '18:00'::time and s.end_time = '21:00'::time)
        or (s.start_time = '22:00'::time and s.end_time = '23:00'::time)
         )
     and (s.end_time - s.start_time) = interval '1 hour'
     and s.start_time >= '09:00'::time
     and s.end_time <= '21:00'::time;

  if v_affected_bookings <> 0 then
    raise exception
      'queue_session_reconciliation_blocked: % affected booking(s)',
      v_affected_bookings;
  end if;

  update public.booking_slots s
     set is_open = false,
         updated_at = now()
   where s.booking_date >= v_cutover
     and not (
           (s.start_time = '09:00'::time and s.end_time = '12:00'::time)
        or (s.start_time = '13:00'::time and s.end_time = '16:00'::time)
        or (s.start_time = '18:00'::time and s.end_time = '21:00'::time)
        or (s.start_time = '22:00'::time and s.end_time = '23:00'::time)
         )
     and (s.end_time - s.start_time) = interval '1 hour'
     and s.start_time >= '09:00'::time
     and s.end_time <= '21:00'::time;

  get diagnostics v_closed = row_count;
  if v_closed <> v_legacy_total then
    raise exception
      'queue_session_reconciliation_close_mismatch: expected %, changed %',
      v_legacy_total, v_closed;
  end if;

  insert into public.booking_slots (
    booking_date, start_time, end_time, label, capacity
  )
  select d.booking_date,
         v.start_time,
         v.end_time,
         v.label,
         v.capacity
    from (
      select distinct booking_date
        from public.booking_slots
       where booking_date >= v_cutover
    ) d
   cross join (
     values
       ('09:00'::time, '12:00'::time, '09:00–12:00 (เช้า)', 5),
       ('13:00'::time, '16:00'::time, '13:00–16:00 (บ่าย)', 5),
       ('18:00'::time, '21:00'::time, '18:00–21:00 (เย็น)', 5),
       ('22:00'::time, '23:00'::time, '22:00–23:00 (พิเศษ)', 2)
   ) as v(start_time, end_time, label, capacity)
  on conflict (booking_date, start_time, end_time) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted <> v_seeded_dates * 4 then
    raise exception
      'queue_session_reconciliation_insert_mismatch: expected %, inserted %',
      v_seeded_dates * 4, v_inserted;
  end if;

  select count(*)
    into v_unexpected_open_legacy
    from public.booking_slots s
   where s.booking_date >= v_cutover
     and not (
           (s.start_time = '09:00'::time and s.end_time = '12:00'::time)
        or (s.start_time = '13:00'::time and s.end_time = '16:00'::time)
        or (s.start_time = '18:00'::time and s.end_time = '21:00'::time)
        or (s.start_time = '22:00'::time and s.end_time = '23:00'::time)
         )
     and (s.end_time - s.start_time) = interval '1 hour'
     and s.start_time >= '09:00'::time
     and s.end_time <= '21:00'::time
     and s.is_open;

  if v_unexpected_open_legacy <> 0 then
    raise exception
      'queue_session_reconciliation_open_legacy: % row(s)',
      v_unexpected_open_legacy;
  end if;

  select count(*)
    into v_bad_canonical_dates
    from (
      select d.booking_date
        from (
          select distinct booking_date
            from public.booking_slots
           where booking_date >= v_cutover
        ) d
        left join public.booking_slots s
          on s.booking_date = d.booking_date
         and (
               (s.start_time = '09:00'::time and s.end_time = '12:00'::time)
            or (s.start_time = '13:00'::time and s.end_time = '16:00'::time)
            or (s.start_time = '18:00'::time and s.end_time = '21:00'::time)
            or (s.start_time = '22:00'::time and s.end_time = '23:00'::time)
             )
       group by d.booking_date
      having count(s.id) <> 4
          or count(s.id) filter (
               where (
                     (s.start_time = '09:00'::time and s.end_time = '12:00'::time and s.capacity = 5)
                  or (s.start_time = '13:00'::time and s.end_time = '16:00'::time and s.capacity = 5)
                  or (s.start_time = '18:00'::time and s.end_time = '21:00'::time and s.capacity = 5)
                  or (s.start_time = '22:00'::time and s.end_time = '23:00'::time and s.capacity = 2)
                    )
             ) <> 4
    ) invalid_dates;

  if v_bad_canonical_dates <> 0 then
    raise exception
      'queue_session_reconciliation_invalid_canonical_dates: % date(s)',
      v_bad_canonical_dates;
  end if;
end;
$$;

-- Exact read-only get_open_slots(date) behavior from migration 0006.
create or replace function public.get_open_slots(p_date date)
returns table (
  id uuid, booking_date date, start_time time, end_time time,
  label text, capacity int, occupied int, remaining int
)
language plpgsql
as $$
begin
  return query
  select s.id, s.booking_date, s.start_time, s.end_time, s.label, s.capacity,
         coalesce(o.cnt, 0)::int as occupied,
         greatest(s.capacity - coalesce(o.cnt, 0), 0)::int as remaining
    from public.booking_slots s
    left join lateral (
      select count(*) cnt
        from public.bookings b
       where b.slot_id = s.id
         and (b.status in ('booked', 'confirmed', 'completed')
              or (b.status = 'pending_payment' and b.hold_expires_at > now()))
    ) o on true
   where s.booking_date = p_date
     and s.is_open
     and (
       s.booking_date > (now() at time zone 'Asia/Bangkok')::date
       or (
         s.booking_date = (now() at time zone 'Asia/Bangkok')::date
         and s.start_time > (now() at time zone 'Asia/Bangkok')::time
       )
     )
   order by s.start_time;
end;
$$;

revoke all on function public.get_open_slots(date) from public, anon, authenticated;
grant execute on function public.get_open_slots(date) to service_role;

commit;
