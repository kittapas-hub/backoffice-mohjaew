-- Phase 1 queue-session cutover (data-only, non-destructive).
-- Run AFTER 0008_reject_expired_hold_confirmation.sql.
--
-- CUT OVER DATE: 2026-07-12 (Asia/Bangkok calendar date).
-- Must match SESSION_CUTOVER_DATE in src/lib/slot-seeding.ts.
--
-- Transaction / locking strategy (single implicit transaction for this DO block):
--   1. SELECT … FOR UPDATE on every hourly seed slot on/after the cutover date,
--      ordered by (booking_date, start_time, end_time) so concurrent
--      create_booking() calls on those slots block until this migration finishes.
--   2. Re-check for bookings on the locked hourly slots (conflict guard after locks).
--   3. If any conflict → RAISE (whole transaction rolls back, locks released).
--   4. Close hourly slots and insert canonical session rows in the same transaction.
--
-- Inline predicates only — no new schema objects.
--
-- What this does NOT do:
--   * Delete booking_slots or bookings rows
--   * Rewrite preferred_time, queue_number, or any historical booking field
--   * Touch slots/bookings before the cutover date
--
-- ROLLBACK (manual, if needed before customers book session slots):
--   -- Re-open hourly slots that were closed by this migration:
--   UPDATE public.booking_slots s
--      SET is_open = true, updated_at = now()
--    WHERE s.booking_date >= '2026-07-12'::date
--      AND (s.end_time - s.start_time) = interval '1 hour'
--      AND NOT (
--            (s.start_time = '09:00'::time AND s.end_time = '12:00'::time)
--         OR (s.start_time = '13:00'::time AND s.end_time = '16:00'::time)
--         OR (s.start_time = '18:00'::time AND s.end_time = '21:00'::time)
--         OR (s.start_time = '22:00'::time AND s.end_time = '23:00'::time)
--          );
--
--   -- Close session slots inserted for the cutover horizon (optional):
--   UPDATE public.booking_slots s
--      SET is_open = false, updated_at = now()
--    WHERE s.booking_date >= '2026-07-12'::date
--      AND (
--            (s.start_time = '09:00'::time AND s.end_time = '12:00'::time)
--         OR (s.start_time = '13:00'::time AND s.end_time = '16:00'::time)
--         OR (s.start_time = '18:00'::time AND s.end_time = '21:00'::time)
--         OR (s.start_time = '22:00'::time AND s.end_time = '23:00'::time)
--          );
--
--   No data is deleted by either rollback step.

do $$
declare
  v_cutover date := '2026-07-12';
  v_conflicts int;
begin
  -- 1. Lock every target hourly slot on/after cutover. create_booking() also
  --    locks its slot row (FOR UPDATE), so concurrent bookings on these slots
  --    cannot pass the conflict check and close step until we commit or abort.
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

  -- 2. Conflict check after locks — abort rolls back closure + inserts.
  select count(*) into v_conflicts
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

  if v_conflicts > 0 then
    raise exception
      'queue_session_cutover_blocked: % hourly-slot booking(s) on or after %',
      v_conflicts, v_cutover;
  end if;

  -- 3. Close hourly slots on/after cutover (never delete).
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

  -- 4. Insert canonical sessions for every horizon date already seeded on/after cutover.
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
end;
$$;
