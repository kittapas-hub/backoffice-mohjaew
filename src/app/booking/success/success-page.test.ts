// Self-check for success page helpers, live-status polling, and the LINE
// slip-handoff link. Static/AST checks are used for anything requiring
// Next.js runtime (route.ts, the client panel's effect) — same convention as
// integration-guards.test.ts — since those can't be executed under a plain
// Node run without a bundler/DOM.
// Run: node --experimental-strip-types src/app/booking/success/success-page.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  formatMmSs,
  buildLineHref,
  buildLinePrefill,
  STATUS_POLL_INTERVAL_MS,
  shouldPollStatus,
  MOHJAEW_LINE_OA_ID,
} from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));

// --- formatMmSs -----------------------------------------------------------

assert.equal(formatMmSs(0), "00:00");
assert.equal(formatMmSs(-1), "00:00");
assert.equal(formatMmSs(59_999), "00:59");
assert.equal(formatMmSs(60_000), "01:00");
assert.equal(formatMmSs(125_000), "02:05"); // 2 min 5 sec
assert.equal(formatMmSs(600_000), "10:00"); // 10 min

// --- buildLineHref: always targets the real Mohjaew OA (@695bosga) --------

assert.equal(MOHJAEW_LINE_OA_ID, "695bosga");

// Standard LINE OA URL format → oaMessage deep link with encoded prefill
const oaUrl = "https://line.me/R/ti/p/@mohjaew";
const href = buildLineHref(oaUrl, "hello\nworld");
assert.ok(
  href.startsWith("https://line.me/R/oaMessage/@mohjaew?text="),
  `Expected oaMessage URL, got: ${href}`,
);
assert.ok(href.includes("hello"), "Prefill text should be URL-encoded in href");

// Broken/unknown/missing URL formats must fall back to the real OA — never a
// generic LINE landing page and never the broken URL echoed back unchanged.
for (const broken of ["", "https://lin.ee/abc123", "https://line.me/en"]) {
  const fallbackHref = buildLineHref(broken, "text");
  assert.ok(
    fallbackHref.startsWith(`https://line.me/R/oaMessage/@${MOHJAEW_LINE_OA_ID}?text=`),
    `Broken URL "${broken}" must fall back to the real OA, got: ${fallbackHref}`,
  );
}

// --- buildLinePrefill: reference only, no date/time/PII --------------------

const prefill = buildLinePrefill({ reference: "REF-001" });

assert.ok(prefill.includes("REF-001"), "Must contain reference");
assert.ok(prefill.includes("ส่งสลิปชำระเงิน"), "Must contain the fixed instruction text");

// Must NOT contain PII field labels (name, phone, birthdate) or anything
// beyond the fixed text + reference.
const piiPatterns = ["ชื่อ", "เบอร์", "โทร", "วันเกิด", "เลขบัตร", "หัวข้อ"];
for (const pattern of piiPatterns) {
  assert.ok(!prefill.includes(pattern), `Prefill must not contain PII field: ${pattern}`);
}

// LINE href built from prefill should also not expose PII or tokens.
const lineHrefWithPrefill = buildLineHref(oaUrl, prefill);
for (const pattern of piiPatterns) {
  assert.ok(
    !lineHrefWithPrefill.includes(encodeURIComponent(pattern)),
    `LINE href must not expose PII field: ${pattern}`,
  );
}
const successTokenLike = "11111111-2222-3333-4444-555555555555";
assert.ok(
  !lineHrefWithPrefill.includes(successTokenLike),
  "LINE href must never include a success/payment token",
);

// --- shouldPollStatus / STATUS_POLL_INTERVAL_MS -----------------------------

assert.equal(shouldPollStatus("pending_payment"), true);
for (const terminal of ["confirmed", "expired", "cancelled", "booked", "completed"]) {
  assert.equal(shouldPollStatus(terminal), false, `${terminal} must stop polling`);
}
assert.ok(STATUS_POLL_INTERVAL_MS >= 15_000, "must never poll more frequently than 15s");
assert.equal(STATUS_POLL_INTERVAL_MS, 15_000);

// ===========================================================================
// BookingStatusPanel.tsx: polls every 15s only while pending_payment, and
// stops (via the effect's early return + cleanup) on any other status or
// unmount.
// ===========================================================================
const panelSrc = readFileSync(join(here, "BookingStatusPanel.tsx"), "utf8");
assert.match(panelSrc, /setInterval\(poll, STATUS_POLL_INTERVAL_MS\)/, "must poll on the shared 15s interval constant");
assert.match(
  panelSrc,
  /if \(!shouldPollStatus\(status\)\) return;/,
  "effect must bail out (no interval) once status is not pending_payment",
);
assert.match(
  panelSrc,
  /return \(\) => \{\s*\n\s*cancelled = true;\s*\n\s*clearInterval\(id\);\s*\n\s*\};/,
  "effect cleanup must clear the interval and mark in-flight polls cancelled (covers unmount)",
);
assert.match(panelSrc, /\[status, props\.token\]/, "effect must re-run (and re-gate) whenever status changes");
// The poll call itself must only ever pass the token, never a raw booking id.
assert.match(
  panelSrc,
  /\/api\/bookings\/status\?token=\$\{encodeURIComponent\(props\.token\)\}/,
  "poll request must use the opaque token query param, URL-encoded",
);
assert.doesNotMatch(panelSrc, /[?&]id=|bookingId/i, "poll request must never send a raw booking id");

// ===========================================================================
// /api/bookings/status route.ts: token-only lookup, never a raw booking id.
// ===========================================================================
const statusRouteSrc = readFileSync(
  join(here, "..", "..", "api", "bookings", "status", "route.ts"),
  "utf8",
);
assert.match(statusRouteSrc, /searchParams\.get\("token"\)/, "must read the token query param");
assert.match(statusRouteSrc, /getBookingByToken\(token\)/, "must resolve the booking via getBookingByToken(token)");
assert.match(statusRouteSrc, /if \(!token\)/, "must require the token — no fallback lookup path");
assert.doesNotMatch(
  statusRouteSrc,
  /searchParams\.get\("id"\)|searchParams\.get\("bookingId"\)|\.eq\(\s*["']id["']/,
  "must not accept or use a raw booking id as an alternate lookup path",
);
// Response must be minimal — no PII fields, no raw row dump.
assert.match(
  statusRouteSrc,
  /NextResponse\.json\(\{ status: booking\.status, reference: booking\.reference \}\)/,
  "response must be limited to status + reference only",
);

// ===========================================================================
// LineCta.tsx: exact CTA text + desktop fallback copy.
// ===========================================================================
const lineCtaSrc = readFileSync(join(here, "LineCta.tsx"), "utf8");
assert.match(lineCtaSrc, /ส่งสลิปทาง LINE @mohjaew/, "CTA text must be exactly \"ส่งสลิปทาง LINE @mohjaew\"");
assert.match(
  lineCtaSrc,
  /แนะนำให้เปิดผ่านมือถือเพื่อส่งสลิปใน LINE ได้สะดวก/,
  "must show the desktop fallback copy",
);

// ===========================================================================
// BookingStatusPanel.tsx: makes clear the queue is confirmed only after the
// team verifies payment.
// ===========================================================================
assert.match(
  panelSrc,
  /คิวของคุณจะยืนยันก็ต่อเมื่อทีมงานตรวจสอบการชำระเงินแล้วเท่านั้น/,
  "pending_payment view must clarify manual team verification is required to confirm",
);

console.log("success-page helpers: all checks passed ✓");
