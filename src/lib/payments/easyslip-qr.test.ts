import assert from "node:assert";
import { generateEasySlipPromptPayQr } from "./easyslip-qr.ts";

let captured: { url: string; init: RequestInit } | null = null;
const result = await generateEasySlipPromptPayQr({
  apiKey: "secret",
  amountSatang: 99900,
  target: { kind: "eWalletId", value: "123456789012345" },
  fetchImpl: async (url, init) => {
    captured = { url: String(url), init: init! };
    return new Response(JSON.stringify({
      status: 200,
      data: { image: "aW1hZ2U=", mime: "image/png", payload: "000201010212..." },
    }), { status: 200 });
  },
});

assert.deepEqual(result, {
  dataUrl: "data:image/png;base64,aW1hZ2U=",
  payload: "000201010212...",
});
assert.equal(captured!.url, "https://api.easyslip.com/v1/qr/generate");
assert.equal((captured!.init.headers as Record<string, string>).Authorization, "Bearer secret");
const body = JSON.parse(String(captured!.init.body));assert.deepEqual(body, {
  type: "PROMPTPAY",
  amount: 999,
  eWalletId: "123456789012345",
});

assert.equal(await generateEasySlipPromptPayQr({
  apiKey: "",
  amountSatang: 99900,
  target: { kind: "msisdn", value: "0800000000" },
}), null);

assert.equal(await generateEasySlipPromptPayQr({
  apiKey: "secret",
  amountSatang: 99900,
  target: { kind: "natId", value: "1234567890123" },
  fetchImpl: async () => new Response(JSON.stringify({
    status: 200,
    data: { image: "x", mime: "image/jpeg", payload: "abc" },
  }), { status: 200 }),
}), null);

console.log("easyslip qr self-check passed");
