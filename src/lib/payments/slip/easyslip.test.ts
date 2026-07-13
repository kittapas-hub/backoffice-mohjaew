import assert from "node:assert";
import { easySlipProvider, mapEasySlipError, normalizeEasySlipBody } from "./easyslip.ts";

// Exact official EasySlip v2 response structure (redacted values only).
const SUCCESS = {
  success: true,
  data: {
    isDuplicate: false,
    matchedAccount: {
      bank: { nameTh: "กสิกรไทย", nameEn: "KASIKORNBANK", code: "004", shortCode: "KBANK" },
      nameTh: "ร้านหมอแจ๋ว",
      nameEn: "MOHJAEW",
      type: "PERSONAL",
      bankNumber: "123-4-56789-0",
    },
    amountInSlip: 999,
    rawSlip: {
      payload: "00000000000000000000000000000000000000",
      transRef: "TX-V2-1",
      date: "2026-07-13T04:50:00Z",
      countryCode: "TH",
      amount: { amount: 999, local: { amount: 999, currency: "THB" } },
      fee: 0,
      ref1: "",
      ref2: "",
      ref3: "",
      sender: {
        bank: { id: "014", name: "ไทยพาณิชย์", short: "SCB" },
        account: { name: { th: "ผู้โอน" }, bank: { type: "BANKAC", account: "xxx-x-x0000-x" } },
      },
      receiver: {
        bank: { id: "004", name: "กสิกรไทย", short: "KBANK" },
        account: {
          name: { th: "ร้านหมอแจ๋ว", en: "MOHJAEW" },
          bank: { type: "BANKAC", account: "xxx-x-x1234-x" },
        },
        merchantId: null,
      },
    },
  },
  message: "Bank slip verified successfully",
};

const normalized = normalizeEasySlipBody(SUCCESS);
assert.ok(normalized.ok);
if (normalized.ok) {
  assert.equal(normalized.slip.provider, "promptpay_slip");
  assert.equal(normalized.slip.receiver.providerMatchedAccount, true);
  assert.equal(normalized.slip.amountSatang, 99900);
  assert.equal(normalized.slip.currency, "THB");
  assert.equal(normalized.slip.transferTimestamp?.toISOString(), "2026-07-13T04:50:00.000Z");
}

for (const mutate of [
  (x: typeof SUCCESS) => { delete (x.data.rawSlip as { date?: string }).date; },
  (x: typeof SUCCESS) => { delete (x.data.rawSlip as { transRef?: string }).transRef; },
  (x: typeof SUCCESS) => { delete (x.data.rawSlip.amount.local as { currency?: string }).currency; },
  (x: typeof SUCCESS) => { delete (x.data as { amountInSlip?: number }).amountInSlip; },
  (x: typeof SUCCESS) => { delete (x.data as { matchedAccount?: unknown }).matchedAccount; },
]) {
  const partial = structuredClone(SUCCESS);
  mutate(partial);
  assert.deepEqual(normalizeEasySlipBody(partial), {
    ok: false,
    reason: "malformed_response",
    retryable: false,
  });
}

const unmatched = structuredClone(SUCCESS);
unmatched.data.matchedAccount = null as unknown as typeof SUCCESS.data.matchedAccount;
const unmatchedResult = normalizeEasySlipBody(unmatched);
assert.ok(unmatchedResult.ok && unmatchedResult.slip.receiver.providerMatchedAccount === false);

assert.deepEqual(normalizeEasySlipBody({ success: true, data: {}, message: "ok" }), {
  ok: false, reason: "malformed_response", retryable: false,
});
assert.deepEqual(mapEasySlipError(429, null), {
  ok: false, reason: "provider_rate_limited", retryable: true,
});

let call: { url: string; init: RequestInit } | null = null;
const provider = easySlipProvider({
  apiKey: "test",
  fetchImpl: async (url, init) => {
    call = { url: String(url), init: init! };
    return new Response(JSON.stringify(SUCCESS), { status: 200 });
  },
});
const verified = await provider.verify({ image: Buffer.from([1, 2, 3]), mimeType: "image/png" });
assert.ok(verified.ok);
assert.match(call!.url, /^https:\/\/api\.easyslip\.com\/v2\/verify\/bank$/);
const sentForm = call!.init.body as FormData;
assert.equal(sentForm.has("image"), true);
assert.equal(sentForm.get("matchAccount"), "true");
assert.equal(sentForm.get("checkDuplicate"), "true");
assert.equal((call!.init.headers as Record<string, string>).Authorization, "Bearer test");
console.log("easyslip self-check passed");
