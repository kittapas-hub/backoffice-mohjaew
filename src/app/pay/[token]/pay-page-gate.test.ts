import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { slipVerificationConfig } from "../../../lib/env.ts";
import { isSlipUploadReady } from "./pay-page-gate.ts";

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
assert.match(pageSrc, /ไม่ต้องอัปโหลดสลิปซ้ำ/, "under-review state must tell the customer not to re-upload");

console.log("pay-page gate self-check passed");
