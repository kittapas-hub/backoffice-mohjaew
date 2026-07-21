// Self-check for the payment-slip evidence image feature
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
// payment_slip_images: append-only evidence table, same security model as
// payment_slip_verifications/payment_transactions (0011) — RLS enabled, no
// anon/authenticated grants, service_role only.
// ===========================================================================
assert.match(migration, /create table if not exists public\.payment_slip_images/);
for (const col of ["payment_order_id", "booking_id", "storage_path", "mime_type", "created_at"]) {
  assert.ok(migration.includes(col), `payment_slip_images must declare column ${col}`);
}
assert.match(migration, /alter table public\.payment_slip_images enable row level security/);
assert.match(migration, /revoke all on table public\.payment_slip_images from anon, authenticated/);
assert.match(migration, /grant all on table public\.payment_slip_images to service_role/);

// ===========================================================================
// Signed URLs are never generated or stored here — only the private storage
// path, exactly like 0012's face-image handling.
// ===========================================================================
assert.doesNotMatch(migration, /createSignedUrl|signedUrl/i, "migration must never generate or store a signed URL");

// ===========================================================================
// Exactly three functions are replaced, matching 0012's three confirmation
// paths — same signatures, no DROP + CREATE needed (payload gains a jsonb
// key, not a new returned column).
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
// slip_storage_path replaces image_storage_path for the two payment-verified
// RPCs — never reusing the ambiguous face-image field name.
// ===========================================================================
for (const body of [confirmSlipBody, approveBody]) {
  assert.match(body, /select psi\.storage_path into v_slip_path\s*\n\s*from public\.payment_slip_images psi/, "must look up the slip evidence from payment_slip_images");
  assert.match(body, /'slip_storage_path', v_slip_path/, "must carry slip_storage_path (not image_storage_path) in the payload");
  assert.doesNotMatch(body, /image_storage_path|booking_images/, "must not reference the old face-image field or table");
}

// confirm_slip_payment must key the lookup by the current payment order —
// both the manual_review branch and the success branch.
const slipPathLookups = confirmSlipBody.match(/where psi\.payment_order_id = p_payment_order_id/g) ?? [];
assert.equal(slipPathLookups.length, 2, "confirm_slip_payment must look up slip evidence in both its manual_review and success branches");

// approve_manual_review_payment keys the lookup by the order being approved.
assert.match(approveBody, /where psi\.payment_order_id = v_order\.id/, "approve_manual_review_payment must look up slip evidence for the order being approved");

// The slip_manual_review notification (inside confirm_slip_payment) must
// also carry slip_storage_path — the manual-review alert gets the same
// evidence image as a successful confirmation.
const manualReviewBranch = confirmSlipBody.slice(
  confirmSlipBody.indexOf("if v_reason is not null then"),
  confirmSlipBody.indexOf("return jsonb_build_object('result','manual_review','reason',v_reason);") + 60,
);
assert.match(manualReviewBranch, /'slip_storage_path',v_slip_path/, "slip_manual_review payload must include slip_storage_path");

// ===========================================================================
// transition_slot_booking (admin override): no image lookup at all — no
// face, no slip, and no claim that a payment was received.
// ===========================================================================
assert.doesNotMatch(transitionBody, /image_storage_path|slip_storage_path|booking_images|payment_slip_images/, "admin override must never attach any image or reference an image table");
assert.doesNotMatch(transitionBody, /v_image_path/, "admin override's now-unused face-image variable must be removed, not left dangling");

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
// checks pass, and never before — and the file's own header no longer
// claims the image is never stored.
// ===========================================================================
const routeSrc = readSrc("src/app/api/pay/[token]/slip/route.ts");
assert.doesNotMatch(routeSrc, /NEVER stored or logged/, "route header must no longer claim the slip is never stored");
assert.match(routeSrc, /storeSlipEvidence\(/, "route must call the evidence-storage helper");
assert.ok(
  routeSrc.indexOf("storeSlipEvidence(db, order.id, order.booking_id") < routeSrc.indexOf("confirmSlipPayment({"),
  "evidence must be stored before calling confirmSlipPayment",
);
assert.match(routeSrc, /\.from\("payment-slips"\)/, "route must upload to the payment-slips bucket");
assert.match(routeSrc, /\.remove\(\[path\]\)/, "route must best-effort remove the uploaded object if the DB record fails");

console.log("payment-slip-notification-image self-check passed");
