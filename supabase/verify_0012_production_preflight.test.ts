import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const sql = readFileSync(join(repoRoot, "supabase", "verify_0012_production_preflight.sql"), "utf8");
const MIGRATION_PATH = "supabase/migrations/0012_booking_confirmed_notification.sql";

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

// ===========================================================================
// source_provenance provenance defect hardening (found after a real
// Production preflight run PASSed on a stale marker): the SQL cannot verify
// its own hardcoded commit/blob literals against git — Postgres has no git
// access — so this test recomputes both independently and fails the whole
// suite the moment either literal drifts from reality. This is the only
// thing that stands between a future 0012 edit and a silent false PASS.
// ===========================================================================
const actualBlob = execFileSync("git", ["hash-object", MIGRATION_PATH], { cwd: repoRoot, encoding: "utf8" }).trim();
const actualCommit = execFileSync(
  "git",
  ["log", "-1", "--format=%H", "--", MIGRATION_PATH],
  { cwd: repoRoot, encoding: "utf8" },
).trim();
assert.match(actualBlob, /^[0-9a-f]{40}$/, "sanity: git hash-object must return a real blob hash");
assert.match(actualCommit, /^[0-9a-f]{40}$/, "sanity: git log must find a commit that touched the migration file");

const blobLiteral = sql.match(/migration_blob = '([0-9a-f]{40})'/);
assert.ok(blobLiteral, "source_provenance must hardcode a 40-hex migration_blob literal");
assert.equal(
  blobLiteral![1],
  actualBlob,
  `source_provenance's migration_blob is stale (hardcoded ${blobLiteral![1]}, actual ${actualBlob}). ` +
    `Re-run \`git hash-object ${MIGRATION_PATH}\` and update both literals in supabase/verify_0012_production_preflight.sql.`,
);

const commitLiteral = sql.match(/source_commit = '([0-9a-f]{40})'/);
assert.ok(commitLiteral, "source_provenance must hardcode a 40-hex source_commit literal");
assert.equal(
  commitLiteral![1],
  actualCommit,
  `source_provenance's reviewed_commit is stale (hardcoded ${commitLiteral![1]}, actual ${actualCommit}). ` +
    `Re-run \`git log -1 --format=%H -- ${MIGRATION_PATH}\` and update both literals in supabase/verify_0012_production_preflight.sql.`,
);

// The two values() literals feeding the CASE comparison must match the two
// checked above verbatim — the marker must not silently diverge from itself.
assert.equal((sql.match(new RegExp(actualBlob, "g")) ?? []).length, 2, "migration_blob literal must appear exactly twice (CASE + values row)");
assert.equal((sql.match(new RegExp(actualCommit, "g")) ?? []).length, 2, "source_commit literal must appear exactly twice (CASE + values row)");

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
