// Static guards that protect P0 invariants without needing a DB:
//  1. The LINE webhook never creates bookings (no slotless bypass of the core).
//  2. The expire cron always requires CRON_SECRET (never public).
//  3. RPC grants: only service_role may execute; tables locked for anon/auth.
//  4. Admin slot bookings change only via the transition RPC (no direct update).
//  5. POST /api/bookings has idempotency, honeypot, duplicate + rate-limit guards
//     and never accepts client-controlled status/queue/hold/capacity.
//  6. Browser/client code never calls booking RPCs directly.
// Run: node --experimental-strip-types src/lib/integration-guards.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..", "app");
const read = (rel: string) => readFileSync(join(here, "..", rel), "utf8");

// --- 1. LINE webhook must not write bookings --------------------------------
const webhook = readFileSync(join(appDir, "api/line/webhook/route.ts"), "utf8");

// No direct writes to the bookings table from the webhook.
assert.doesNotMatch(
  webhook,
  /from\(\s*["'`]bookings["'`]\s*\)/,
  "LINE webhook must not touch the bookings table",
);
// No RPC calls from the webhook at all (no create_booking / confirm_booking bypass).
assert.doesNotMatch(
  webhook,
  /\.rpc\(/,
  "LINE webhook must not call any booking RPC directly",
);
// It should steer customers to the central booking page.
assert.match(
  webhook,
  /\/booking\?source=line/,
  "LINE webhook should reply with the central booking link",
);

// The only booking-creation path is the core RPC wrapper.
const core = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "booking-core.ts"),
  "utf8",
);
assert.match(core, /rpc\(\s*["'`]create_booking["'`]/, "core must create via create_booking RPC");

// --- 2. Cron expire endpoint must require CRON_SECRET ------------------------
const cron = readFileSync(join(appDir, "api/cron/expire-bookings/route.ts"), "utf8");
assert.match(cron, /process\.env\.CRON_SECRET/, "cron must read CRON_SECRET");
assert.match(cron, /503/, "cron must return 503 when CRON_SECRET is unset");
assert.match(cron, /Bearer \$\{secret\}/, "cron must verify the Bearer token");
// Guard against regressing to the old 'open when unset' behavior.
assert.doesNotMatch(cron, /endpoint is open/i, "cron must not be public");

// --- 3. RPC grants + table lockdown in the migration ------------------------
const migration = read("../supabase/migrations/0002_booking_slots.sql");
const fns = [
  "create_booking",
  "transition_slot_booking",
  "get_open_slots",
  "expire_pending_bookings",
  "record_rate_hit",
];
for (const fn of fns) {
  assert.match(
    migration,
    new RegExp(`revoke all on function public\\.${fn}\\b[\\s\\S]*?from public, anon, authenticated`),
    `migration must REVOKE execute on ${fn} from public/anon/authenticated`,
  );
  assert.match(
    migration,
    new RegExp(`grant execute on function public\\.${fn}\\b[\\s\\S]*?to service_role`),
    `migration must GRANT execute on ${fn} to service_role`,
  );
}
for (const tbl of ["bookings", "booking_slots", "api_rate_limits"]) {
  assert.match(
    migration,
    new RegExp(`revoke all on table public\\.${tbl}\\s+from anon, authenticated`),
    `migration must revoke table DML on ${tbl} from anon/authenticated`,
  );
}
// No SECURITY DEFINER (functions run as the invoking service_role).
assert.doesNotMatch(migration, /security definer/i, "no SECURITY DEFINER expected");
// P0-C DB pieces present.
assert.match(migration, /idempotency_key/, "bookings must have idempotency_key");
assert.match(migration, /duplicate_booking/, "create_booking must guard duplicates");
assert.match(migration, /create table if not exists public\.api_rate_limits/, "rate-limit table");

// --- 4. Admin slot bookings only transition via the RPC ---------------------
const adminActions = read("app/admin/actions.ts");
assert.match(
  adminActions,
  /rpc\(\s*["'`]transition_slot_booking["'`]/,
  "admin must transition slot bookings via the RPC",
);
// updateStatus must refuse slot bookings (no direct status update path for them).
assert.match(adminActions, /bk\?\.slot_id/, "updateStatus must check slot_id and bail for slot bookings");
// Day actions must not write booking status directly anymore.
const dayActions = read("app/admin/day/actions.ts");
assert.doesNotMatch(
  dayActions,
  /from\(\s*["'`]bookings["'`]\s*\)/,
  "day actions must not update the bookings table directly",
);

// --- 5. POST /api/bookings guards -------------------------------------------
const bookingsRoute = read("app/api/bookings/route.ts");
assert.match(bookingsRoute, /idempotency-key/i, "must read Idempotency-Key");
assert.match(bookingsRoute, /body\.company/, "must check the honeypot field");
assert.match(bookingsRoute, /BOOKING_RATE_LIMIT_SECRET/, "must require rate-limit secret");
assert.match(bookingsRoute, /\b429\b/, "must return 429 when rate limited");
assert.match(bookingsRoute, /duplicate_booking/, "must surface duplicate_booking (409)");
// Client must never control these — they are set server-side.
for (const field of ["body.status", "body.queue_number", "body.hold_expires_at", "body.capacity"]) {
  assert.doesNotMatch(
    bookingsRoute,
    new RegExp(field.replace(".", "\\.")),
    `route must not read ${field} from the client`,
  );
}

// --- 6. Browser/client code never calls booking RPCs ------------------------
const clientFiles = ["app/booking/BookingForm.tsx", "lib/supabase/client.ts"];
for (const f of clientFiles) {
  const src = read(f);
  assert.doesNotMatch(src, /\.rpc\(/, `${f} must not call Supabase RPC`);
  for (const fn of fns) {
    assert.doesNotMatch(src, new RegExp(fn), `${f} must not reference ${fn}`);
  }
}

// --- 7. /booking/success: token-based DB lookup, no PII in URL ---------------

// success page reads only `token` from searchParams (not individual fields).
const successPage = read("app/booking/success/page.tsx");
assert.match(
  successPage,
  /token.*searchParams|searchParams.*token/,
  "success page must read `token` from searchParams",
);
for (const oldParam of ["slot", "exp"]) {
  assert.doesNotMatch(
    successPage,
    new RegExp(`searchParams.*\\b${oldParam}\\b|\\b${oldParam}\\b.*searchParams`),
    `success page must not read \`${oldParam}\` directly from searchParams`,
  );
}

// getBookingByToken must not select PII columns from the DB.
const coreSrc = read("lib/booking-core.ts");
const fnStart = coreSrc.indexOf("export async function getBookingByToken");
const fnEnd = coreSrc.indexOf("\nexport ", fnStart + 1);
const getBookingFn = coreSrc.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
for (const pii of ["nickname", "phone", "birth_date_text", "consultation_topic"]) {
  assert.doesNotMatch(
    getBookingFn,
    new RegExp(pii),
    `getBookingByToken must not select PII field: ${pii}`,
  );
}

// POST /api/bookings must return token (full booking UUID).
assert.match(
  bookingsRoute,
  /token.*b\.id|b\.id.*token/,
  "POST /api/bookings must return token (booking UUID)",
);

// BookingForm must redirect with only the token — not individual booking fields.
const bookingForm = read("app/booking/BookingForm.tsx");
assert.match(
  bookingForm,
  /booking\/success.*token/,
  "BookingForm must pass token in success redirect",
);
assert.doesNotMatch(
  bookingForm,
  /booking\/success[^`'"]*(?:ref=|&q=|&date=|&slot=|&exp=)/,
  "BookingForm must not put individual booking fields in the success URL",
);

console.log("integration-guards self-check passed");
