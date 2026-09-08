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
assert.ok(
  buildLineHref("https://evil.example/R/ti/p/@attacker", "text")
    .startsWith(`https://line.me/R/oaMessage/@${MOHJAEW_LINE_OA_ID}?text=`),
  "an untrusted host must never replace the configured Mohjaew OA",
);

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
const successPageSrc = readFileSync(join(here, "page.tsx"), "utf8");
const uiSrc = readFileSync(join(here, "ui.tsx"), "utf8");
const countdownSrc = readFileSync(join(here, "HoldCountdown.tsx"), "utf8");
const lineCtaSrc = readFileSync(join(here, "LineCta.tsx"), "utf8");
const slipUploadSrc = readFileSync(join(here, "..", "..", "pay", "[token]", "SlipUpload.tsx"), "utf8");
const bookingCoreSrc = readFileSync(join(here, "../../../lib/booking-core.ts"), "utf8");
assert.match(panelSrc, /setInterval\(poll, STATUS_POLL_INTERVAL_MS\)/, "must poll on the shared 15s interval constant");
assert.match(panelSrc, /fetch\([\s\S]*?\{ cache: "no-store" \}/, "status polling must bypass browser caches");
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
// Response must be minimal — booking status plus the latest payment status
// needed to suppress duplicate-payment instructions; no PII or raw row dump.
assert.match(
  statusRouteSrc,
  /status: booking\.status,[\s\S]*reference: booking\.reference,[\s\S]*paymentStatus: booking\.paymentStatus/,
  "response must be limited to booking/payment status plus the reference",
);
assert.match(statusRouteSrc, /Cache-Control.*no-store/, "status responses must not be cached by browsers or proxies");
for (const pii of ["nickname", "phone", "birth_date_text", "consultation_topic"]) {
  assert.doesNotMatch(statusRouteSrc, new RegExp(pii), `status route must not expose ${pii}`);
}

assert.match(
  panelSrc,
  /paymentStatus === "manual_review"/,
  "success page must render payment manual_review independently of booking status",
);
const reviewBlock = panelSrc.slice(
  panelSrc.indexOf('paymentStatus === "manual_review"'),
  panelSrc.indexOf("// ── Non-pending_payment status"),
);
assert.match(reviewBlock, /ไม่ต้องโอนเงินหรืออัปโหลดสลิปซ้ำ/);
assert.doesNotMatch(reviewBlock, /SlipUpload|qrSrc|accountNumber/);

assert.match(
  bookingCoreSrc,
  /paymentError \? "unknown"/,
  "payment-order read failures must fail closed instead of looking unpaid",
);
const unknownBlock = panelSrc.slice(
  panelSrc.indexOf('paymentStatus === "unknown"'),
  panelSrc.indexOf("// ── Non-pending_payment status"),
);
assert.match(unknownBlock, /อย่าโอนเงินหรืออัปโหลดสลิปซ้ำ/);
assert.doesNotMatch(unknownBlock, /SlipUpload|qrSrc|accountNumber/);

const paidBlock = panelSrc.slice(
  panelSrc.indexOf('paymentStatus === "paid"'),
  panelSrc.indexOf("// ── Non-pending_payment status"),
);
assert.match(paidBlock, /ชำระเงินแล้ว/);
assert.doesNotMatch(
  paidBlock,
  /SlipUpload|qrSrc|accountNumber|hasPaymentConfig/,
  "a paid payment order must never render transfer or slip-upload actions",
);
const closedPaymentBlock = panelSrc.slice(
  panelSrc.indexOf('paymentStatus === "expired"'),
  panelSrc.indexOf("// ── Non-pending_payment status"),
);
assert.match(closedPaymentBlock, /กรุณาอย่าโอนเงินหรืออัปโหลดสลิปซ้ำ/);
assert.doesNotMatch(
  closedPaymentBlock,
  /SlipUpload|qrSrc|accountNumber|hasPaymentConfig/,
  "a closed payment order must never render transfer or slip-upload actions",
);
const nonPendingBlock = panelSrc.slice(
  panelSrc.indexOf("if (!shouldPollStatus(status))"),
  panelSrc.indexOf("// ── pending_payment"),
);
assert.doesNotMatch(
  nonPendingBlock,
  /SlipUpload|qrSrc|accountNumber|hasPaymentConfig/,
  "confirmed, expired, cancelled, completed, and unknown booking states must never expose payment actions",
);
assert.match(
  successPageSrc,
  /initialHoldExpired=\{!holdLive\}/,
  "server render must gate expired or missing holds before client hydration",
);
assert.match(
  panelSrc,
  /setHoldExpired\(!Number\.isFinite\(expiry\) \|\| expiry <= Date\.now\(\)\)/,
  "client hold gate must fail closed for invalid expiry timestamps",
);
assert.match(
  countdownSrc,
  /Number\.isFinite\(expiry\) \? expiry - Date\.now\(\) : 0/,
  "countdown must not render NaN for an invalid expiry timestamp",
);
assert.match(
  lineCtaSrc,
  /setExpired\(!Number\.isFinite\(expiry\) \|\| expiry <= Date\.now\(\)\)/,
  "LINE slip CTA must fail closed when its expiry is missing or invalid",
);
assert.match(
  uiSrc,
  /if \(!Number\.isFinite\(date\.getTime\(\)\)\) return "";/,
  "deadline copy must not render Invalid Date",
);

// ===========================================================================
// LineCta.tsx: exact CTA text + desktop fallback copy.
// ===========================================================================
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
  /ลำดับคิวนี้คือลำดับการจองในรอบเซสชัน/,
  "pending_payment view must clarify queue is session order not exact appointment time",
);
assert.match(
  panelSrc,
  /props\.slipOrderUrl[\s\S]*?ระบบตรวจสอบและยืนยันคิวเมื่อข้อมูลถูกต้อง[\s\S]*?คิวของคุณจะยืนยันก็ต่อเมื่อทีมงานตรวจสอบการชำระเงินแล้วเท่านั้น/,
  "pending_payment view must distinguish automatic slip verification from the LINE/manual path",
);
assert.match(
  panelSrc,
  /import \{ SlipUpload \} from "@\/app\/pay\/\[token\]\/SlipUpload"/,
  "booking success must reuse the direct-checkout slip uploader",
);
assert.match(
  panelSrc,
  /fetch\(props\.slipOrderUrl![\s\S]*?method: "POST"[\s\S]*?setCheckoutToken\(token\)[\s\S]*?setOrderInitState\("ready"\)/,
  "booking success must create the payment order client-side before marking payment instructions ready",
);
assert.match(
  panelSrc,
  /props\.slipOrderUrl && \(!checkoutToken \|\| orderInitState !== "ready"\)/,
  "QR/account instructions must be gated until payment-order initialization succeeds",
);
assert.match(
  panelSrc,
  /ยังไม่แสดง QR หรือข้อมูลโอนเงินจนกว่าจะสร้างรายการชำระเงินสำเร็จ/,
  "order initialization failure must fail closed instead of revealing transfer instructions",
);
assert.match(
  panelSrc,
  /<SlipUpload token=\{checkoutToken\} \/>[\s\S]*?props\.lineHref/,
  "automatic inline upload must receive the pre-created checkout token before the secondary LINE action",
);
assert.doesNotMatch(
  slipUploadSrc,
  /orderUrl|resolveCheckoutToken|fetch\(/,
  "SlipUpload must never lazily create a payment order after the customer has already transferred",
);
assert.match(
  slipUploadSrc,
  /upload\(file, props\.token\)/,
  "SlipUpload must submit with the already-resolved checkout token",
);
assert.doesNotMatch(panelSrc, /SlipVerificationLink/, "booking success must not use the redirect-only uploader");

console.log("success-page helpers: all checks passed ✓");
