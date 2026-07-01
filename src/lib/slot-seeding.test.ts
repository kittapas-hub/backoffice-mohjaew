// Self-check for the shared slot-seeding helper.
//
// Horizon semantics:
//  - Customer guarantee: /booking always has at least CUSTOMER_HORIZON_DAYS
//    (30) selectable calendar dates, Bangkok time.
//  - Seeded buffer: the cron seeds SEED_HORIZON_DAYS (31) dates — Bangkok
//    today .. today+30 inclusive — one day beyond the guarantee so the
//    horizon never shrinks below 30 days between local midnight and the
//    next 04:10 Bangkok run. The daily schedule itself is unchanged.
//
// Also proves (via a minimal fake Supabase-like client, not a new framework)
// that both seedSlotsForDate and ensureSlotHorizon insert-only: they use the
// (booking_date, start_time, end_time) conflict target with ignore-duplicate
// semantics, never call .update()/.delete(), and re-running never touches an
// already-seeded slot's capacity/is_open/label/start_time/end_time.
//
// Run: node --experimental-strip-types src/lib/slot-seeding.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_HOURLY_SLOTS,
  DEFAULT_SLOT_CAPACITY,
  CUSTOMER_HORIZON_DAYS,
  SEED_HORIZON_DAYS,
  bangkokToday,
  horizonDates,
  seedSlotsForDate,
  ensureSlotHorizon,
} from "./slot-seeding.ts";

const here = dirname(fileURLToPath(import.meta.url));

// --- default slot definition -------------------------------------------------
assert.equal(DEFAULT_HOURLY_SLOTS.length, 12, "default day should seed 12 hourly slots");
assert.equal(DEFAULT_SLOT_CAPACITY, 1, "default slot capacity must stay 1");
assert.equal(CUSTOMER_HORIZON_DAYS, 30, "customer guarantee must stay 30 calendar days");
assert.equal(SEED_HORIZON_DAYS, 31, "seeded buffer must be 31 dates (customer guarantee + 1)");

// --- bangkokToday: Asia/Bangkok wall time, not server/UTC -------------------
// 23:59 Bangkok (UTC 16:59) is still "today" in Bangkok.
assert.equal(bangkokToday(new Date("2026-07-01T16:59:00Z")), "2026-07-01");
// 00:01 Bangkok the next day (UTC 17:01) has already rolled over.
assert.equal(bangkokToday(new Date("2026-07-01T17:01:00Z")), "2026-07-02");

// --- horizonDates: exactly 30 Bangkok calendar dates by default -------------
{
  const dates = horizonDates("2026-07-01");
  assert.equal(dates.length, 30, "default horizon must be exactly 30 calendar dates");
  assert.equal(dates[0], "2026-07-01", "horizon starts at Bangkok today");
  assert.equal(dates[29], "2026-07-30", "horizon ends at today + 29 days");
  assert.equal(new Set(dates).size, 30, "horizon dates must be unique (no gaps/dupes)");
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(`${dates[i - 1]}T00:00:00Z`).getTime();
    const cur = new Date(`${dates[i]}T00:00:00Z`).getTime();
    assert.equal(cur - prev, 86_400_000, `date ${i} must be exactly one day after date ${i - 1}`);
  }
}

// Month/year-boundary crossing (default 30-day window).
{
  const dates = horizonDates("2027-01-15");
  assert.equal(dates.length, 30);
  assert.equal(dates[0], "2027-01-15");
  assert.equal(dates[29], "2027-02-13");
}

// --- 31-date seed buffer (today .. today+30) --------------------------------
{
  const dates = horizonDates("2026-07-01", SEED_HORIZON_DAYS);
  assert.equal(dates.length, 31, "seed buffer must be exactly 31 calendar dates");
  assert.equal(dates[0], "2026-07-01", "seed buffer starts at Bangkok today");
  assert.equal(dates[30], "2026-07-31", "seed buffer ends at today + 30 days");
}

