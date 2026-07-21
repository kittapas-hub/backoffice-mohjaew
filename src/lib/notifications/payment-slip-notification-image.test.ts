// Self-check for the dual face+slip payment-evidence image feature
// (0013_payment_slip_notification_image.sql).
// Run: node --experimental-strip-types src/lib/notifications/payment-slip-notification-image.test.ts
//
// DB-level behaviours (locks, RPC transitions, real concurrency) cannot be
// verified without a live Supabase/Postgres instance. Verified by inspecting
// the migration SQL directly, same convention as
// booking-confirmed-notification.test.ts. Real-DB coverage lives in
// booking-confirmed-notification.integration.test.ts (requires
// PG_INTEGRATION_URL).

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function readMigration(name: string) {
  return readFileSync(join(repoRoot, "supabase/migrations", name), "utf8");
}
function readSrc(relPath: string) {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

const migration = readMigration("0013_payment_slip_notification_image.sql");
const migration0012 = readMigration("0012_booking_confirmed_notification.sql");

// ===========================================================================
// This migration must not edit 0012 (already applied to Production; its own
// post-migration verification already passed).
// ===========================================================================
assert.match(migration0012, /'image_storage_path', v_image_path/, "0012 must remain byte-identical to its already-applied, already-verified content");

// ===========================================================================
// A new, dedicated private bucket — never reusing booking-faces for payment
// evidence.
// ===========================================================================
assert.match(migration, /insert into storage\.buckets \(id, name, public\)\s*\nvalues \('payment-slips', 'payment-slips', false\)/, "must create the payment-slips bucket, private");
assert.doesNotMatch(migration, /'payment-slips'[^;]*true/s, "payment-slips bucket must never be set public");

// ===========================================================================
// payment_slip_images / payment_slip_evidence_failures: append-only
// evidence + failure-visibility tables, same security model as
// payment_slip_verifications/payment_transactions (0011) — RLS enabled, no
// anon/authenticated grants, service_role only.
// ===========================================================================
assert.match(migration, /create table if not exists public\.payment_slip_images/);
for (const col of ["payment_order_id", "booking_id", "storage_path", "mime_type", "created_at"]) {
  assert.ok(migration.includes(col), `payment_slip_images must declare column ${col}`);
}
assert.match(migration, /create table if not exists public\.payment_slip_evidence_failures/);
assert.match(migration, /stage\s+text\s+not null\s+check \(stage in \('upload', 'record'\)\)/);
for (const table of ["payment_slip_images", "payment_slip_evidence_failures", "notification_image_deliveries"]) {
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  assert.match(migration, new RegExp(`revoke all on table public\\.${table} from anon, authenticated`));
  assert.match(migration, new RegExp(`grant all on table public\\.${table} to service_role`));
}

// ===========================================================================
// notification_image_deliveries: one row per (notification, image kind),
// unique per pair, its own status/lease/backoff shape, independent of the
// parent notification_deliveries row's lifecycle.
// ===========================================================================
assert.match(migration, /create table if not exists public\.notification_image_deliveries/);
assert.match(migration, /image_kind\s+text\s+not null\s+check \(image_kind in \('face', 'payment_slip'\)\)/);
assert.match(migration, /unique \(notification_delivery_id, image_kind\)/);
for (const col of ["status", "attempt_count", "next_retry_at", "sent_at", "last_error", "line_retry_key"]) {
  assert.ok(migration.includes(col), `notification_image_deliveries must declare column ${col}`);
}

// ===========================================================================
// Release blocker 3: payment_slip_images.storage_path must be protected by a
// real uniqueness constraint — evidence objects are immutable, one row per
// unique path.
// ===========================================================================
assert.match(
  migration,
  /create unique index if not exists payment_slip_images_storage_path_uniq\s*\n\s*on public\.payment_slip_images\(storage_path\)/,
  "payment_slip_images.storage_path must have a uniqueness constraint",
);

// ===========================================================================
// claim_notification_image_deliveries / complete_notification_image_delivery
// mirror claim_team_notification_deliveries / complete_notification_delivery
// (0007): SECURITY DEFINER, search_path pinned, service_role only, and the
// same fixed backoff schedule.
// ===========================================================================
for (const [fn, args] of [
  ["claim_notification_image_deliveries", "text, int"],
  ["complete_notification_image_delivery", "uuid, text, text, text"],
] as const) {
  assert.match(migration, new RegExp(`create function public\\.${fn}\\(`), `must create ${fn}`);
  assert.match(
    migration,
    new RegExp(`revoke all on function public\\.${fn}\\(${args.replace(/[.()]/g, "\\$&")}\\) from public, anon, authenticated`),
    `must revoke execute on ${fn}`,
  );
  assert.match(
    migration,
    new RegExp(`grant execute on function public\\.${fn}\\(${args.replace(/[.()]/g, "\\$&")}\\) to service_role`),
    `must grant execute on ${fn} to service_role`,
  );
}
function imageRpcBody(name: string): string {
  const start = migration.indexOf(`function public.${name}`);
  const end = migration.indexOf("$$;", start) + 3;
  return migration.slice(start, end);
}
assert.match(imageRpcBody("claim_notification_image_deliveries"), /security definer\s*\nset search_path = public, pg_temp/);
assert.match(imageRpcBody("complete_notification_image_delivery"), /security definer\s*\nset search_path = public, pg_temp/);

// ===========================================================================
// Release blocker 1: claim_notification_image_deliveries must never claim a
// row whose parent notification_deliveries row is not yet 'sent' — enforced
// inside the claim function's own candidate query (EXISTS check), not only
// by TypeScript worker sequencing.
// ===========================================================================
const claimBody = imageRpcBody("claim_notification_image_deliveries");
assert.match(
  claimBody,
  /exists \(\s*\n\s*select 1 from public\.notification_deliveries nd\s*\n\s*where nd\.id = nid\.notification_delivery_id\s*\n\s*and nd\.status = 'sent'\s*\n\s*\)/,
  "claim_notification_image_deliveries must gate every candidate row on its parent notification_deliveries row already being 'sent'",
);
// Same fixed backoff schedule as complete_notification_delivery (0007).
assert.match(imageRpcBody("complete_notification_image_delivery"), /when 1 then 1[\s\S]*when 2 then 5[\s\S]*when 3 then 15[\s\S]*when 4 then 60[\s\S]*when 5 then 360/);
assert.match(imageRpcBody("complete_notification_image_delivery"), /v_attempt >= 6/);

// ===========================================================================
// Signed URLs are never generated or stored here — only the private storage
// path.
// ===========================================================================
assert.doesNotMatch(migration, /createSignedUrl|signedUrl/i, "migration must never generate or store a signed URL");

// ===========================================================================
// Exactly three confirmation functions are replaced — same signatures.
// ===========================================================================
for (const [fnSig, revokeGrantArgs] of [
  ["public.confirm_slip_payment(", "uuid, text, text, timestamptz, int, text, text, jsonb"],
  ["public.approve_manual_review_payment(", "uuid"],
  ["public.transition_slot_booking(", "uuid, text"],
] as const) {
  assert.match(
    migration,
    new RegExp(`create or replace function ${fnSig.replace(/[.()]/g, "\\$&")}`),
    `must create or replace ${fnSig}`,
  );
  assert.match(
    migration,
    new RegExp(`revoke all on function ${fnSig.replace(/[.()]/g, "\\$&")}${revokeGrantArgs.replace(/[.()]/g, "\\$&")}\\) from public, anon, authenticated`),
    `must revoke execute on ${fnSig} from public/anon/authenticated`,
  );
  assert.match(
    migration,
    new RegExp(`grant execute on function ${fnSig.replace(/[.()]/g, "\\$&")}${revokeGrantArgs.replace(/[.()]/g, "\\$&")}\\) to service_role`),
    `must grant execute on ${fnSig} to service_role`,
  );
}

function functionBody(name: string): string {
  const start = migration.indexOf(`function public.${name}`);
  const nextSection = migration.indexOf("-- ===========", start + 1);
  const end = nextSection === -1 ? migration.indexOf("\ncommit;", start) : nextSection;
  return migration.slice(start, end);
}

const confirmSlipBody = functionBody("confirm_slip_payment");
const approveBody = functionBody("approve_manual_review_payment");
const transitionBody = functionBody("transition_slot_booking");

// ===========================================================================
// The jsonb payload no longer carries any image-path field at all (neither
// the retired 'image_storage_path' nor a new one) — image delivery is
// entirely driven by notification_image_deliveries now.
// ===========================================================================
for (const body of [confirmSlipBody, approveBody, transitionBody]) {
  assert.doesNotMatch(body, /image_storage_path|slip_storage_path|face_storage_path/, "the jsonb payload must never carry an image-path field");
}

// ===========================================================================
// confirm_slip_payment: BOTH branches look up face (booking_images) and
// slip (payment_slip_images) evidence and conditionally insert BOTH kinds,
// gated on the parent insert actually returning a fresh row (never
// duplicating tasks on a conflict/race).
// ===========================================================================
const faceLookups = confirmSlipBody.match(/select bi\.storage_path into v_face_path\s*\n\s*from public\.booking_images bi/g) ?? [];
assert.equal(faceLookups.length, 2, "confirm_slip_payment must look up the face image in both its manual_review and success branches");
const slipLookups = confirmSlipBody.match(/select psi\.storage_path into v_slip_path\s*\n\s*from public\.payment_slip_images psi/g) ?? [];
assert.equal(slipLookups.length, 2, "confirm_slip_payment must look up the slip image in both its manual_review and success branches");

// Release blocker 3: both lookups must break created_at ties on id so the
// freshest evidence row is picked deterministically even when two uploads
// for the same order/booking commit at the exact same instant.
const faceOrderings = confirmSlipBody.match(/order by bi\.created_at desc, bi\.id desc/g) ?? [];
assert.equal(faceOrderings.length, 2, "confirm_slip_payment's face lookup must break created_at ties on id in both branches");
const slipOrderings = confirmSlipBody.match(/order by psi\.created_at desc, psi\.id desc/g) ?? [];
assert.equal(slipOrderings.length, 2, "confirm_slip_payment's slip lookup must break created_at ties on id in both branches");
const faceInserts = confirmSlipBody.match(/values \(v_notification_id, 'face', v_face_path\)/g) ?? [];
assert.equal(faceInserts.length, 2, "confirm_slip_payment must conditionally enqueue a face image task in both branches");
const slipInserts = confirmSlipBody.match(/values \(v_notification_id, 'payment_slip', v_slip_path\)/g) ?? [];
assert.equal(slipInserts.length, 2, "confirm_slip_payment must conditionally enqueue a slip image task in both branches");
assert.match(confirmSlipBody, /if v_notification_id is not null then/, "image tasks must be gated on the notification row actually being newly created");
assert.match(confirmSlipBody, /returning id into v_notification_id/, "must capture the notification_deliveries id via RETURNING");

// The slip_manual_review notification (inside confirm_slip_payment) must
// also enqueue both image kinds — the manual-review alert gets the same
// evidence as a successful confirmation.
const manualReviewBranch = confirmSlipBody.slice(
  confirmSlipBody.indexOf("if v_reason is not null then"),
  confirmSlipBody.indexOf("return jsonb_build_object('result','manual_review','reason',v_reason);") + 60,
);
assert.match(manualReviewBranch, /'face', v_face_path/, "slip_manual_review must enqueue a face image task");
assert.match(manualReviewBranch, /'payment_slip', v_slip_path/, "slip_manual_review must enqueue a slip image task");

// ===========================================================================
// approve_manual_review_payment: creates NO new image-delivery rows — the
// slip_manual_review notification already owns them.
// ===========================================================================
assert.doesNotMatch(approveBody, /notification_image_deliveries/, "approve_manual_review_payment must never insert into notification_image_deliveries");
assert.doesNotMatch(approveBody, /v_face_path|v_slip_path/, "approve_manual_review_payment must not need any image lookups");

// ===========================================================================
// transition_slot_booking (admin override): face image only — never a slip,
// never implies a payment was received.
// ===========================================================================
assert.match(transitionBody, /select bi\.storage_path into v_face_path/, "admin override must still attach the face image");
assert.match(transitionBody, /order by bi\.created_at desc, bi\.id desc/, "admin override's face lookup must break created_at ties on id");
assert.match(transitionBody, /'face', v_face_path/, "admin override must enqueue a face image task");
assert.doesNotMatch(transitionBody, /payment_slip_images|'payment_slip'/, "admin override must never reference slip evidence or enqueue a slip task");
assert.doesNotMatch(transitionBody, /expected_amount_satang|received_amount_satang/, "admin override must never include amount fields — it has no verified payment");

// ===========================================================================
// Atomicity: one BEGIN/COMMIT, same convention as every other migration.
// ===========================================================================
{
  const normalized = migration.replace(/\r\n?/g, "\n");
  const beginIdx = normalized.indexOf("\nbegin;\n");
  assert.ok(beginIdx !== -1, "migration must open with an explicit begin;");
  const commitMatches = [...normalized.matchAll(/\ncommit;\n/g)];
  assert.equal(commitMatches.length, 1, "migration must contain exactly one commit;");
  assert.doesNotMatch(normalized, /\brollback;/, "migration must never roll back on its own");
}

// ===========================================================================
// The TS upload route stores evidence AFTER validation/verification/policy
// checks pass, never before — and it never claims the slip goes unstored.
// ===========================================================================
const routeSrc = readSrc("src/app/api/pay/[token]/slip/route.ts");
assert.doesNotMatch(routeSrc, /NEVER stored or logged/, "route header must no longer claim the slip is never stored");
assert.match(routeSrc, /storeSlipEvidence\(/, "route must call the evidence-storage helper");
assert.ok(
  routeSrc.indexOf("storeSlipEvidence(db, order.id, order.booking_id") < routeSrc.indexOf("confirmSlipPayment({"),
  "evidence must be stored before calling confirmSlipPayment",
);
assert.match(routeSrc, /\.from\("payment-slips"\)/, "route must upload to the payment-slips bucket");

// ===========================================================================
// Evidence-storage hardening: exceptions never escape (try/catch around
// every storage/DB call), a failed evidence write is durably recorded, and
// cleanup never deletes an object still referenced by an earlier attempt.
// ===========================================================================
const storeFnSrc = routeSrc.slice(routeSrc.indexOf("async function storeSlipEvidence"), routeSrc.indexOf("async function cleanupUnreferencedUpload"));
assert.match(storeFnSrc, /try\s*\{[\s\S]*?\.upload\(/, "the upload call must be wrapped in try/catch");
assert.match(storeFnSrc, /try\s*\{[\s\S]*?payment_slip_images["'`]?\)[\s\S]*?\.insert\(/, "the DB record call must be wrapped in try/catch");
assert.match(routeSrc, /recordEvidenceFailure\(/, "a failed evidence write must be durably recorded");
assert.match(routeSrc, /payment_slip_evidence_failures/, "failures must be recorded in payment_slip_evidence_failures");
const cleanupFnSrc = routeSrc.slice(routeSrc.indexOf("async function cleanupUnreferencedUpload"), routeSrc.indexOf("async function recordEvidenceFailure"));
assert.match(cleanupFnSrc, /count && count > 0\) return/, "cleanup must never remove an object still referenced by an earlier attempt's row");
assert.match(cleanupFnSrc, /\.remove\(\[path\]\)/, "cleanup must only remove the object when nothing references it");

// ===========================================================================
// Release blocker 2: every evidence-storage function must return an
// explicit typed outcome — a returned {error} from Supabase must never be
// silently ignored, and the route must never treat evidence as fully
// handled just because storeSlipEvidence didn't throw.
// ===========================================================================
assert.match(storeFnSrc, /Promise<EvidenceOutcome>/, "storeSlipEvidence must return a typed outcome, not void");
assert.match(storeFnSrc, /return "stored"/, "storeSlipEvidence must return 'stored' on success");
assert.match(storeFnSrc, /return "upload_failed"/, "storeSlipEvidence must return 'upload_failed' on upload failure");
assert.match(storeFnSrc, /return "record_failed"/, "storeSlipEvidence must return 'record_failed' on DB-record failure");
const recordFailureFnSrc = routeSrc.slice(routeSrc.indexOf("async function recordEvidenceFailure"), routeSrc.indexOf("export async function POST"));
assert.match(recordFailureFnSrc, /const \{ error \} = await db\.from\("payment_slip_evidence_failures"\)\.insert/, "recordEvidenceFailure must inspect the insert's returned error, not just catch a thrown exception");
assert.match(recordFailureFnSrc, /if \(error\)/, "recordEvidenceFailure must branch on a returned {error}");
assert.match(recordFailureFnSrc, /Promise<"recorded" \| "failed">/, "recordEvidenceFailure must return a typed recorded/failed outcome");
assert.match(routeSrc, /const evidenceOutcome = await storeSlipEvidence\(/, "the route must capture storeSlipEvidence's outcome, never discard it");
assert.match(routeSrc, /if \(evidenceOutcome !== "stored"\)/, "the route must explicitly branch when evidence was not durably stored, never silently treat it as the complete happy path");

// ===========================================================================
// Release blocker 3: every upload gets its own unique, immutable object
// path (never reused across attempts) and is written with upsert: false;
// cleanup is scoped to the exact uploaded path, never to the whole order.
// ===========================================================================
assert.match(storeFnSrc, /\$\{bookingId\}\/\$\{orderId\}\/\$\{crypto\.randomUUID\(\)\}\.\$\{SLIP_EXT\[mimeType\]\}/, "each upload must get its own unique uuid-based object path");
assert.match(storeFnSrc, /upsert:\s*false/, "uploads must never overwrite an existing object (upsert: false)");
assert.match(cleanupFnSrc, /\.eq\("storage_path", path\)/, "cleanup must check the exact uploaded path, not just the order, since paths are now unique per attempt");
assert.doesNotMatch(cleanupFnSrc, /\.eq\("payment_order_id"/, "cleanup must no longer scope by payment_order_id now that paths are unique per attempt");

console.log("payment-slip-notification-image self-check passed");
