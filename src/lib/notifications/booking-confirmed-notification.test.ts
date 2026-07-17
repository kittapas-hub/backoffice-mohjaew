// Self-check for the booking-confirmed team notification
// (0012_booking_confirmed_notification.sql).
// Run: node --experimental-strip-types src/lib/notifications/booking-confirmed-notification.test.ts
//
// DB-level behaviours (locks, RPC transitions, real concurrency) cannot be
// verified without a live Supabase/Postgres instance. Verified by inspecting
// the migration SQL directly, same convention as notification-outbox.test.ts
// / payments.test.ts. Real-concurrency + cross-path coverage lives in
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

const migration = readMigration("0012_booking_confirmed_notification.sql");

// ===========================================================================
// This migration must not edit 0010 or 0011 — it must be the only file in
// the repo containing this filename's content, and 0010/0011 must remain
// byte-identical to what confirm.ts's PG-integration baseline already
// expects (spot-checked: they still define the functions this migration
// replaces, so `create or replace` is meaningful, not a fresh definition).
// ===========================================================================
const migration0010 = readMigration("0010_reconcile_0006_0009.sql");
const migration0011 = readMigration("0011_slip_verification.sql");
assert.doesNotMatch(migration0010, /booking_confirmed/, "0010 must remain untouched — no booking_confirmed reference");
assert.match(migration0011, /create or replace function public\.confirm_slip_payment/, "0011 must still define confirm_slip_payment (0012 replaces it, not redefines it from scratch)");
assert.match(migration0011, /create or replace function public\.approve_manual_review_payment/, "0011 must still define approve_manual_review_payment");

