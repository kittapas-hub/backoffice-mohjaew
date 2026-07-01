// Shared, idempotent slot-seeding logic. Seed-only: never creates a booking,
// never overwrites an existing slot's capacity/is_open/label. Both the admin
// "สร้างรอบรายชั่วโมง" action and the ensure-slot-horizon cron call this.
import type { SupabaseClient } from "@supabase/supabase-js";

// Default bookable units are hourly slots, 09:00–21:00 (12 slots/day). Kept
// here as the single source so no caller can define a second, divergent list.
export const DEFAULT_HOURLY_SLOTS = Array.from({ length: 12 }, (_, i) => {
  const startHour = 9 + i;
  const endHour = startHour + 1;
  const start = `${String(startHour).padStart(2, "0")}:00`;
  const end = `${String(endHour).padStart(2, "0")}:00`;
  return {
    start_time: start,
    end_time: end,
    label: `${start}–${end}`,
  };
});

export const DEFAULT_SLOT_CAPACITY = 1;

// Customer guarantee: at least this many calendar days are always selectable
// on /booking (Bangkok today .. today + CUSTOMER_HORIZON_DAYS - 1).
export const CUSTOMER_HORIZON_DAYS = 30;

// Seeded buffer: the cron seeds one extra day beyond the customer guarantee
// (today .. today + SEED_HORIZON_DAYS - 1, i.e. 31 dates inclusive) so the
// horizon never shrinks below 30 selectable days between Bangkok local
// midnight and the next 04:10 Bangkok cron run. The schedule itself is
// unchanged — this only widens what a single run seeds.
export const SEED_HORIZON_DAYS = CUSTOMER_HORIZON_DAYS + 1;

function defaultSlotRows(date: string) {
  return DEFAULT_HOURLY_SLOTS.map((r) => ({
    ...r,
    booking_date: date,
    capacity: DEFAULT_SLOT_CAPACITY,
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
// slots. Only inserts what's missing; existing slots are left untouched.
// Defaults to SEED_HORIZON_DAYS (31 dates: today .. today+30) so the
// CUSTOMER_HORIZON_DAYS (30-day) guarantee holds continuously even right
// before the next daily run.
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