// --- never-overwrite seeding strategy (static guard) ------------------------
// Both seedSlotsForDate and ensureSlotHorizon must use an ON CONFLICT DO
// NOTHING upsert (ignoreDuplicates) on the existing unique key — never a
// plain upsert/update that could overwrite an existing slot's capacity/
// is_open/label, and never a delete.
const seedingSrc = readFileSync(join(here, "slot-seeding.ts"), "utf8");
assert.match(seedingSrc, /ignoreDuplicates:\s*true/, "seeding must ignore duplicates (never overwrite existing slots)");
assert.match(
  seedingSrc,
  /onConflict:\s*["'`]booking_date,start_time,end_time["'`]/,
  "seeding must upsert on the (booking_date, start_time, end_time) unique key",
);
assert.doesNotMatch(seedingSrc, /\.update\(/, "slot seeding must never use .update() — it only inserts missing slots");
assert.doesNotMatch(seedingSrc, /\.delete\(/, "slot seeding must never delete slots");

// --- behavioral: fake Supabase client seam -----------------------------------
// Minimal fake for `db.from("booking_slots").upsert(rows, opts)[.select(...)]`.
// No DI refactor: slot-seeding.ts already takes `db: SupabaseClient` as a
// plain argument, so this just passes a structurally-compatible fake in.
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

        // ON CONFLICT DO NOTHING semantics: only rows whose conflict key is
        // new are "inserted"; pre-existing rows are left exactly as they are
        // (this fake never mutates a stored row on conflict).
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

// seedSlotsForDate: correct conflict target + ignore-duplicates, insert-only.
{
  const fake = makeFakeSlotsDb();
  await seedSlotsForDate(fake as unknown as SupabaseClient, "2026-08-01");
  assert.equal(fake.upsertCalls.length, 1, "seedSlotsForDate must upsert exactly once");
  const call = fake.upsertCalls[0];
  assert.equal(call.table, "booking_slots");
  assert.equal(call.opts.onConflict, "booking_date,start_time,end_time", "must target the atomic unique key");
  assert.equal(call.opts.ignoreDuplicates, true, "must use ON CONFLICT DO NOTHING semantics");
  assert.equal(call.rows.length, 12, "must seed all 12 default hourly slots for the date");
  assert.equal(fake.forbiddenCalls.length, 0, "must never call update()/delete()");

  // Re-running for the same date must not request any update/overwrite path,
  // and must not attempt to change capacity/is_open/label/start_time/end_time
  // on the rows it already committed.
  await seedSlotsForDate(fake as unknown as SupabaseClient, "2026-08-01");
  assert.equal(fake.upsertCalls.length, 2, "second run must still go through the same insert-only upsert");
  const secondCall = fake.upsertCalls[1];
  assert.equal(secondCall.opts.ignoreDuplicates, true, "re-seeding must still use ON CONFLICT DO NOTHING");
  assert.equal(fake.forbiddenCalls.length, 0, "re-seeding must never call update()/delete()");
  // Every row still carries the full default shape (capacity/is_open-affecting
  // fields, label, start_time, end_time) — ON CONFLICT DO NOTHING means the DB
  // discards these for rows that already exist rather than applying them.
  for (const row of secondCall.rows) {
    assert.equal(row.capacity, DEFAULT_SLOT_CAPACITY);
    assert.ok(typeof row.label === "string" && row.label.length > 0);
    assert.ok(typeof row.start_time === "string" && typeof row.end_time === "string");
  }
}

// ensureSlotHorizon: 31 seeded dates, idempotent createdCount, no overwrite.
{
  const fake = makeFakeSlotsDb();
  const now = new Date("2026-08-01T10:00:00Z"); // Bangkok 2026-08-01 17:00

  const first = await ensureSlotHorizon(fake as unknown as SupabaseClient, now);
  assert.equal(first.startDate, "2026-08-01");
  assert.equal(first.endDate, "2026-08-31", "seed buffer must end at Bangkok today + 30");
  assert.equal(first.createdCount, 31 * 12, "first run must create all 31 days x 12 slots");
  assert.equal(fake.upsertCalls.length, 1);
  assert.equal(fake.upsertCalls[0].opts.onConflict, "booking_date,start_time,end_time");
  assert.equal(fake.upsertCalls[0].opts.ignoreDuplicates, true);

  // Re-running (e.g. concurrent trigger, or the next scheduled day) must not
  // recreate or overwrite anything already seeded.
  const second = await ensureSlotHorizon(fake as unknown as SupabaseClient, now);
  assert.equal(second.createdCount, 0, "re-running the same horizon must create nothing new");
  assert.equal(fake.forbiddenCalls.length, 0, "ensureSlotHorizon must never call update()/delete()");

  // One day later, only the new rolled-forward day should be created.
  const nextDay = new Date("2026-08-02T10:00:00Z");
  const third = await ensureSlotHorizon(fake as unknown as SupabaseClient, nextDay);
  assert.equal(third.startDate, "2026-08-02");
  assert.equal(third.endDate, "2026-09-01");
  assert.equal(third.createdCount, 12, "only the newly rolled-in day's 12 slots should be created");
}

// --- cron endpoint: auth + seed-only safety ---------------------------------
const cronPath = join(here, "..", "app", "api", "cron", "ensure-slot-horizon", "route.ts");
const cron = readFileSync(cronPath, "utf8");
assert.match(cron, /process\.env\.CRON_SECRET/, "cron must read CRON_SECRET");
assert.match(cron, /503/, "cron must return 503 when CRON_SECRET is unset");
assert.match(cron, /Bearer \$\{secret\}/, "cron must verify the Bearer token");
assert.match(cron, /401/, "cron must return 401 for a missing/wrong bearer token");
assert.match(cron, /ensureSlotHorizon/, "cron must call the shared ensureSlotHorizon helper");

// Seed-only: must not be able to touch bookings or their RPCs/statuses.
for (const forbidden of ["bookings", "create_booking", "transition_slot_booking", "booking_sessions"]) {
  assert.doesNotMatch(cron, new RegExp(`\\b${forbidden}\\b`), `cron must not reference ${forbidden}`);
}
// No PII/secrets/tokens logged — only a status-code-shaped error message.
assert.doesNotMatch(cron, /console\.[a-z]+\([^)]*secret/i, "cron must not log the secret");
assert.doesNotMatch(cron, /req\.headers\.get\(["'`]authorization["'`]\)[\s\S]{0,40}console/i, "cron must not log the auth header");

// --- admin/day still uses the same shared default-slot source --------------
const dayActionsPath = join(here, "..", "app", "admin", "day", "actions.ts");
const dayActions = readFileSync(dayActionsPath, "utf8");
assert.match(
  dayActions,
  /from\s+["'`]@\/lib\/slot-seeding["'`]/,
  "admin/day must import the shared slot-seeding module",
);
assert.doesNotMatch(dayActions, /length:\s*12/, "admin/day must not define a second divergent hardcoded slot list");

console.log("slot-seeding self-check passed");
