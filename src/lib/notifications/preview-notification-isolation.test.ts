import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const migration = read("supabase/migrations/0020_preview_notification_isolation.sql");
const env = read("src/lib/env.ts");
const line = read("src/lib/line.ts");
const confirm = read("src/lib/payments/slip/confirm.ts");
const actions = read("src/app/admin/actions.ts");

assert.match(migration, /^begin;[\s\S]*commit;\s*$/m);
assert.match(migration, /delivery_scope text/);
assert.match(migration, /current_setting\('app\.notification_scope', true\)/);
assert.match(migration, /delivery_scope in \('production','preview'\)/);
assert.match(migration, /d\.delivery_scope = 'production'/);
assert.match(migration, /nd\.delivery_scope = 'production'/);
assert.match(migration, /confirm_slip_payment_scoped[\s\S]*set_config\('app\.notification_scope'/);
assert.match(migration, /approve_manual_review_payment_scoped[\s\S]*set_config\('app\.notification_scope'/);
assert.match(migration, /transition_slot_booking_scoped[\s\S]*set_config\('app\.notification_scope'/);
assert.match(env, /VERCEL_ENV === "production" \? "production" : "preview"/);
assert.doesNotMatch(line, /team notify skipped in preview|image notify skipped in preview/);
assert.match(line, /LINE_CHANNEL_ACCESS_TOKEN/);
assert.match(line, /validateLineGroupId\(process\.env\.LINE_BOOKING_GROUP_ID\)/);
assert.match(confirm, /rpc\("confirm_slip_payment_scoped"/);
assert.match(confirm, /p_delivery_scope: notificationDeliveryScope\(\)/);
assert.match(actions, /rpc\("transition_slot_booking_scoped"/);
assert.match(actions, /rpc\("approve_manual_review_payment_scoped"/);
assert.match(actions, /p_delivery_scope: notificationDeliveryScope\(\)/);

console.log("preview notification isolation self-check passed");
