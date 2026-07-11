// Self-check for queue-session customer availability filtering and cutover rules.
// Run: node --experimental-strip-types src/lib/session-cutover.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SESSION_CUTOVER_DATE,
  filterCustomerAvailableSlots,
  isCanonicalSessionSlot,
} from "./slot-seeding.ts";

const here = dirname(fileURLToPath(import.meta.url));

function slot(
  start: string,
  end: string,
  remaining: number,
  id = `${start}-${end}`,
) {
  return {
    id,
    booking_date: "2026-07-11",
    start_time: start,
    end_time: end,
    label: `${start}–${end}`,
    capacity: 5,
    occupied: 5 - remaining,
    remaining,
  };
}

// Pre-cutover: hourly slots remain visible to customers.
{
  const pre = filterCustomerAvailableSlots("2026-07-11", [
    slot("09:00", "10:00", 1, "hourly"),
    slot("09:00", "12:00", 2, "session"),
  ]);
  assert.equal(pre.length, 2, "before cutover both hourly and session may appear");
}

// Post-cutover: only canonical session windows.
{
  const post = filterCustomerAvailableSlots(SESSION_CUTOVER_DATE, [
    slot("09:00", "10:00", 1, "hourly"),
    slot("09:00", "12:00", 3, "morning"),
    slot("13:00", "16:00", 5, "afternoon"),
    slot("18:00", "21:00", 0, "evening-full"),
    slot("22:00", "23:00", 1, "special"),
  ]);
  assert.deepEqual(
    post.map((s) => s.id),
    ["morning", "afternoon", "special"],
    "post-cutover customer list excludes hourly and full sessions",
  );
}

assert.equal(isCanonicalSessionSlot("09:00", "12:00"), true);

// Success page continues rendering stored historical labels (hourly text unchanged).
const panelSrc = readFileSync(
  join(here, "..", "app", "booking", "success", "BookingStatusPanel.tsx"),
  "utf8",
);
assert.match(panelSrc, /props\.slotLabel/, "success page still renders stored preferred_time label");
assert.match(
  panelSrc,
  /ลำดับคิวนี้คือลำดับการจองในรอบเซสชัน/,
  "success page clarifies queue is session order not exact call time",
);

console.log("session-cutover self-check passed");
