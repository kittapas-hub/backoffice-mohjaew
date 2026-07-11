// Self-check for the shared slot-seeding helper.
//
// Horizon semantics:
//  - Customer guarantee: /booking always has at least CUSTOMER_HORIZON_DAYS
//    (30) selectable calendar dates, Bangkok time.
//  - Seeded buffer: the cron seeds SEED_HORIZON_DAYS (31) dates — Bangkok
//    today .. today+30 inclusive — one day beyond the guarantee so the
//    horizon never shrinks below 30 days between local midnight and the
//    next 04:10 Bangkok run.
//
// Run: node --experimental-strip-types src/lib/slot-seeding.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_SESSION_SLOTS,
  SESSION_CUTOVER_DATE,
  CUSTOMER_HORIZON_DAYS,
  SEED_HORIZON_DAYS,
  bangkokToday,
  horizonDates,
  isCanonicalSessionSlot,
  isSessionCutoverDate,
  seedSlotsForDate,
  ensureSlotHorizon,
} from "./slot-seeding.ts";

const here = dirname(fileURLToPath(import.meta.url));

// --- default session definition ---------------------------------------------
assert.equal(DEFAULT_SESSION_SLOTS.length, 4, "default day should seed 4 session slots");
assert.deepEqual(
  DEFAULT_SESSION_SLOTS.map((s) => [s.start_time, s.end_time]),
  [
    ["09:00", "12:00"],
    ["13:00", "16:00"],
    ["18:00", "21:00"],
    ["22:00", "23:00"],
  ],
  "exact four session time ranges",
);
assert.deepEqual(
  DEFAULT_SESSION_SLOTS.map((s) => s.capacity),
  [5, 5, 5, 2],
  "capacities must be 5, 5, 5 and 2",
);
assert.equal(SESSION_CUTOVER_DATE, "2026-07-12");
assert.equal(isSessionCutoverDate("2026-07-11"), false);
assert.equal(isSessionCutoverDate("2026-07-12"), true);
assert.equal(isCanonicalSessionSlot("09:00", "12:00"), true);
assert.equal(isCanonicalSessionSlot("09:00:00", "12:00:00"), true);
assert.equal(isCanonicalSessionSlot("09:00", "10:00"), false, "hourly window is not canonical");

assert.equal(CUSTOMER_HORIZON_DAYS, 30, "customer guarantee must stay 30 calendar days");
assert.equal(SEED_HORIZON_DAYS, 31, "seeded buffer must be 31 dates (customer guarantee + 1)");

// --- bangkokToday: Asia/Bangkok wall time, not server/UTC -------------------
assert.equal(bangkokToday(new Date("2026-07-01T16:59:00Z")), "2026-07-01");
assert.equal(bangkokToday(new Date("2026-07-01T17:01:00Z")), "2026-07-02");

// --- horizonDates: exactly 30 Bangkok calendar dates by default -------------
{
  const dates = horizonDates("2026-07-01");
  assert.equal(dates.length, 30);
  assert.equal(dates[0], "2026-07-01");
  assert.equal(dates[29], "2026-07-30");
}

// --- 31-date seed buffer (today .. today+30) --------------------------------
{
  const dates = horizonDates("2026-07-01", SEED_HORIZON_DAYS);
  assert.equal(dates.length, 31);
  assert.equal(dates[30], "2026-07-31");
}

