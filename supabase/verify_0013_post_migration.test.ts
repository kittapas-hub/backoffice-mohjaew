import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(join(repoRoot, "supabase", "verify_0013_post_migration.sql"), "utf8");
const executable = sql.replace(/^\s*--.*$/gm, "").trim();
const executableWithoutLiterals = executable.replace(/'(?:''|[^'])*'/g, "''");

assert.equal((executableWithoutLiterals.match(/;/g) ?? []).length, 1, "postflight must remain one read-only SQL statement");
assert.doesNotMatch(executableWithoutLiterals, /\b(insert|update|delete|merge|create|alter|drop|truncate|execute|begin|commit|rollback|do)\b/i, "postflight must remain read-only");
assert.doesNotMatch(executableWithoutLiterals, /\bexecute\s*\(/i, "postflight must not use dynamic SQL");
assert.doesNotMatch(sql, /LINE_BOOKING_GROUP_ID/i, "the postflight must not inspect or expose LINE configuration");
// Signature strings like 'public.confirm_slip_payment(...)' are legitimate
// to_regprocedure() catalog lookups (masked to '' above) — this only guards
// against an actual unmasked invocation appearing in executable SQL.
assert.doesNotMatch(executableWithoutLiterals, /\bpublic\.(?:create_slip_payment_order|confirm_slip_payment|approve_manual_review_payment|claim_team_notification_deliveries|complete_notification_delivery|transition_slot_booking|get_open_slots)\s*\(/i, "the postflight must not call application RPCs");

for (const check of [
  "payment_slips_bucket_private",
  "required_0013_columns",
  "required_0013_indexes",
  "notification_image_deliveries_unique_per_kind",
  "payment_slip_tables_rls_and_acl",
  "image_delivery_rpcs_present_and_hardened",
  "image_delivery_rpc_acl_service_role_only",
  "confirmation_functions_present",
  "confirm_slip_payment_and_admin_override_enqueue_face",
  "only_confirm_slip_payment_enqueues_slip",
  "approve_manual_review_payment_creates_no_image_rows",
  "retired_image_storage_path_field_absent_from_payload",
  "no_debug_functions_remain",
]) {
  assert.match(sql, new RegExp(`['"]${check}['"]`), `missing postflight check: ${check}`);
}

assert.match(sql, /payment-slips/, "must check the payment-slips bucket");
assert.match(sql, /payment_slip_images/, "must check the payment_slip_images table");
assert.match(sql, /payment_slip_evidence_failures/, "must check the payment_slip_evidence_failures table");
assert.match(sql, /notification_image_deliveries/, "must check the notification_image_deliveries table");
assert.match(sql, /claim_notification_image_deliveries/, "must check the image claim RPC");
assert.match(sql, /complete_notification_image_delivery/, "must check the image completion RPC");
assert.match(sql, /search_path=public, pg_temp/, "image delivery RPCs must be search_path-pinned SECURITY DEFINER");
assert.match(sql, /image_storage_path/, "must check that the retired image_storage_path field is gone from all three functions");

console.log("0013 post-migration verifier static checks passed");
