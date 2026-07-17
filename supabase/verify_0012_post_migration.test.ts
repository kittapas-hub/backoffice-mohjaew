import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(join(repoRoot, "supabase", "verify_0012_post_migration.sql"), "utf8");
const executable = sql.replace(/^\s*--.*$/gm, "").trim();
const executableWithoutLiterals = executable.replace(/'(?:''|[^'])*'/g, "''");

assert.equal((executableWithoutLiterals.match(/;/g) ?? []).length, 1, "postflight must remain one read-only SQL statement");
assert.doesNotMatch(executableWithoutLiterals, /\b(insert|update|delete|merge|create|alter|drop|truncate|execute|begin|commit|rollback|do)\b/i);
assert.doesNotMatch(executableWithoutLiterals, /\bexecute\s*\(/i);
for (const check of [
  "required_0012_columns",
  "required_idempotency_and_retry_indexes",
  "rpc_signatures_and_security_modes",
  "privileged_rpc_acl_service_role_only",
  "sensitive_table_rls_and_acl",
  "notification_claim_return_signature",
  "booking_confirmed_payload_fields",
  "booking_confirmation_semantics_present",
  "notification_rows_compatible",
  "notification_idempotency_keys_unique",
  "no_debug_functions_remain",
]) {
  assert.match(sql, new RegExp(`['"]${check}['"]`), `missing postflight check: ${check}`);
}
assert.match(sql, /search_path=public, pg_temp/);
assert.match(sql, /image_retry_key/);
assert.match(sql, /clock_timestamp/);
assert.match(sql, /slot_full/);
assert.doesNotMatch(sql, /LINE_CHANNEL_ACCESS_TOKEN|LINE_BOOKING_GROUP_ID|EASYSLIP_API_KEY/);

console.log("0012 post-migration verifier static checks passed");
