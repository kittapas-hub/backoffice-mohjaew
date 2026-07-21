import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const sql = readFileSync(join(repoRoot, "supabase", "verify_0013_production_preflight.sql"), "utf8");
const MIGRATION_PATH = "supabase/migrations/0013_payment_slip_notification_image.sql";

const withoutComments = sql
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/--[^\r\n]*/g, " ");
const executableText = withoutComments.replace(/'(?:''|[^'])*'/g, "''");

assert.match(executableText.trim(), /^with\b/i, "preflight must be a single WITH query");
assert.match(
  executableText.trim(),
  /select\s*check_name\s*,\s*case when pass then '' else '' end as status\s*,\s*evidence\s*from checks\s*order by check_name;$/i,
  "preflight's final select must return check_name, status, evidence from checks",
);
assert.equal((executableText.match(/;/g) ?? []).length, 1, "the preflight must be one SQL statement");
assert.doesNotMatch(executableText, /\b(insert|update|delete|merge|create|alter|drop|truncate|execute|begin|commit|rollback|do)\b/i, "the preflight must remain read-only");
assert.doesNotMatch(executableText, /\bexecute\s*\(/i, "the preflight must not use dynamic SQL");
assert.doesNotMatch(sql, /LINE_BOOKING_GROUP_ID/i, "the preflight must not inspect or expose LINE configuration");
// Signature strings like 'public.confirm_slip_payment(...)' are legitimate
// to_regprocedure() catalog lookups (masked to '' above like every other
// string literal) — this only guards against an actual unmasked invocation
// of the form public.confirm_slip_payment( appearing in executable SQL.
assert.doesNotMatch(executableText, /\bpublic\.(?:create_slip_payment_order|confirm_slip_payment|approve_manual_review_payment|claim_team_notification_deliveries|complete_notification_delivery|transition_slot_booking|get_open_slots)\s*\(/i, "the preflight must not call application RPCs");

// ===========================================================================
// source_provenance is blob-only (see this SQL file's own header comment for
// why a commit-hash literal is deliberately not used here) — it recomputes
// git hash-object independently and fails the suite the moment the hardcoded
// literal drifts from the migration file's actual content. Same enforcement
// mechanism added for 0012's source_provenance defect
// (verify_0012_production_preflight.test.ts).
// ===========================================================================
const actualBlob = execFileSync("git", ["hash-object", MIGRATION_PATH], { cwd: repoRoot, encoding: "utf8" }).trim();
assert.match(actualBlob, /^[0-9a-f]{40}$/, "sanity: git hash-object must return a real blob hash");

const blobLiteral = sql.match(/migration_blob = '([0-9a-f]{40})'/);
assert.ok(blobLiteral, "source_provenance must hardcode a 40-hex migration_blob literal");
assert.equal(
  blobLiteral![1],
  actualBlob,
  `source_provenance's migration_blob is stale (hardcoded ${blobLiteral![1]}, actual ${actualBlob}). ` +
    `Re-run \`git hash-object ${MIGRATION_PATH}\` and update both literals in supabase/verify_0013_production_preflight.sql.`,
);
assert.equal((sql.match(new RegExp(actualBlob, "g")) ?? []).length, 2, "migration_blob literal must appear exactly twice (CASE + values row)");

for (const checkName of [
  "source_provenance",
  "required_0012_function_baseline",
  "required_pre_0013_columns",
  "migration_0013_objects_absent",
  "pre_0013_functions_still_use_image_storage_path",
  "pgcrypto_available_for_payment_slip_images_default",
]) {
  assert.match(sql, new RegExp(`['"]${checkName}['"]`), `missing preflight check: ${checkName}`);
}

console.log("0013 production preflight static checks passed");
