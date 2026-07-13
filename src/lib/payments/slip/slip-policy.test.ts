import assert from "node:assert";
import { evaluateSlipPolicy, receiverMatches } from "./policy.ts";
import type { NormalizedSlipVerification } from "./types.ts";

const receiver = {
  bankShort: "KBANK", accountMasked: "xxx-x-x1234-x", proxyMasked: null,
  nameTh: "ร้าน มอเจ๋ว", nameEn: null, providerMatchedAccount: true,
};
const slip: NormalizedSlipVerification = {
  provider: "promptpay_slip", providerTransactionReference: "TX-1",
  transferTimestamp: new Date("2026-07-13T04:50:00Z"), amountSatang: 99900, currency: "THB",
  receiver, senderDisplay: null, duplicateSignal: false,
};
const profile = { accounts: ["xxx-x-x1234-x"], names: ["ร้าน มอเจ๋ว"] };

assert.equal(receiverMatches(receiver, profile), true, "requires provider match plus account/name evidence");
assert.equal(receiverMatches({ ...receiver, providerMatchedAccount: false }, profile), false);
assert.equal(receiverMatches({ ...receiver, nameTh: null }, profile), false);
assert.equal(receiverMatches(receiver, { ...profile, names: [] }), false);
assert.deepEqual(evaluateSlipPolicy(slip), { ok: true });
assert.deepEqual(evaluateSlipPolicy({ ...slip, providerTransactionReference: " " }), { ok: false, code: "tx_ref_missing" });
console.log("slip-policy self-check passed");
