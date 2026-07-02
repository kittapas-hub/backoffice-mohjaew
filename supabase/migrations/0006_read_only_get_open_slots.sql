-- Phase 0 hardening: make get_open_slots read-only.
-- PROPOSED — do not apply without review. Run AFTER 0005_payment_foundation.sql.
--
-- Why: get_open_slots is reached from the public, unauthenticated
-- GET /api/slots endpoint, and until now it executed
-- `perform public.expire_pending_bookings()` — a table-wide UPDATE — on every
-- request. That is a write-amplification / abuse vector and adds lock
-- contention against create_booking and admin transitions.
--
-- Correctness is unchanged by removing the call:
--   * The occupancy count below already excludes lapsed holds via
--     `b.hold_expires_at > now()`, so availability shown to customers is
--     identical with or without the status flip.
--   * Rows still get flipped to 'expired' by (a) the */5-min cron
--     (GET /api/cron/expire-bookings -> expire_pending_bookings) and
--     (b) create_booking(), which expires lapsed holds for its slot inside
--     the booking transaction before counting capacity.
--
-- This is a body-only change; the signature, grants, and result shape are
-- identical to the 0005 version.
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

-- ROLLBACK: re-run section 7 of 0005_payment_foundation.sql (the previous
-- get_open_slots body, which starts with `perform public.expire_pending_bookings();`).
