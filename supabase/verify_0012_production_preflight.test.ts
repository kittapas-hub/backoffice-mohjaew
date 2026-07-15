import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const sql = readFileSync(join(repoRoot, "supabase", "verify_0012_production_preflight.sql"), "utf8");

// Mask comments and literals before checking statement-level safety. The
// preflight may mention mutation words inside a read-only function-body regex,
// but those words must never be executable SQL tokens.
const withoutComments = sql
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/--[^\r\n]*/g, " ");
const executableText = withoutComments.replace(/'(?:''|[^'])*'/g, "''");

assert.match(executableText.trim(), /^with\b[\s\S]*select\s+check_name\s*,\s*status\s*,\s*evidence\s+from\s+checks\s+order\s+by\s+check_name\s*;$/i);
assert.equal((executableText.match(/;/g) ?? []).length, 1, "the preflight must be one SQL statement");
assert.doesNotMatch(executableText, /\b(insert|update|delete|merge|create|alter|drop|truncate|execute|begin|commit|rollback|do)\b/i, "the preflight must remain read-only");
assert.doesNotMatch(executableText, /\bexecute\s*\(/i, "the preflight must not use dynamic SQL");
assert.doesNotMatch(sql, /LINE_BOOKING_GROUP_ID/i, "the preflight must not inspect or expose LINE configuration");
assert.doesNotMatch(sql, /\bpublic\.(?:create_slip_payment_order|confirm_slip_payment|approve_manual_review_payment|claim_team_notification_deliveries|complete_notification_delivery|transition_slot_booking|get_open_slots)\s*\(/i, "the preflight must not call application RPCs");

assert.match(sql, /6b868508e4c61c1a5cfa37297ed4f9a369fc6732/g);
assert.match(sql, /66001e73bf7db093802f495631b3ee1b4f9f1eb6/g);

for (const checkName of [
  "required_tables",
  "required_columns",
  "required_not_null_columns",
  "0011_indexes_intact",
  "0011_tables_columns_rls_privileges_safe",
  "0011_trust_immutability_trigger_intact",
  "0011_privileged_rpcs_intact",
  "0010_get_open_slots_read_only",
  "canonical_sessions_intact",
  "no_open_legacy_hourly_slots",
  "payment_ledger_uniqueness",
  "payment_order_trust_constraint_intact",
  "migration_0012_changes_absent",
  "notification_rows_compatible_with_image_retry_key",
  "line_retry_key_non_null_and_unique",
  "no_duplicate_booking_confirmed_idempotency_keys",
  "required_summary_source_columns",
  "booking_faces_bucket_private",
  "no_customer_booking_confirmed_rows",
  "pgcrypto_gen_random_uuid_available",
  "claim_rpc_signature_has_no_conflict",
  "source_provenance",
]) {
  assert.match(sql, new RegExp(`['"]${checkName}['"]`), `missing preflight check: ${checkName}`);
}

console.log("0012 production preflight static checks passed");
