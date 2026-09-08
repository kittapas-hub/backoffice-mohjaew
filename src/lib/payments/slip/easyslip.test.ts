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
  assert.equal(normalized.slip.duplicateSignal, false);
}

const providerDuplicate = structuredClone(SUCCESS);
providerDuplicate.data.isDuplicate = true;
const providerDuplicateResult = normalizeEasySlipBody(providerDuplicate);
assert.ok(providerDuplicateResult.ok && providerDuplicateResult.slip.duplicateSignal === true);

// Money-critical / required facts still fail closed when absent.
for (const mutate of [
  (x: typeof SUCCESS) => { delete (x.data.rawSlip as { date?: string }).date; },
  (x: typeof SUCCESS) => { delete (x.data.rawSlip as { transRef?: string }).transRef; },
  (x: typeof SUCCESS) => { delete (x.data as { isDuplicate?: boolean }).isDuplicate; },
]) {
  const partial = structuredClone(SUCCESS);
  mutate(partial);
  assert.deepEqual(normalizeEasySlipBody(partial), {
    ok: false,
    reason: "malformed_response",
    retryable: false,
  });
}

// Optional duplicate/identity fields: absence must NOT be malformed. The v2
// docs 200 example omits matchedAccount, amountInSlip, and amount.local.
for (const drop of [
  (x: typeof SUCCESS) => { delete (x.data as { amountInSlip?: number }).amountInSlip; },
  (x: typeof SUCCESS) => { delete (x.data as { matchedAccount?: unknown }).matchedAccount; },
  (x: typeof SUCCESS) => { delete (x.data.rawSlip.amount.local as { currency?: string }).currency; },
]) {
  const partial = structuredClone(SUCCESS);
  drop(partial);
  assert.ok(
    normalizeEasySlipBody(partial).ok,
    "absent optional field must not be malformed",
  );
}

const unmatched = structuredClone(SUCCESS);
unmatched.data.matchedAccount = null as unknown as typeof SUCCESS.data.matchedAccount;
const unmatchedResult = normalizeEasySlipBody(unmatched);
assert.ok(unmatchedResult.ok && unmatchedResult.slip.receiver.providerMatchedAccount === false);

// EXACT current EasySlip docs 200 example shape (redacted values only): no
// matchedAccount, amountInSlip, amount.local, countryCode, fee, or refs. Must
// normalize successfully with providerMatchedAccount=false (fail-closed match).
const DOCS_EXAMPLE = {
  success: true,
  data: {
    isDuplicate: false,
    rawSlip: {
      payload: "00000000000000000000000000000000000000",
      transRef: "TX-DOCS-1",
      date: "2026-09-08T05:06:00Z",
      amount: { amount: 1 },
      sender: {
        bank: { id: "014", name: "ไทยพาณิชย์", short: "SCB" },
        account: { name: { th: "ผู้โอน" } },
      },
      receiver: {
        bank: { id: "004", name: "กสิกรไทย", short: "KBANK" },
        account: { name: { th: "ร้านหมอแจ๋ว" } },
      },
    },
  },
  message: "Bank slip verified successfully",
};
const docs = normalizeEasySlipBody(DOCS_EXAMPLE);
assert.ok(docs.ok, "documented EasySlip v2 200 example must parse");
if (docs.ok) {
  assert.equal(docs.slip.amountSatang, 100);
  assert.equal(docs.slip.currency, "THB"); // defaulted: local currency absent
  assert.equal(docs.slip.providerTransactionReference, "TX-DOCS-1");
  assert.equal(docs.slip.transferTimestamp?.toISOString(), "2026-09-08T05:06:00.000Z");
  assert.equal(docs.slip.receiver.providerMatchedAccount, false); // no matchedAccount
  assert.equal(docs.slip.receiver.bankShort, "KBANK");
  assert.equal(docs.slip.senderDisplay, "ผู้โอน / SCB");
}

