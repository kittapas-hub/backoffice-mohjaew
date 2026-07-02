// Static guards that protect P0 invariants without needing a DB:
//  1. A booking can only ever be created via POST /api/bookings ->
//     createSlotBooking -> the create_booking RPC (AST-verified, recursively,
//     across all of src). The LINE webhook is not a booking-creation path: it
//     cannot access bookings/booking_sessions/booking_images/Storage, and it
//     cannot create a booking, session, image record, or storage object.
//  2. The expire cron always requires CRON_SECRET (never public).
//  3. RPC grants: only service_role may execute; tables locked for anon/auth.
//  4. Admin slot bookings change only via the transition RPC (no direct update).
//  5. POST /api/bookings has idempotency, honeypot, duplicate + rate-limit guards
//     and never accepts client-controlled status/queue/hold/capacity.
//  6. Browser/client code never calls booking RPCs directly.
//  7. No LINE sender logs a raw LINE API response body.
// Guards 1 and 7 are AST-based (TypeScript compiler API), not text-window or
// regex matching, so a `create_booking` mention in a comment/doc never fails
// the test, and a future non-booking `.rpc(...)` call in the webhook is not
// forbidden by an over-broad "no .rpc( at all" rule.
// Run: node --experimental-strip-types src/lib/integration-guards.test.ts
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..", "app");
const read = (rel: string) => readFileSync(join(here, "..", rel), "utf8");

// --- AST helpers --------------------------------------------------------------
function parseSource(filePath: string): ts.SourceFile {
  const text = readFileSync(filePath, "utf8");
  const kind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, kind);
}

function forEachDescendant(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => forEachDescendant(child, visit));
}

// True for `<expr>.rpc("create_booking", ...)`.
function isCreateBookingRpcCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "rpc") return false;
  const [firstArg] = node.arguments;
  return !!firstArg && ts.isStringLiteralLike(firstArg) && firstArg.text === "create_booking";
}

// True for `<expr>.from("bookings").insert(...)`.
function isBookingsInsertCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "insert") return false;
  const target = callee.expression;
  if (!ts.isCallExpression(target)) return false;
  const targetCallee = target.expression;
  if (!ts.isPropertyAccessExpression(targetCallee) || targetCallee.name.text !== "from") return false;
  const [fromArg] = target.arguments;
  return !!fromArg && ts.isStringLiteralLike(fromArg) && fromArg.text === "bookings";
}

// Every Identifier/StringLiteral whose text exactly matches one of `names`.
// AST-based, so a comment or doc string mentioning the name never matches —
// only a real code reference (call, property access, import, string arg) does.
function findReferencedNames(sf: ts.SourceFile, names: string[]): string[] {
  const hits = new Set<string>();
  forEachDescendant(sf, (node) => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && names.includes(node.text)) {
      hits.add(node.text);
    }
  });
  return [...hits];
}

// Every `console.<method>(...)` call whose arguments contain a no-arg
// `.text()` call anywhere in their subtree — i.e. reading a raw fetch
// Response body (which may echo request content / tokens back).
function findConsoleRawBodyLogging(sf: ts.SourceFile): string[] {
  const offenders: string[] = [];
  forEachDescendant(sf, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      !ts.isIdentifier(node.expression.expression) ||
      node.expression.expression.text !== "console"
    ) {
      return;
    }
    for (const arg of node.arguments) {
      let logsBody = false;
      forEachDescendant(arg, (inner) => {
        if (
          ts.isCallExpression(inner) &&
          ts.isPropertyAccessExpression(inner.expression) &&
          inner.expression.name.text === "text" &&
          inner.arguments.length === 0
        ) {
          logsBody = true;
        }
      });
      if (logsBody) offenders.push((node.expression as ts.PropertyAccessExpression).name.text);
    }
  });
  return offenders;
}

function importsNamedFrom(sf: ts.SourceFile, moduleSubstring: string, importName: string): boolean {
  let found = false;
  ts.forEachChild(sf, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text.includes(moduleSubstring)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings) && bindings.elements.some((el) => el.name.text === importName)) {
        found = true;
      }
    }
  });
  return found;
}