// --- never-overwrite seeding strategy (static guard) ------------------------
const seedingSrc = readFileSync(join(here, "slot-seeding.ts"), "utf8");
assert.match(seedingSrc, /ignoreDuplicates:\s*true/);
assert.match(seedingSrc, /onConflict:\s*["'`]booking_date,start_time,end_time["'`]/);
assert.doesNotMatch(seedingSrc, /\.update\(/);
assert.doesNotMatch(seedingSrc, /\.delete\(/);

type FakeUpsertOpts = { onConflict?: string; ignoreDuplicates?: boolean };
type FakeRow = Record<string, unknown> & {
  booking_date: string;
  start_time: string;
  end_time: string;
};

function rowKey(r: FakeRow): string {
  return `${r.booking_date}|${r.start_time}|${r.end_time}`;
}

function makeFakeSlotsDb() {
  const existing = new Set<string>();
  const upsertCalls: { table: string; rows: FakeRow[]; opts: FakeUpsertOpts }[] = [];
  const forbiddenCalls: string[] = [];

  function from(table: string) {
    return {
      upsert(rows: FakeRow[], opts: FakeUpsertOpts) {
        upsertCalls.push({ table, rows, opts });

        function commitAndGetInserted(): FakeRow[] {
          if (!opts.ignoreDuplicates) {
            throw new Error("fake db: upsert must be called with ignoreDuplicates: true");
          }
          const inserted = rows.filter((r) => !existing.has(rowKey(r)));
          for (const r of rows) existing.add(rowKey(r));
          return inserted;
        }

        return {
          select() {
            const inserted = commitAndGetInserted();
            return Promise.resolve({
              data: inserted.map((_, i) => ({ id: `fake-${i}` })),
              error: null,
            });
          },
          then(onFulfilled: (v: { data: null; error: null }) => unknown, onRejected?: (e: unknown) => unknown) {
            commitAndGetInserted();
            return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
          },
        };
      },
      update() {
        forbiddenCalls.push("update");
        throw new Error("fake db: .update() must never be called by slot seeding");
      },
      delete() {
        forbiddenCalls.push("delete");
        throw new Error("fake db: .delete() must never be called by slot seeding");
      },
    };
  }

  return { from, upsertCalls, forbiddenCalls };
}

{
  const fake = makeFakeSlotsDb();
  await seedSlotsForDate(fake as unknown as SupabaseClient, "2026-08-01");
  assert.equal(fake.upsertCalls.length, 1);
  const call = fake.upsertCalls[0];
  assert.equal(call.rows.length, 4, "must seed all 4 session slots for the date");
  assert.equal(fake.forbiddenCalls.length, 0);

  await seedSlotsForDate(fake as unknown as SupabaseClient, "2026-08-01");
  assert.equal(fake.upsertCalls.length, 2);
  assert.equal(fake.forbiddenCalls.length, 0);
  for (const row of fake.upsertCalls[1].rows) {
    const cap = DEFAULT_SESSION_SLOTS.find(
      (s) => s.start_time === row.start_time && s.end_time === row.end_time,
    )?.capacity;
    assert.equal(row.capacity, cap);
  }
}

{
  const fake = makeFakeSlotsDb();
  const now = new Date("2026-08-01T10:00:00Z");

  const first = await ensureSlotHorizon(fake as unknown as SupabaseClient, now);
  assert.equal(first.startDate, "2026-08-01");
  assert.equal(first.endDate, "2026-08-31");
  assert.equal(first.createdCount, 31 * 4, "first run must create all 31 days x 4 sessions");

  const second = await ensureSlotHorizon(fake as unknown as SupabaseClient, now);
  assert.equal(second.createdCount, 0);

  const nextDay = new Date("2026-08-02T10:00:00Z");
  const third = await ensureSlotHorizon(fake as unknown as SupabaseClient, nextDay);
  assert.equal(third.createdCount, 4, "only the newly rolled-in day's 4 sessions should be created");
}

// --- migration 0009 must use the same cutover date as TypeScript ------------
const migration = readFileSync(
  join(here, "..", "..", "supabase", "migrations", "0009_queue_session_cutover.sql"),
  "utf8",
);
const migrationCutover =
  migration.match(/v_cutover\s+date\s*:=\s*'(\d{4}-\d{2}-\d{2})'/)?.[1] ??
  migration.match(/CUT OVER DATE:\s*(\d{4}-\d{2}-\d{2})/)?.[1];
assert.equal(
  migrationCutover,
  SESSION_CUTOVER_DATE,
  "TypeScript SESSION_CUTOVER_DATE must match migration 0009 v_cutover",
);
assert.match(migration, /for update/i, "migration must lock hourly slots before conflict check");
assert.doesNotMatch(
  migration,
  /create or replace function public\.is_/i,
  "migration must stay data-only (no helper functions)",
);
assert.match(migration, /09:00–12:00 \(เช้า\)/);
assert.match(migration, /queue_session_cutover_blocked/);

// --- cron endpoint: auth + seed-only safety ---------------------------------
const cronPath = join(here, "..", "app", "api", "cron", "ensure-slot-horizon", "route.ts");
const cron = readFileSync(cronPath, "utf8");
assert.match(cron, /ensureSlotHorizon/);

const dayActionsPath = join(here, "..", "app", "admin", "day", "actions.ts");
const dayActions = readFileSync(dayActionsPath, "utf8");
assert.match(dayActions, /from\s+["'`]@\/lib\/slot-seeding["'`]/);
assert.doesNotMatch(dayActions, /length:\s*12/);

console.log("slot-seeding self-check passed");
