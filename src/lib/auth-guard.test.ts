// Guard test: every admin page and every admin mutation action must enforce
// requireAdmin. This is a static check (no DB needed) that fails if a new
// admin route/action ships without the auth guard.
// Run: node --experimental-strip-types src/lib/auth-guard.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app");

// Admin pages must call requireAdmin().
const pages = [
  "admin/page.tsx",
  "admin/bookings/[id]/page.tsx",
  "admin/day/page.tsx",
];
for (const p of pages) {
  const src = readFileSync(join(appDir, p), "utf8");
  assert.match(src, /requireAdmin\(\)/, `${p} must call requireAdmin()`);
}

// Each guarded mutation action must contain requireAdmin in its own body.
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `action ${name} not found`);
  const next = src.indexOf("export async function ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

const actionFiles: Record<string, string[]> = {
  "admin/actions.ts": ["updateStatus", "transitionSlotBooking", "confirmPayment", "confirmBookingOverride"],
  "admin/day/actions.ts": ["seedDaySlots", "updateSlotCapacity", "toggleSlot"],
};

for (const [file, names] of Object.entries(actionFiles)) {
  const src = readFileSync(join(appDir, file), "utf8");
  for (const name of names) {
    assert.match(
      fnBody(src, name),
      /await requireAdmin\(\)/,
      `${file}:${name} must await requireAdmin()`,
    );
  }
}

// confirmPayment must never read the 'to' field from FormData — the target
// status is hardcoded server-side so a forged FormData cannot change it.
{
  const src = readFileSync(join(appDir, "admin/actions.ts"), "utf8");
  const body = fnBody(src, "confirmBookingOverride");
  assert.doesNotMatch(
    body,
    /formData\.get\(["']to["']\)/,
    "confirmPayment must not read 'to' from FormData",
  );
  assert.match(
    body,
    /p_to:\s*["']confirmed["']/,
    "confirmPayment must hardcode p_to: \"confirmed\"",
  );
  assert.match(
    body,
    /\.from\(\s*["']bookings["']\s*\)[\s\S]*?\.select\(\s*["']status, slot_id, hold_expires_at["']\s*\)[\s\S]*?\.maybeSingle\(\)/,
    "confirmPayment must first load an existing booking",
  );
  assert.match(
    body,
    /booking\?\.status !== ["']pending_payment["']/,
    "confirmPayment must reject missing and non-pending bookings",
  );
  assert.match(
    body,
    /!booking\.slot_id/,
    "confirmPayment must reject a pending_payment record without a slot",
  );
  // Payment Hold Safety: reject a lapsed hold using the booking's own
  // persisted hold_expires_at compared against the server clock — never a
  // client-supplied time or expiry value.
  assert.match(
    body,
    /new Date\(booking\.hold_expires_at\)\.getTime\(\)\s*<=\s*Date\.now\(\)/,
    "confirmPayment must reject a booking whose hold_expires_at has passed",
  );
  assert.doesNotMatch(
    body,
    /formData\.get\(["'](holdExpiresAt|now|expiresAt)["']\)/,
    "confirmPayment must never read a client-supplied expiry/time value",
  );
  assert.doesNotMatch(
    body,
    /\.insert\(|create_booking|createSlotBooking/,
    "confirmPayment must never create a booking",
  );
}

// Verified manual payment approval accepts only the booking id and delegates
// transaction selection to the restricted PostgreSQL approval RPC.
{
  const src = readFileSync(join(appDir, "admin/actions.ts"), "utf8");
  const body = fnBody(src, "confirmPayment");
  assert.match(body, /rpc\(["']approve_manual_review_payment["']/);
  assert.doesNotMatch(body, /formData\.get\(["'](transaction|txRef|providerTxRef)["']\)/);
  assert.doesNotMatch(body, /transition_slot_booking/);
}

// A slotless LINE inquiry may be contacted/cancelled, but never confirmed as a
// real queue through the legacy direct-update action.
{
  const src = readFileSync(join(appDir, "admin/actions.ts"), "utf8");
  const body = fnBody(src, "updateStatus");
  assert.match(body, /\.select\(\s*["']slot_id, source["']\s*\)/);
  assert.match(
    body,
    /bk\?\.source === ["']line["'] && status === ["']confirmed["']/,
    "slotless LINE inquiries must not be directly confirmed",
  );
}

// Public API routes must NOT be behind requireAdmin (they're customer-facing).
for (const r of ["api/bookings/route.ts", "api/slots/route.ts"]) {
  const src = readFileSync(join(appDir, r), "utf8");
  assert.doesNotMatch(src, /requireAdmin/, `${r} should be public`);
}

console.log("auth-guard self-check passed");