function callsIdentifier(sf: ts.SourceFile, name: string): boolean {
  let found = false;
  forEachDescendant(sf, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      found = true;
    }
  });
  return found;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

// --- 1. Sole booking-creation path + LINE webhook cannot create anything -----

// Website/linked-channel slot bookings use the central capacity-safe RPC.
const core = readFileSync(join(here, "booking-core.ts"), "utf8");
assert.match(core, /rpc\(\s*["'`]create_booking["'`]/, "core must create via create_booking RPC");
assert.match(core, /paymentHoldMinutes/, "core must use the shared payment hold duration");
assert.match(
  core,
  /p_hold_minutes:\s*paymentHoldMinutes\(process\.env\.BOOKING_HOLD_MINUTES\)/,
  "core must pass hold minutes explicitly from the env-configurable source",
);

// Recursive scan: only booking-core.ts may call the create_booking RPC, and no
// file anywhere under src may insert into `bookings` directly — creation is
// exclusively through that one RPC.
const srcRoot = join(here, "..");
const CREATE_BOOKING_RPC_ALLOWLIST = ["lib/booking-core.ts"];
const BOOKINGS_INSERT_ALLOWLIST: string[] = [];

let sawCreateBookingRpcCall = false;
for (const file of listSourceFiles(srcRoot)) {
  const rel = relative(srcRoot, file).split("\\").join("/");
  const sf = parseSource(file);

  forEachDescendant(sf, (node) => {
    if (isCreateBookingRpcCall(node)) {
      sawCreateBookingRpcCall = true;
      assert.ok(
        CREATE_BOOKING_RPC_ALLOWLIST.includes(rel),
        `${rel} calls the create_booking RPC directly — only booking-core.ts may`,
      );
    }
    if (isBookingsInsertCall(node)) {
      assert.ok(
        BOOKINGS_INSERT_ALLOWLIST.includes(rel),
        `${rel} inserts into bookings directly — only the create_booking RPC may create a booking`,
      );
    }
  });
}
assert.ok(sawCreateBookingRpcCall, "sanity check: the create_booking RPC call site must exist (in booking-core.ts)");

// POST /api/bookings must be the route that creates slot bookings.
const bookingsRouteSf = parseSource(join(appDir, "api/bookings/route.ts"));
assert.ok(
  importsNamedFrom(bookingsRouteSf, "booking-core", "createSlotBooking"),
  "POST /api/bookings must import createSlotBooking from booking-core",
);
assert.ok(
  callsIdentifier(bookingsRouteSf, "createSlotBooking"),
  "POST /api/bookings must call createSlotBooking",
);

// The LINE webhook must not be able to create a booking, session, image
// record, or storage object at all: it must not reference any of these
// tables/APIs/helpers anywhere in real code (comments don't count — this is
// an AST check, not a text search).
const webhookPath = join(appDir, "api/line/webhook/route.ts");
const webhook = readFileSync(webhookPath, "utf8");
const webhookSf = parseSource(webhookPath);
const FORBIDDEN_WEBHOOK_NAMES = [
  "bookings",
  "booking_sessions",
  "booking_images",
  "storage",
  "create_booking",
  "createSlotBooking",
  "getMessageContent",
  "hasMatchingImageSignature",
];
const webhookHits = findReferencedNames(webhookSf, FORBIDDEN_WEBHOOK_NAMES);
assert.deepEqual(
  webhookHits,
  [],
  `LINE webhook must not access bookings/sessions/images/Storage or the booking RPC/helper (found: ${webhookHits.join(", ")}) — it cannot create a booking, session, image record, or storage object`,
);
assert.match(webhook, /verifyLineSignature/, "LINE webhook must still verify the LINE signature");
// Deliberately NOT a blanket "no .rpc( at all" ban — a future non-booking RPC
// call in the webhook must remain possible; only create_booking is forbidden
// (enforced by the recursive scan above, which covers this file too).

// --- 7. No LINE sender logs a raw LINE API response body --------------------
const lineLibSf = parseSource(join(here, "line.ts"));
const rawBodyLoggers = findConsoleRawBodyLogging(lineLibSf);
assert.deepEqual(
  rawBodyLoggers,
  [],
  `line.ts must not log a raw LINE response body via .text() (found in console.${rawBodyLoggers.join(", console.")})`,
);

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
// Default slots are defined once in slot-seeding.ts and shared with the
// horizon cron — day actions must import them, not define a second list.
assert.match(
  dayActions,
  /from\s+["'`]@\/lib\/slot-seeding["'`]/,
  "day actions must reuse the shared slot-seeding source (no second divergent slot list)",
);
assert.doesNotMatch(dayActions, /length:\s*12/, "day actions must not define its own hardcoded slot list");
const slotSeedingSrc = read("lib/slot-seeding.ts");
assert.match(slotSeedingSrc, /length:\s*12/, "default day should seed 12 hourly slots");
assert.match(slotSeedingSrc, /DEFAULT_SLOT_CAPACITY\s*=\s*1/, "default hourly slot capacity should be 1");
assert.doesNotMatch(slotSeedingSrc, /09:00["'`],\s*end_time:\s*["'`]12:00/, "must not seed legacy 3-hour morning slot");

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

// --- 9. New bookings are visible in the default admin list ------------------
const adminPage = read("app/admin/page.tsx");
assert.match(
  adminPage,
  /\.from\(\s*["'`]bookings["'`]\s*\)/,
  "admin list must query the table used by both creation paths",
);
assert.match(
  adminPage,
  /if \(filter\) query = query\.eq\(["'`]status["'`], filter\)/,
  "admin list must filter status only when the admin explicitly asks",
);
assert.doesNotMatch(
  adminPage,
  /\.not\(\s*["'`]status["'`]|\.in\(\s*["'`]status["'`]/,
  "admin list must not silently exclude pending or pending_payment records",
);
assert.match(
  adminPage,
  /slot_id, source,/,
  "admin list must load source and slot_id to label unscheduled LINE inquiries",
);
assert.match(
  adminPage,
  /รอตรวจสอบ · ยังไม่เลือกเวลา/,
  "admin list must clearly label a slotless LINE inquiry",
);

// --- 10. Public GET /api/slots is rate limited and IPs come from the
// trusted platform header only (x-forwarded-for's first hop is spoofable).
const slotsRoute = read("app/api/slots/route.ts");
assert.match(slotsRoute, /BOOKING_RATE_LIMIT_SECRET/, "slots route must require the rate-limit secret");
assert.match(slotsRoute, /recordRateHit/, "slots route must call recordRateHit");
assert.match(slotsRoute, /\b429\b/, "slots route must return 429 when rate limited");
const clientIpSrc = read("lib/client-ip.ts");
assert.match(clientIpSrc, /x-vercel-forwarded-for/, "clientIp must prefer the platform-set x-vercel-forwarded-for header");
assert.match(clientIpSrc, /x-real-ip/, "clientIp must fall back to the platform-set x-real-ip header");
assert.doesNotMatch(clientIpSrc, /get\(\s*["'`]x-forwarded-for["'`]\s*\)/, "clientIp must not trust x-forwarded-for");
assert.match(clientIpSrc, /process\.env\.VERCEL/, "clientIp must only log the fallback loudly when running on Vercel");
for (const f of ["app/api/bookings/route.ts", "app/api/bookings/face-upload/route.ts", "app/api/slots/route.ts"]) {
  const src = read(f);
  assert.match(src, /from\s+["'`]@\/lib\/client-ip["'`]/, `${f} must use the shared trusted clientIp helper`);
  assert.doesNotMatch(src, /x-forwarded-for/, `${f} must not read x-forwarded-for`);
}

const adminDayPage = read("app/admin/day/page.tsx");
assert.match(
  adminDayPage,
  /\.in\(\s*["']slot_id["'], slotIds\)/,
  "admin day must query only bookings attached to the displayed slots",
);
assert.match(
  adminDayPage,
  /groupBookingsBySlot/,
  "admin day must defensively discard slotless records before grouping",
);
assert.match(
  adminDayPage,
  /countOccupied\(list\)/,
  "admin day occupancy must count only each slot's grouped booking list",
);

console.log("integration-guards self-check passed");