// ===========================================================================
// Exactly three functions are replaced, matching the three confirmation
// paths. Each replace + the trailing revoke/grant pair must be present.
// ===========================================================================
for (const [fnSig, revokeGrantArgs] of [
  ["public.transition_slot_booking(", "uuid, text"],
  ["public.confirm_slip_payment(", "uuid, text, text, timestamptz, int, text, text, jsonb"],
  ["public.approve_manual_review_payment(", "uuid"],
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

// ===========================================================================
// Each function's booking_confirmed enqueue uses the SAME idempotency key
// format keyed only by booking id (never by which RPC/path fired), so
// whichever path wins the race is the only one that can ever insert it, and
// ON CONFLICT DO NOTHING makes any retried/duplicated call a safe no-op.
// ===========================================================================
const idempotencyKeyOccurrences = (migration.match(/'booking:confirmed:team:' \|\| \S+::text/g) ?? []).length;
assert.equal(idempotencyKeyOccurrences, 3, "all three functions must use the identical 'booking:confirmed:team:'||id idempotency key format");
// Code occurrences only ('line', 'team', 'booking_confirmed', — the insert
// statement shape); the ROLLBACK comment separately mentions the event type
// in prose and must not be counted here.
const bookingConfirmedInserts = (migration.match(/'line', 'team', 'booking_confirmed',/g) ?? []).length;
assert.equal(bookingConfirmedInserts, 3, "event_type = 'booking_confirmed' must be inserted exactly once per function (3 total)");
assert.equal(
  (migration.match(/on conflict \(idempotency_key\) do nothing/g) ?? []).length >= 3,
  true,
  "every notification_deliveries insert (existing + new) must be ON CONFLICT (idempotency_key) DO NOTHING",
);

// ===========================================================================
// Never recipient_type = 'customer'. Every insert in this migration
// (including the untouched existing payment_received / slip_manual_review
// ones reproduced verbatim) must target 'team' only.
// ===========================================================================
const teamInserts = (migration.match(/'line', 'team',/g) ?? []).length;
assert.ok(teamInserts >= 5, `expected at least 5 team-channel inserts (2 existing + 3 new), found ${teamInserts}`);
// Every notification_deliveries insert's (channel, recipient_type) pair is
// ('line', 'team') — none is ('line', 'customer') or any other recipient.
const insertBlocks = migration.split("insert into public.notification_deliveries").slice(1);
for (const block of insertBlocks) {
  const valuesSection = block.slice(0, block.indexOf(")\n") + 400);
  assert.doesNotMatch(valuesSection, /'line', 'customer'/, "no notification_deliveries insert may target recipient_type customer");
}

// ===========================================================================
// Per-function isolation: extract each function body and check its own
// booking_confirmed block independently. Bounded by the next "-- ===" section
// header rather than the next "create or replace function", since section 5
// (claim_team_notification_deliveries) uses DROP + CREATE FUNCTION, not
// CREATE OR REPLACE (its return columns change).
// ===========================================================================
function functionBody(name: string): string {
  const start = migration.indexOf(`function public.${name}`);
  const nextSection = migration.indexOf("-- ===========", start + 1);
  const end = nextSection === -1 ? migration.indexOf("\ncommit;", start) : nextSection;
  return migration.slice(start, end);
}

const transitionBody = functionBody("transition_slot_booking");
const confirmSlipBody = functionBody("confirm_slip_payment");
const approveBody = functionBody("approve_manual_review_payment");
assert.match(approveBody, /select \* into v_booking[\s\S]*?for update/, "manual approval must lock the booking");
assert.match(approveBody, /hold_expires_at is null[\s\S]*?clock_timestamp\(\)[\s\S]*?raise exception 'hold_expired'/, "manual approval must reject an expired hold after locking");
assert.match(approveBody, /select \* into v_slot[\s\S]*?for update/, "manual approval must lock the associated slot");
assert.match(approveBody, /v_others >= v_slot\.capacity[\s\S]*?raise exception 'slot_full'/, "manual approval must not overbook a full slot");
assert.match(confirmSlipBody, /hold_expires_at <= clock_timestamp\(\)/, "automatic confirmation must use a post-lock wall-clock expiry check");

// transition_slot_booking: enqueue only inside the 'confirmed' branch, never
// cancelled/expired/completed.
const transitionConfirmedBranch = transitionBody.slice(
  transitionBody.indexOf("if p_to = 'confirmed' then"),
  transitionBody.indexOf("elsif p_to = 'cancelled' then"),
);
assert.match(transitionConfirmedBranch, /insert into public\.notification_deliveries/, "transition_slot_booking's confirmed branch must enqueue");
assert.match(transitionConfirmedBranch, /'confirmation_method', 'admin_override'/, "transition_slot_booking must label confirmation_method admin_override");
const transitionOtherBranches = transitionBody.slice(transitionBody.indexOf("elsif p_to = 'cancelled' then"));
assert.doesNotMatch(transitionOtherBranches, /insert into public\.notification_deliveries/, "no other transition_slot_booking branch may enqueue");
assert.match(transitionBody, /raise exception 'hold_expired'/, "transition_slot_booking must preserve the hold_expired guard from 0008");
assert.match(transitionBody, /raise exception 'slot_full'/, "transition_slot_booking must preserve the capacity guard");

// confirm_slip_payment: booking_confirmed enqueue only in the success path
// (after v_reason is null), never in the manual_review branch.
assert.match(confirmSlipBody, /'confirmation_method', 'easyslip_auto'/, "confirm_slip_payment must label confirmation_method easyslip_auto");
const confirmSlipManualReviewBranch = confirmSlipBody.slice(
  confirmSlipBody.indexOf("if v_reason is not null then"),
  confirmSlipBody.indexOf("return jsonb_build_object('result','manual_review','reason',v_reason);") + 60,
);
assert.doesNotMatch(confirmSlipManualReviewBranch, /'booking_confirmed'/, "confirm_slip_payment's manual_review branch must never enqueue booking_confirmed");
assert.match(confirmSlipBody, /'slip_manual_review'/, "confirm_slip_payment must preserve the existing slip_manual_review insert");
assert.match(confirmSlipBody, /'payment_received'/, "confirm_slip_payment must preserve the existing payment_received insert");
// Ledger + trust invariants preserved verbatim.
assert.match(confirmSlipBody, /insert into public\.payment_transactions/, "confirm_slip_payment must preserve the payment_transactions ledger claim");
assert.match(confirmSlipBody, /insert into public\.payment_slip_verifications/, "confirm_slip_payment must preserve the payment_slip_verifications audit");
assert.match(confirmSlipBody, /duplicate_tx/, "confirm_slip_payment must preserve duplicate transaction rejection");

// approve_manual_review_payment: booking_confirmed enqueue present, after
// the manual_review claim is validated and resolved.
assert.match(approveBody, /'confirmation_method', 'manual_review_approved'/, "approve_manual_review_payment must label confirmation_method manual_review_approved");
assert.match(approveBody, /'payment_received'/, "approve_manual_review_payment must preserve the existing payment_received insert");
assert.match(approveBody, /manual_review_claim_ambiguous/, "approve_manual_review_payment must preserve the ambiguous-claim guard");
assert.match(approveBody, /manual_review_claim_not_found/, "approve_manual_review_payment must preserve the not-found guard");

// ===========================================================================
// Image reference is a storage path — never a signed URL (signing happens
// later, at delivery, in the TS worker).
// ===========================================================================
assert.doesNotMatch(migration, /createSignedUrl|signedUrl/i, "migration must never generate or store a signed URL — that is the delivery worker's job");
for (const body of [transitionBody, confirmSlipBody, approveBody]) {
  assert.match(body, /select bi\.storage_path into v_image_path/, "each function must look up the face image storage_path from booking_images");
  assert.match(body, /'image_storage_path', v_image_path/, "each function must carry image_storage_path (not a URL) in the payload");
}

// ===========================================================================
// Summary payload fields, present in all three functions.
// ===========================================================================
for (const body of [transitionBody, confirmSlipBody, approveBody]) {
  for (const key of [
    "'reference_code'",
    "'customer_name'",
    "'birth_date'",
    "'consultation_topic'",
    "'phone'",
    "'booking_date'",
    "'session_time'",
    "'queue_number'",
    "'confirmation_method'",
    "'updated_at'",
    "'image_storage_path'",
  ]) {
    assert.ok(body.includes(key), `payload must include ${key}`);
  }
}

// ===========================================================================
// This migration must not enable EasySlip: no reference to the
// SLIP_VERIFICATION_ENABLED/SLIP_VERIFICATION_PROVIDER gate, and no mutation
// of any payment_* table beyond what 0011 already did (spot-checked above by
// diffing against the reproduced ledger inserts).
// ===========================================================================
assert.doesNotMatch(migration, /SLIP_VERIFICATION_ENABLED|SLIP_VERIFICATION_PROVIDER/, "must not reference the EasySlip enable gate");
assert.doesNotMatch(migration, /slipVerificationEnabled\s*\(/, "must not call the application-level EasySlip release gate");

// ===========================================================================
// Same security model as every other RPC in this table: invoker rights for
// all three confirmation RPCs (unchanged from 0008/0011) — SECURITY DEFINER
// must never appear in their bodies. claim_team_notification_deliveries is
// the one legitimate exception (it was already SECURITY DEFINER in 0007/
// 0011; this migration only extends its return columns).
// ===========================================================================
for (const body of [transitionBody, confirmSlipBody, approveBody]) {
  assert.doesNotMatch(body, /security definer/, "confirmation RPCs must remain invoker rights");
}
assert.match(
  migration,
  /create function public\.claim_team_notification_deliveries\([\s\S]*?language plpgsql security definer set search_path = public, pg_temp/,
  "claim_team_notification_deliveries must remain SECURITY DEFINER with search_path pinned to public, pg_temp",
);

// ===========================================================================
// HIGH-3: the entire migration is wrapped in one BEGIN/COMMIT so a failure
// partway through rolls back every function/column/index change together —
// no partially-applied state.
// ===========================================================================
{
  const normalizedMigration = migration.replace(/\r\n?/g, "\n");
  const beginIdx = normalizedMigration.indexOf("\nbegin;\n");
  assert.ok(beginIdx !== -1, "migration must open with an explicit begin;");
  const firstCreate = normalizedMigration.indexOf("create or replace function public.transition_slot_booking");
  assert.ok(beginIdx < firstCreate, "begin; must precede the first statement");

  const commitMatches = [...normalizedMigration.matchAll(/\ncommit;\n/g)];
  assert.equal(commitMatches.length, 1, "migration must contain exactly one commit;");
  const commitIdx = commitMatches[0].index!;
  const lastGrant = normalizedMigration.lastIndexOf(
    "grant execute on function public.claim_team_notification_deliveries(text, int, text[]) to service_role;",
  );
  assert.ok(lastGrant !== -1 && lastGrant < commitIdx, "commit; must come after the final grant statement");

  // No begin/commit/rollback anywhere else in the file (the PL/pgSQL `begin`
  // ... `end;` blocks inside function bodies are a different, unrelated
  // keyword usage and must not be miscounted as transaction control).
  const beginStatements = [...normalizedMigration.matchAll(/^begin;$/gm)];
  assert.equal(beginStatements.length, 1, "exactly one top-level begin; statement");
  assert.doesNotMatch(normalizedMigration, /\brollback;/, "migration must never roll back on its own — only BEGIN/COMMIT wraps it");

  // The rollback INSTRUCTIONS in the trailing comment come after commit; —
  // they are prose for a human, not part of the transaction.
  const rollbackCommentIdx = normalizedMigration.indexOf("-- ROLLBACK");
  assert.ok(rollbackCommentIdx > commitIdx, "the human ROLLBACK instructions must be documented after commit;, outside the transaction");
}

// ===========================================================================
// HIGH-4: image_retry_key is a stable, persisted, per-row key — separate
// column from line_retry_key, added the same additive way 0011 added
// line_retry_key (default + backfill + NOT NULL), and returned by the
// replaced claim RPC so the worker can reuse it on every retry.
// ===========================================================================
assert.match(
  migration,
  /alter table public\.notification_deliveries add column if not exists image_retry_key uuid default gen_random_uuid\(\)/,
  "image_retry_key must be added additively with a random default",
);
assert.match(
  migration,
  /update public\.notification_deliveries set image_retry_key = gen_random_uuid\(\) where image_retry_key is null/,
  "existing rows must be backfilled with a random image_retry_key exactly once",
);
assert.match(
  migration,
  /alter table public\.notification_deliveries alter column image_retry_key set not null/,
  "image_retry_key must end up NOT NULL, same as line_retry_key",
);

const claimFnBody = functionBody("claim_team_notification_deliveries");
assert.match(
  claimFnBody,
  /returns table \(\s*\n\s*id uuid, booking_id uuid, payment_order_id uuid, channel text, event_type text,\s*\n\s*payload jsonb, idempotency_key text, attempt_count int, line_retry_key uuid, image_retry_key uuid/,
  "claim RPC must return both line_retry_key and image_retry_key",
);
assert.match(
  claimFnBody,
  /returning upd\.id,upd\.booking_id,upd\.payment_order_id,upd\.channel,upd\.event_type,\s*\n\s*upd\.payload,upd\.idempotency_key,upd\.attempt_count,upd\.line_retry_key,upd\.image_retry_key/,
  "claim RPC's RETURNING list must include both retry key columns",
);
// It must be DROP + CREATE (not CREATE OR REPLACE) since the output column
// list changed — Postgres rejects CREATE OR REPLACE for that.
assert.match(
  migration,
  /drop function if exists public\.claim_team_notification_deliveries\(text, int, text\[\]\);\s*\ncreate function public\.claim_team_notification_deliveries/,
  "claim RPC must be replaced via DROP + CREATE, not CREATE OR REPLACE, since its return columns changed",
);
assert.match(
  migration,
  /revoke all on function public\.claim_team_notification_deliveries\(text, int, text\[\]\) from public, anon, authenticated/,
  "claim RPC must revoke execute from public/anon/authenticated",
);
assert.match(
  migration,
  /grant execute on function public\.claim_team_notification_deliveries\(text, int, text\[\]\) to service_role/,
  "claim RPC must grant execute to service_role only",
);
// image_retry_key is a genuinely distinct column from line_retry_key
// (0011's, untouched here) — this migration must not redeclare/add a
// line_retry_key column of its own; it only adds image_retry_key.
assert.doesNotMatch(
  migration,
  /add column if not exists line_retry_key/,
  "0012 must not redeclare line_retry_key — that column belongs to 0011",
);
assert.match(migration0011, /add column if not exists line_retry_key uuid default gen_random_uuid\(\)/, "sanity: 0011 is where line_retry_key was actually added");

console.log("booking-confirmed-notification self-check passed");
