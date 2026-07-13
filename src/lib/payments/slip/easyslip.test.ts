// Self-check for the EasySlip adapter — mocked fetch only, never the live API.
// Run: node --experimental-strip-types src/lib/payments/slip/easyslip.test.ts
import assert from "node:assert";
import {
  easySlipProvider,
  mapEasySlipError,
  normalizeEasySlipBody,
  parseTransferDate,
  thbToSatang,
} from "./easyslip.ts";

// --- unit conversion -----------------------------------------------------------
assert.equal(thbToSatang(1000), 100000);
assert.equal(thbToSatang(1000.5), 100050);
assert.equal(thbToSatang(0), 0);
assert.equal(thbToSatang(-1), null);
assert.equal(thbToSatang("500"), null);
assert.equal(thbToSatang(NaN), null);
assert.equal(parseTransferDate("2026-07-13T11:50:00+07:00")?.toISOString(), "2026-07-13T04:50:00.000Z");
assert.equal(parseTransferDate("not a date"), null);
assert.equal(parseTransferDate(undefined), null);

// --- normalization of a representative success body ------------------------------
const SUCCESS_BODY = {
  status: 200,
  data: {
    payload: "0041000600000101030040220...",
    transRef: "68370160657749I376388B35",
    date: "2026-07-13T11:50:00+07:00",
    countryCode: "TH",
    amount: { amount: 500.0, local: { amount: 0, currency: "764" } },
    fee: 0,
    ref1: "",
    sender: {
      bank: { id: "014", name: "ไทยพาณิชย์", short: "SCB" },
      account: {
        name: { th: "นาย ลูกค้า จริงใจ", en: "MR. CUSTOMER" },
        bank: { type: "BANKAC", account: "1234xxxx5678" },
      },
    },
    receiver: {
      bank: { id: "004", name: "กสิกรไทย", short: "KBANK" },
      account: {
        name: { th: "นาง มลฤดี ใจดี" },
        bank: { type: "BANKAC", account: "xxx-x-x1234-x" },
        proxy: { type: "MSISDN", account: "xxx-xxx-5678" },
      },
    },
  },
};

{
  const r = normalizeEasySlipBody(SUCCESS_BODY);
  assert.ok(r.ok);
  assert.equal(r.slip.provider, "easyslip");
  assert.equal(r.slip.providerTransactionReference, "68370160657749I376388B35");
  assert.equal(r.slip.amountSatang, 50000);
  assert.equal(r.slip.transferTimestamp?.toISOString(), "2026-07-13T04:50:00.000Z");
  assert.equal(r.slip.receiver.bankShort, "KBANK");
  assert.equal(r.slip.receiver.accountMasked, "xxx-x-x1234-x");
  assert.equal(r.slip.receiver.proxyMasked, "xxx-xxx-5678");
  assert.equal(r.slip.receiver.nameTh, "นาง มลฤดี ใจดี");
  assert.equal(r.slip.senderDisplay, "นาย ลูกค้า จริงใจ / SCB");
  // No provider-specific keys may leak through the normalized shape.
  assert.ok(!("transRef" in r.slip));
  assert.ok(!("payload" in r.slip));
}

// Malformed provider responses (requirement H-13).
assert.deepEqual(normalizeEasySlipBody(null), {
  ok: false,
  reason: "malformed_response",
  retryable: false,
});
assert.deepEqual(normalizeEasySlipBody({ status: 200 }), {
  ok: false,
  reason: "malformed_response",
  retryable: false,
});
assert.deepEqual(normalizeEasySlipBody({ data: { amount: "oops" } }), {
  ok: false,
  reason: "malformed_response",
  retryable: false,
});
// Missing tx ref but readable amount still normalizes (policy rejects later).
{
  const r = normalizeEasySlipBody({ data: { amount: { amount: 500 } } });
  assert.ok(r.ok);
  assert.equal(r.slip.providerTransactionReference, null);
  assert.equal(r.slip.amountSatang, 50000);
}

// --- HTTP error mapping -----------------------------------------------------------
assert.deepEqual(mapEasySlipError(429, null), {
  ok: false, reason: "provider_rate_limited", retryable: true, // H-12b
});
assert.deepEqual(mapEasySlipError(401, "unauthorized"), {
  ok: false, reason: "provider_auth_error", retryable: false,
});
assert.deepEqual(mapEasySlipError(403, "quota_exceeded"), {
  ok: false, reason: "provider_auth_error", retryable: false,
});
assert.deepEqual(mapEasySlipError(404, "slip_not_found"), {
  ok: false, reason: "slip_not_found", retryable: false,
});
assert.deepEqual(mapEasySlipError(400, "invalid_image"), {
  ok: false, reason: "unreadable_image", retryable: false,
});
assert.deepEqual(mapEasySlipError(500, null), {
  ok: false, reason: "provider_error", retryable: true,
});

// --- full adapter round trips with a mocked fetch ---------------------------------
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

const IMAGE = { image: Buffer.from("fake image bytes"), mimeType: "image/png" };

// Success round trip: auth header sent, body normalized.
{
  const { impl, calls } = fakeFetch(
    () => new Response(JSON.stringify(SUCCESS_BODY), { status: 200 }),
  );
  const provider = easySlipProvider({ apiKey: "test-key", fetchImpl: impl });
  assert.equal(provider.name, "easyslip");
  const r = await provider.verify(IMAGE);
  assert.ok(r.ok);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/developer\.easyslip\.com\/api\/v1\/verify$/);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer test-key");
  // Key travels only in the header — never in the URL.
  assert.doesNotMatch(calls[0].url, /test-key/);
}

// Provider timeout (H-12).
{
  const { impl } = fakeFetch(() => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  });
  const provider = easySlipProvider({ apiKey: "k", fetchImpl: impl });
  const r = await provider.verify(IMAGE);
  assert.deepEqual(r, { ok: false, reason: "provider_timeout", retryable: true });
}

// Network failure is retryable, never a thrown exception.
{
  const { impl } = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });
  const provider = easySlipProvider({ apiKey: "k", fetchImpl: impl });
  const r = await provider.verify(IMAGE);
  assert.deepEqual(r, { ok: false, reason: "provider_error", retryable: true });
}

// Provider rate limit surfaces as retryable.
{
  const { impl } = fakeFetch(
    () => new Response(JSON.stringify({ status: 429, message: "rate" }), { status: 429 }),
  );
  const provider = easySlipProvider({ apiKey: "k", fetchImpl: impl });
  const r = await provider.verify(IMAGE);
  assert.deepEqual(r, { ok: false, reason: "provider_rate_limited", retryable: true });
}

// Non-JSON 200 body -> malformed_response (H-13).
{
  const { impl } = fakeFetch(() => new Response("<html>proxy error</html>", { status: 200 }));
  const provider = easySlipProvider({ apiKey: "k", fetchImpl: impl });
  const r = await provider.verify(IMAGE);
  assert.deepEqual(r, { ok: false, reason: "malformed_response", retryable: false });
}

// --- static guards -----------------------------------------------------------------
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const adapterSrc = readFileSync(join(here, "easyslip.ts"), "utf8");
// The adapter never reads env directly (key is injected by server-only env.ts)
// and never logs anything (the caller logs redacted summaries).
assert.doesNotMatch(adapterSrc, /process\.env/, "adapter must not read env directly");
assert.doesNotMatch(adapterSrc, /console\./, "adapter must not log (payloads could leak)");

console.log("easyslip self-check passed");
