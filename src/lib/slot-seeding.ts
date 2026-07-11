// Shared, idempotent slot-seeding logic. Seed-only: never creates a booking,
// never overwrites an existing slot's capacity/is_open/label. Both the admin
// "สร้างรอบเซสชัน" action and the ensure-slot-horizon cron call this.
import type { SupabaseClient } from "@supabase/supabase-js";

/** Bangkok calendar date when customer availability switches to session windows.
 *  Must match supabase/migrations/0009_queue_session_cutover.sql. */
export const SESSION_CUTOVER_DATE = "2026-07-12";

export type SessionSlotDef = {
  start_time: string;
  end_time: string;
  label: string;
  capacity: number;
};

// Four canonical consultation sessions per Bangkok calendar day. Kept here as
// the single source so no caller can define a second, divergent list.
export const DEFAULT_SESSION_SLOTS: readonly SessionSlotDef[] = [
  {
    start_time: "09:00",
    end_time: "12:00",
    label: "09:00–12:00 (เช้า)",
    capacity: 5,
  },
  {
    start_time: "13:00",
    end_time: "16:00",
    label: "13:00–16:00 (บ่าย)",
    capacity: 5,
  },
  {
    start_time: "18:00",
    end_time: "21:00",
    label: "18:00–21:00 (เย็น)",
    capacity: 5,
  },
  {
    start_time: "22:00",
    end_time: "23:00",
    label: "22:00–23:00 (พิเศษ)",
    capacity: 2,
  },
] as const;

const CANONICAL_SESSION_KEYS = new Set(
  DEFAULT_SESSION_SLOTS.map((s) => `${s.start_time}-${s.end_time}`),
);

/** Normalize Postgres `time` / API strings to HH:MM for comparison. */
export function normalizeSlotTime(t: string): string {
  return t.slice(0, 5);
}

/** True when (start_time, end_time) is one of the four canonical session windows. */
export function isCanonicalSessionSlot(startTime: string, endTime: string): boolean {
  return CANONICAL_SESSION_KEYS.has(
    `${normalizeSlotTime(startTime)}-${normalizeSlotTime(endTime)}`,
  );
}

/** True on/after SESSION_CUTOVER_DATE (Bangkok YYYY-MM-DD, lexicographic). */
export function isSessionCutoverDate(date: string): boolean {
  return date >= SESSION_CUTOVER_DATE;
}

// Customer guarantee: at least this many calendar days are always selectable
// on /booking (Bangkok today .. today + CUSTOMER_HORIZON_DAYS - 1).
export const CUSTOMER_HORIZON_DAYS = 30;

// Seeded buffer: the cron seeds one extra day beyond the customer guarantee
// (today .. today + SEED_HORIZON_DAYS - 1, i.e. 31 dates inclusive) so the
// horizon never shrinks below 30 selectable days between Bangkok local
// midnight and the next 04:10 Bangkok cron run.
export const SEED_HORIZON_DAYS = CUSTOMER_HORIZON_DAYS + 1;

function defaultSlotRows(date: string) {
  return DEFAULT_SESSION_SLOTS.map((r) => ({
    booking_date: date,
    start_time: r.start_time,
    end_time: r.end_time,
    label: r.label,
    capacity: r.capacity,
  }));
}

// Bangkok (UTC+7, no DST) "today" as YYYY-MM-DD — independent of server TZ.
export function bangkokToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// `days` consecutive Bangkok calendar dates starting at `startDate` (inclusive).
export function horizonDates(startDate: string, days: number = CUSTOMER_HORIZON_DAYS): string[] {
  const [y, m, d] = startDate.split("-").map(Number);
  const startUtcMs = Date.UTC(y, m - 1, d);
  return Array.from({ length: days }, (_, i) =>
    new Date(startUtcMs + i * 86_400_000).toISOString().slice(0, 10),
  );
}

/** Customer-facing filter: seats left; post-cutover dates show only canonical sessions. */
export function filterCustomerAvailableSlots<
  T extends { start_time: string; end_time: string; remaining: number },
>(date: string, slots: T[]): T[] {
  const open = slots.filter((s) => s.remaining > 0);
  if (!isSessionCutoverDate(date)) return open;
  return open.filter((s) =>
    isCanonicalSessionSlot(String(s.start_time), String(s.end_time)),
  );
}

// Idempotent: ON CONFLICT DO NOTHING on the (booking_date, start_time,
// end_time) unique key means re-seeding a date is always a safe no-op —
// existing capacity/is_open/label are never touched.
export async function seedSlotsForDate(db: SupabaseClient, date: string): Promise<void> {
  await db.from("booking_slots").upsert(defaultSlotRows(date), {
    onConflict: "booking_date,start_time,end_time",
    ignoreDuplicates: true,
  });
}

// Seeds the rolling horizon (Bangkok today .. today + days - 1) with default
// session slots. Only inserts what's missing; existing slots are left untouched.
export async function ensureSlotHorizon(
  db: SupabaseClient,
  now: Date = new Date(),
  days: number = SEED_HORIZON_DAYS,
): Promise<{ startDate: string; endDate: string; createdCount: number }> {
  const dates = horizonDates(bangkokToday(now), days);
  const rows = dates.flatMap((date) => defaultSlotRows(date));

  const { data, error } = await db
    .from("booking_slots")
    .upsert(rows, { onConflict: "booking_date,start_time,end_time", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;

  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    createdCount: data?.length ?? 0,
  };
}