// Real-world minimal EasySlip v2 success (the UAT regression): a bank-app
// PromptPay transfer that omits every optional field — payload, countryCode,
// fee, ref1/ref2/ref3, and the sender/receiver display block — but carries the
// money- and match-critical facts. This shape previously became
// malformed_response and must now parse.
const MINIMAL = {
  success: true,
  message: "Bank slip verified successfully",
  data: {
    isDuplicate: false,
    matchedAccount: {
      bank: { code: "004" },
      nameTh: "ร้านหมอแจ๋ว",
      bankNumber: "123-4-56789-0",
    },
    amountInSlip: 1,
    rawSlip: {
      transRef: "TX-MIN-1",
      date: "2026-09-07T10:00:00Z",
      amount: { amount: 1, local: { amount: 1, currency: "THB" } },
      receiver: { account: { bank: { account: "xxx-x-x1234-x" } } },
    },
  },
};
const minimal = normalizeEasySlipBody(MINIMAL);
assert.ok(minimal.ok, "minimal EasySlip v2 success must parse (UAT regression)");
if (minimal.ok) {
  assert.equal(minimal.slip.amountSatang, 100);
  assert.equal(minimal.slip.currency, "THB");
  assert.equal(minimal.slip.providerTransactionReference, "TX-MIN-1");
  assert.equal(minimal.slip.transferTimestamp?.toISOString(), "2026-09-07T10:00:00.000Z");
  assert.equal(minimal.slip.receiver.providerMatchedAccount, true);
  assert.equal(minimal.slip.receiver.accountMasked, "xxx-x-x1234-x");
  assert.equal(minimal.slip.senderDisplay, null); // absent sender is not malformed
  assert.equal(minimal.slip.duplicateSignal, false);
}

// Fail-closed guards preserved on the minimal shape: an explicitly foreign
// slip, a zero/absent amount, and a mismatched local amount all stay malformed.
const foreign = structuredClone(MINIMAL);
(foreign.data.rawSlip as { countryCode?: string }).countryCode = "US";
assert.deepEqual(normalizeEasySlipBody(foreign), {
  ok: false, reason: "malformed_response", retryable: false,
});
const zeroAmount = structuredClone(MINIMAL);
zeroAmount.data.amountInSlip = 0;
zeroAmount.data.rawSlip.amount = { amount: 0, local: { amount: 0, currency: "THB" } };
assert.deepEqual(normalizeEasySlipBody(zeroAmount), {
  ok: false, reason: "malformed_response", retryable: false,
});
// Real EasySlip UAT shape: local amount may be a zero placeholder when its
// currency is null. Canonical amount and amountInSlip still agree at 1 THB.
const localPlaceholder = structuredClone(MINIMAL);
localPlaceholder.data.matchedAccount = null as unknown as typeof localPlaceholder.data.matchedAccount;
localPlaceholder.data.rawSlip.amount.local.amount = 0;
(localPlaceholder.data.rawSlip.amount.local as { amount: number; currency: string | null }).currency = null;
const localPlaceholderResult = normalizeEasySlipBody(localPlaceholder);
assert.ok(localPlaceholderResult.ok, "null-currency local placeholder must not reject a valid slip");
if (localPlaceholderResult.ok) {
  assert.equal(localPlaceholderResult.slip.amountSatang, 100);
  assert.equal(localPlaceholderResult.slip.currency, "THB");
  assert.equal(localPlaceholderResult.slip.receiver.providerMatchedAccount, false);
}

const localMismatch = structuredClone(MINIMAL);
localMismatch.data.rawSlip.amount.local.amount = 2;
assert.deepEqual(normalizeEasySlipBody(localMismatch), {
  ok: false, reason: "malformed_response", retryable: false,
});
// A present-but-incomplete matchedAccount (no bankNumber) still fails closed.
const badMatch = structuredClone(MINIMAL);
delete (badMatch.data.matchedAccount as { bankNumber?: string }).bankNumber;
assert.deepEqual(normalizeEasySlipBody(badMatch), {
  ok: false, reason: "malformed_response", retryable: false,
});

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
