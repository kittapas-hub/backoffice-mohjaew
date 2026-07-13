import assert from "node:assert/strict";
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

console.log("pay-page gate self-check passed");
