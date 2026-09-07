import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { slipVerificationConfig } from "../../../lib/env.ts";
import {
  isPaymentDeadlinePassed,
  isSlipUploadReady,
  resolvePaymentDeadline,
} from "./pay-page-gate.ts";

const ENV_KEYS = [
  "SLIP_VERIFICATION_ENABLED",
  "SLIP_VERIFICATION_PROVIDER",
  "EASYSLIP_API_KEY",
  "SLIP_RECEIVER_PROFILE",
  "SLIP_RECEIVER_ACCOUNTS",
  "SLIP_RECEIVER_NAMES",
] as const;
const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function setCompleteConfig() {
  process.env.SLIP_VERIFICATION_PROVIDER = "easyslip_v2";
  process.env.EASYSLIP_API_KEY = "test-key";
  process.env.SLIP_RECEIVER_PROFILE = "profile-test";
  process.env.SLIP_RECEIVER_ACCOUNTS = "1234";
  process.env.SLIP_RECEIVER_NAMES = "Test Receiver";
}

try {
  setCompleteConfig();
  process.env.SLIP_VERIFICATION_ENABLED = "false";
  assert.equal(isSlipUploadReady(slipVerificationConfig()), false,
    "disabled automation must hide SlipUpload even with valid credentials");

  process.env.SLIP_VERIFICATION_ENABLED = "true";
  process.env.SLIP_VERIFICATION_PROVIDER = "easyslip";
  assert.equal(isSlipUploadReady(slipVerificationConfig()), false,
    "an invalid provider must hide SlipUpload");

  process.env.SLIP_VERIFICATION_PROVIDER = "easyslip_v2";
  assert.equal(isSlipUploadReady(slipVerificationConfig()), true,
    "the approved provider and complete configuration must show SlipUpload");
} finally {
  for (const key of ENV_KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const NOW = Date.parse("2026-09-07T10:00:00.000Z");
assert.equal(
  resolvePaymentDeadline(
    "2026-09-07T10:30:00.000Z",
    "2026-09-07T10:20:00.000Z",
  ),
  "2026-09-07T10:20:00.000Z",
  "the earlier booking hold must cap the payment order",
);
assert.equal(resolvePaymentDeadline("invalid", "2026-09-07T10:20:00.000Z"), null);
assert.equal(resolvePaymentDeadline("2026-09-07T10:20:00.000Z", null), null);
assert.equal(isPaymentDeadlinePassed("2026-09-07T09:59:59.000Z", NOW), true);
assert.equal(isPaymentDeadlinePassed("2026-09-07T10:00:00.000Z", NOW), true);
assert.equal(isPaymentDeadlinePassed("2026-09-07T10:00:01.000Z", NOW), false);
assert.equal(isPaymentDeadlinePassed(null, NOW), true);

// ===========================================================================
// page.tsx: a payment order under manual_review must render the dedicated
// "under review" state and NEVER fall through to the slip upload form (which
// would only 409). Static/AST checks — the page needs the Next.js runtime.
// ===========================================================================
const here = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(join(here, "page.tsx"), "utf8");

assert.match(
  pageSrc,
  /const isUnderReview\s*=\s*order\.status === "manual_review";/,
  "must derive isUnderReview from order.status === manual_review",
);
// The manual_review branch must return before PayableSection is reached, so the
// upload form is never shown for an order already under review.
const underReviewIdx = pageSrc.indexOf("if (isUnderReview)");
const payableIdx = pageSrc.indexOf("<PayableSection");
assert.ok(underReviewIdx > 0, "must have an isUnderReview branch");
assert.ok(payableIdx > 0, "must still have a payable section for open orders");
assert.ok(
  underReviewIdx < payableIdx,
  "the isUnderReview branch must short-circuit before the payable/upload section",
);
assert.match(pageSrc, /อยู่ระหว่างการตรวจสอบ/, "under-review state must tell the customer it is being reviewed");
assert.match(pageSrc, /ไม่ต้องโอนเงินหรืออัปโหลดสลิปซ้ำ/, "under-review state must tell the customer not to pay or re-upload");
assert.match(
  pageSrc,
  /isPaymentDeadlinePassed\(paymentDeadline\)/,
  "server render must fail closed when the trusted payment deadline has passed",
);
assert.match(
  pageSrc,
  /bookingRow\?\.status !== "pending_payment"/,
  "an unpaid order must close when an admin has already moved the booking out of pending_payment",
);
assert.match(
  pageSrc,
  /<PaymentDeadlineGate deadline=\{paymentDeadline!\}>/,
  "an already-open payment page must close itself at the trusted deadline",
);
assert.match(
  pageSrc,
  /order\.booking_id\.slice\(0, 8\)/,
  "customer support reference must use the booking reference, not an unsearchable order id",
);
assert.match(pageSrc, /const paidSubtitle/, "paid copy must depend on the booking state");
assert.match(
  pageSrc,
  /bookingClosedAfterPayment/,
  "paid-but-cancelled/expired bookings must not be presented as confirmed",
);
assert.doesNotMatch(
  pageSrc,
  /subtitle="คิวของคุณได้รับการยืนยันแล้ว"/,
  "paid copy must not unconditionally claim the queue is confirmed",
);

// Client recovery guards: same-file retries must fire change events again,
// network/provider hangs must leave the busy state, and terminal server
// outcomes must not invite another upload. Booking submission errors must also
// release the submit button while retaining the idempotency state for retry.
const slipUploadSrc = readFileSync(join(here, "SlipUpload.tsx"), "utf8");
assert.match(slipUploadSrc, /xhr\.timeout = 30_000/);
assert.match(slipUploadSrc, /e\.currentTarget\.value = ""/);
assert.match(slipUploadSrc, /body\.error === "manual_review"/);
assert.match(slipUploadSrc, /body\.error === "order_closed"/);
const bookingFormSrc = readFileSync(
  join(here, "..", "..", "booking", "BookingForm.tsx"),
  "utf8",
);
assert.match(bookingFormSrc, /const parsed: unknown = await res\.json\(\)/);
assert.match(bookingFormSrc, /ส่งข้อมูลการจองไม่สำเร็จ/);
assert.match(bookingFormSrc, /role="alert"/);

const deadlineGateSrc = readFileSync(join(here, "PaymentDeadlineGate.tsx"), "utf8");
assert.match(deadlineGateSrc, /setTimeout\(\(\) => setExpired\(true\)/);
assert.match(
  deadlineGateSrc,
  /setInterval\(\(\) => router\.refresh\(\), CHECKOUT_REFRESH_MS\)/,
  "an open checkout must poll trusted server state for review/closure in another tab",
);
assert.match(deadlineGateSrc, /กรุณาอย่าโอนเงินหรืออัปโหลดสลิป/);
assert.doesNotMatch(deadlineGateSrc, /qrSrc|accountNumber|SlipUpload/);

console.log("pay-page gate self-check passed");
