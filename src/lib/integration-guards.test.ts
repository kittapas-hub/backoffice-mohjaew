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
assert.match(core, /PAYMENT_HOLD_MINUTES/, "core must use the shared payment hold duration");
assert.match(core, /p_hold_minutes:\s*PAYMENT_HOLD_MINUTES/, "core must pass hold minutes explicitly");

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
assert.match(migration, /Asia\/Bangkok/, "slot cut-off must use Thailand time");
assert.match(migration, /v_slot\.start_time\s*<=/, "create_booking must reject slots that already started");
assert.match(migration, /s\.start_time\s*>/, "get_open_slots must hide slots that already started");
const faceMigration = read("../supabase/migrations/0003_face_upload.sql");
assert.match(faceMigration, /p_hold_minutes\s+int\s+default\s+10/, "0003 create_booking must keep 10-minute payment hold");
assert.match(faceMigration, /Asia\/Bangkok/, "0003 create_booking must keep Thailand-time slot cut-off");
assert.match(faceMigration, /v_slot\.start_time\s*<=/, "0003 create_booking must reject slots that already started");

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
assert.match(dayActions, /DEFAULT_HOURLY_SLOTS/, "default slots must be hourly units");
assert.match(dayActions, /length:\s*12/, "default day should seed 12 hourly slots");
assert.match(dayActions, /capacity:\s*1/, "default hourly slot capacity should be 1");
assert.doesNotMatch(dayActions, /09:00["'`],\s*end_time:\s*["'`]12:00/, "must not seed legacy 3-hour morning slot");

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

// --- 8. Face upload + LINE image notify (upload-token flow) ------------------

// face-upload returns only { uploadToken } — never storagePath or a signed URL.
const faceUpload = read("app/api/bookings/face-upload/route.ts");
assert.match(faceUpload, /ALLOWED_TYPES/, "face-upload must define allowed MIME types");
assert.match(faceUpload, /MAX_BYTES/, "face-upload must enforce max file size");
assert.match(faceUpload, /supabaseAdmin/, "face-upload must use supabaseAdmin (service role)");
assert.match(faceUpload, /uploadToken/, "face-upload must return uploadToken");
assert.doesNotMatch(faceUpload, /createSignedUrl/, "face-upload must not create signed URLs");

// Honeypot + idempotency key guard on face-upload.
assert.match(faceUpload, /company/, "face-upload must check honeypot field");
assert.match(faceUpload, /[Ii]dempotency.?[Kk]ey/, "face-upload must require idempotency key");

// Rate limit must use the shared secret (never silently disabled).
assert.match(faceUpload, /BOOKING_RATE_LIMIT_SECRET/, "face-upload must use BOOKING_RATE_LIMIT_SECRET");
assert.match(faceUpload, /recordRateHit/, "face-upload must call recordRateHit");

// bookings route must read faceUploadToken (not facePath) and map face error codes.
assert.match(bookingsRoute, /faceUploadToken/, "bookings route must read faceUploadToken");
assert.doesNotMatch(bookingsRoute, /facePath/, "bookings route must not read facePath");
assert.match(bookingsRoute, /face_token_expired/, "bookings route must map face_token_expired");
assert.match(bookingsRoute, /face_token_invalid/, "bookings route must map face_token_invalid");

// booking-core must pass p_face_upload_token to RPC and handle face error codes.
assert.match(coreSrc, /p_face_upload_token/, "booking-core must pass p_face_upload_token to RPC");
assert.match(coreSrc, /face_token_expired/, "booking-core KNOWN_ERRORS must include face_token_expired");
assert.match(coreSrc, /face_token_invalid/, "booking-core KNOWN_ERRORS must include face_token_invalid");
// linkFaceToBooking was removed in P0 hardening (logic moved into RPC + inline).
assert.doesNotMatch(coreSrc, /linkFaceToBooking/, "booking-core must not export linkFaceToBooking");

// LINE image notify is non-fatal: failure is caught and booking is never blocked.
assert.match(coreSrc, /notifyTeamImageSafe/, "booking-core must call notifyTeamImageSafe");
assert.match(coreSrc, /imgResult\.ok/, "booking-core must handle image notify failure non-fatally");

// ไม่ส่งวันเกิดเข้า group — birthDateText must not appear in the group text body.
const notifyFnStart = coreSrc.indexOf("async function sendTeamNotify");
const notifyFnBody = coreSrc.slice(notifyFnStart, coreSrc.indexOf("\nexport ", notifyFnStart + 1));
assert.doesNotMatch(notifyFnBody, /birthDateText/, "sendTeamNotify must not include birthDateText in group message");

// 0003 migration must define booking_face_uploads and the face token error codes.
const migration3 = read("../supabase/migrations/0003_face_upload.sql");
assert.match(migration3, /booking_face_uploads/, "0003 must create booking_face_uploads table");
assert.match(migration3, /face_token_expired/, "0003 RPC must raise face_token_expired");
assert.match(migration3, /face_token_invalid/, "0003 RPC must raise face_token_invalid");

// Cron must run orphan cleanup: expired pending → cleaning → (storage delete) → deleted.
const cronRoute = read("app/api/cron/expire-bookings/route.ts");
assert.match(cronRoute, /cleaning/, "cron must transition orphan uploads to 'cleaning'");
assert.match(cronRoute, /deleted/, "cron must mark cleaned uploads as 'deleted'");

// notifyTeamImageSafe must exist in line.ts.
const lineSrc = read("lib/line.ts");
assert.match(lineSrc, /notifyTeamImageSafe/, "line.ts must export notifyTeamImageSafe");

// BookingForm must send faceUploadToken (not facePath) and handle face token errors.
assert.match(bookingForm, /faceFile/, "BookingForm must track faceFile state");
assert.match(bookingForm, /face-upload/, "BookingForm must call face-upload endpoint");
assert.match(bookingForm, /faceUploadToken/, "BookingForm must send faceUploadToken to bookings endpoint");
assert.doesNotMatch(bookingForm, /facePath/, "BookingForm must not send facePath");
assert.match(bookingForm, /face_token_expired/, "BookingForm must handle face_token_expired");

// No migration sets booking-faces bucket to public.
for (const mig of [
  "../supabase/migrations/0001_init.sql",
  "../supabase/migrations/0002_booking_slots.sql",
  "../supabase/migrations/0003_face_upload.sql",
]) {
  const migSrc = read(mig);
  assert.doesNotMatch(
    migSrc,
    /booking.faces.*public.*true|public.*true.*booking.faces/,
    `${mig} must not set booking-faces bucket to public`,
  );
}

console.log("integration-guards self-check passed");
