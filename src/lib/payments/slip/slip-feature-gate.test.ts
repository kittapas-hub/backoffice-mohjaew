import assert from "node:assert";
import { slipVerificationConfig, slipVerificationEnabled } from "../../env.ts";

const names = [
  "SLIP_VERIFICATION_ENABLED",
  "SLIP_VERIFICATION_PROVIDER",
  "EASYSLIP_API_KEY",
] as const;
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));

try {
  for (const name of names) delete process.env[name];
  assert.equal(slipVerificationEnabled(), false, "missing gates must be off");

  process.env.EASYSLIP_API_KEY = "credentials-alone-must-not-enable";
  assert.equal(slipVerificationEnabled(), false, "credentials alone must be off");

  process.env.SLIP_VERIFICATION_ENABLED = "true";
  process.env.SLIP_VERIFICATION_PROVIDER = "easyslip";
  assert.equal(slipVerificationConfig().enabled, false, "unapproved provider must be off");

  process.env.SLIP_VERIFICATION_PROVIDER = "easyslip_v2";
  assert.equal(slipVerificationEnabled(), true, "both explicit gates enable automation");

  process.env.SLIP_VERIFICATION_ENABLED = "TRUE";
  assert.equal(slipVerificationEnabled(), false, "invalid enabled value must be off");
} finally {
  for (const name of names) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log("slip feature-gate self-check passed");
