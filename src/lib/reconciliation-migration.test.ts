// Focused source-level checks for the production-baseline reconciliation.
// These checks do not connect to PostgreSQL or execute either migration.
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const path = (relative: string) => join(repoRoot, relative);
const read = (relative: string) => readFileSync(path(relative), "utf8").replace(/\r\n/g, "\n");

const reconciliationPath = "supabase/migrations/0010_reconcile_0006_0009.sql";
const slipPath = "supabase/migrations/0011_slip_verification.sql";
const oldSlipPath = "supabase/migrations/0010_slip_verification.sql";
const verificationPath = "supabase/verify_0010_reconciliation.sql";

assert.ok(existsSync(path(reconciliationPath)), "reconciliation migration must be 0010");
assert.ok(existsSync(path(slipPath)), "unapplied slip migration must be 0011");
assert.ok(!existsSync(path(oldSlipPath)), "the old slip-migration filename must be unused");

const reconciliation = read(reconciliationPath);
const migration0006 = read("supabase/migrations/0006_read_only_get_open_slots.sql");
const verification = read(verificationPath);

function getOpenSlotsDefinitionAndAccess(sql: string): string {
  const start = sql.indexOf("create or replace function public.get_open_slots");
  assert.ok(start >= 0, "get_open_slots replacement must exist");
  const tail = sql.slice(start);
  const finalAccess = "grant execute on function public.get_open_slots(date) to service_role;";
  const end = tail.indexOf(finalAccess);
  assert.ok(end >= 0, "get_open_slots service-role access must exist");
  return tail.slice(0, end + finalAccess.length);
}

assert.equal(
  getOpenSlotsDefinitionAndAccess(reconciliation),
  getOpenSlotsDefinitionAndAccess(migration0006),
  "0010 must reproduce the exact 0006 function definition and access boundary",
);

const withoutComments = reconciliation.replace(/^\s*--.*$/gm, "").trim();
assert.match(withoutComments, /^begin;/i, "migration must open an explicit transaction");
assert.match(withoutComments, /commit;$/i, "migration must close the transaction");

const conflictGuard = withoutComments.indexOf("queue_session_reconciliation_blocked");
const firstSlotChange = withoutComments.indexOf("update public.booking_slots");
const canonicalWrite = withoutComments.indexOf("insert into public.booking_slots");
const functionChange = withoutComments.indexOf(
  "create or replace function public.get_open_slots",
);
assert.ok(conflictGuard >= 0, "affected bookings must have an explicit stop condition");
assert.ok(firstSlotChange > conflictGuard, "booking stop condition must precede slot closure");
assert.ok(canonicalWrite > conflictGuard, "booking stop condition must precede session creation");
assert.ok(functionChange > conflictGuard, "booking stop condition must precede function replacement");
assert.doesNotMatch(
  withoutComments.slice(0, conflictGuard),
  /^\s*(update|insert|delete|alter|create|drop|grant|revoke)\b/im,
  "no mutation may precede the affected-booking stop condition",
);

assert.match(reconciliation, /for update;/i, "affected legacy slots must be row-locked");
assert.match(
  reconciliation,
  /v_legacy_total <> 384 or v_open_legacy <> 384/,
  "migration must fence the verified 384-slot baseline",
);
assert.match(
  reconciliation,
  /v_existing_canonical <> 0/,
  "migration must fence the verified zero-canonical baseline",
);
assert.match(
  reconciliation,
  /v_affected_bookings <> 0/,
  "migration must abort if an affected booking appears",
);
assert.match(reconciliation, /v_closed <> v_legacy_total/);
assert.match(reconciliation, /v_inserted <> v_seeded_dates \* 4/);
assert.match(reconciliation, /v_unexpected_open_legacy <> 0/);
assert.match(reconciliation, /v_bad_canonical_dates <> 0/);
assert.doesNotMatch(reconciliation, /update public\.bookings/i, "bookings must remain untouched");

for (const expected of [
  "('09:00'::time, '12:00'::time, '09:00–12:00 (เช้า)', 5)",
  "('13:00'::time, '16:00'::time, '13:00–16:00 (บ่าย)', 5)",
  "('18:00'::time, '21:00'::time, '18:00–21:00 (เย็น)', 5)",
  "('22:00'::time, '23:00'::time, '22:00–23:00 (พิเศษ)', 2)",
]) {
  assert.ok(reconciliation.includes(expected), `missing canonical definition: ${expected}`);
}

for (const untouched of [
  "public.notification_deliveries",
  "public.claim_team_notification_deliveries",
  "public.complete_notification_delivery",
  "public.transition_slot_booking",
]) {
  assert.ok(!reconciliation.includes(untouched), `0010 must not touch ${untouched}`);
}

const verificationWithoutComments = verification.replace(/^\s*--.*$/gm, "");
assert.equal(
  (verification.match(/;/g) ?? []).length,
  1,
  "focused verification must return one result set",
);
assert.doesNotMatch(
  verificationWithoutComments,
  /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|call|perform|do)\b/i,
  "focused verification must remain read-only",
);
assert.match(verification, /legacy_slot_booking_impact_0009/);
assert.match(verification, /referencing_booking_count/);
assert.match(verification, /booking_status_counts/);
assert.match(verification, /canonical_session_count/);
assert.match(verification, /canonical_rows_with_expected_capacity/);
assert.match(verification, /unexpected_open_legacy_slot_count/);
assert.match(verification, /get_open_slots_is_read_only/);
assert.match(verification, /hold_expired_guard_present/);
assert.match(verification, /definition_fingerprint/);
assert.match(verification, /all_slip_objects_absent/);
assert.doesNotMatch(
  verification,
  /customer_name|phone|birth_date|preferred_date|preferred_time/i,
  "focused verification must not expose customer or booking details",
);

const slipMigration = read(slipPath);
assert.match(slipMigration, /Run AFTER 0010_reconcile_0006_0009\.sql/);

const completeVerification = read("supabase/verify_applied_schema.sql");
assert.match(completeVerification, /\('0011', 'table', 'payment_slip_verifications'\)/);
assert.match(completeVerification, /\('0011', 'function', 'confirm_slip_payment'\)/);

console.log("reconciliation-migration self-check passed");
