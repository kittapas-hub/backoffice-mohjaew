import assert from "node:assert";
import { isLiveBroadcastEnabled, sendLineUatPush, validateLineUserId } from "./line-campaign.ts";
import { getLineQuota, maskLineUserId, parseLineQuota } from "./line-marketing.ts";

const validId = `U${"a".repeat(32)}`;
assert.equal(validateLineUserId(validId), validId);
assert.equal(validateLineUserId(` ${validId} `), validId);
for (const invalid of [undefined, "", `C${"a".repeat(32)}`, `U${"z".repeat(32)}`, `U${"a".repeat(31)}`, `${validId}x`]) assert.equal(validateLineUserId(invalid), null);
assert.equal(maskLineUserId(validId), "Uaaaa…aaaa");
assert.equal(isLiveBroadcastEnabled("true"), true);
assert.equal(isLiveBroadcastEnabled("TRUE"), false);
assert.equal(isLiveBroadcastEnabled(undefined), false);

let requestedUrl = "";
let requestedBody: Record<string, unknown> = {};
const pushResult = await sendLineUatPush(validId, [{ type: "text", text: "test" }], {
  accessToken: "test-token", retryKey: "retry-key",
  fetch: async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body));
    assert.equal(new Headers(init?.headers).get("X-Line-Retry-Key"), "retry-key");
    return new Response(null, { status: 200 });
  },
});
assert.deepEqual(pushResult, { ok: true });
assert.equal(requestedUrl, "https://api.line.me/v2/bot/message/push");
assert.ok(!requestedUrl.includes("broadcast"));
assert.equal(requestedBody.to, validId);

assert.deepEqual(parseLineQuota({ type: "limited", value: 1000 }, { totalUsage: 42 }), { ok: true, type: "limited", limit: 1000, consumed: 42 });
assert.deepEqual(parseLineQuota({ type: "none" }, { totalUsage: 0 }), { ok: true, type: "none", limit: null, consumed: 0 });
assert.equal(parseLineQuota({ type: "limited", value: "100" }, { totalUsage: 2 }).ok, false);
const quotaUrls: string[] = [];
const quota = await getLineQuota({ accessToken: "test-token", fetch: async (input) => {
  quotaUrls.push(String(input));
  return Response.json(String(input).endsWith("/consumption") ? { totalUsage: 12 } : { type: "limited", value: 500 });
} });
assert.equal(quota.ok, true);
assert.deepEqual(quotaUrls.sort(), ["https://api.line.me/v2/bot/message/quota", "https://api.line.me/v2/bot/message/quota/consumption"].sort());

console.log("LINE marketing self-check passed");
