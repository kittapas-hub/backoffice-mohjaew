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
  "admin/actions.ts": ["updateStatus", "transitionSlotBooking"],
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

// Public API routes must NOT be behind requireAdmin (they're customer-facing).
for (const r of ["api/bookings/route.ts", "api/slots/route.ts"]) {
  const src = readFileSync(join(appDir, r), "utf8");
  assert.doesNotMatch(src, /requireAdmin/, `${r} should be public`);
}

console.log("auth-guard self-check passed");
