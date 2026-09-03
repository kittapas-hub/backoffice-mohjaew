import assert from "node:assert";
import "./line-marketing.test.ts";
import "./line-ai.test.ts";
import {
  buildSeptemberWaitingQuickReply,
  parseLinePostbackData,
  postbackData,
  WAITING_SEGMENTS,
} from "./line-campaign.ts";
import { handleLineWebhookRequest } from "./line-webhook.ts";

const quickReply = buildSeptemberWaitingQuickReply();
const items = quickReply.quickReply?.items ?? [];
assert.equal(items.length, 3);
assert.deepEqual(items.map((item) => item.action), [
  { type: "postback", label: "1️⃣ รอคำตอบ", data: postbackData("WAIT_ANSWER"), displayText: "1️⃣ รอคำตอบ" },
  { type: "postback", label: "2️⃣ รอหลายเรื่อง", data: postbackData("WAIT_MULTIPLE"), displayText: "2️⃣ รอหลายเรื่อง" },
  { type: "postback", label: "3️⃣ สำเร็จแล้วเงียบ", data: postbackData("WAIT_STALLED"), displayText: "3️⃣ เรื่องเกือบสำเร็จแล้วเงียบ" },
]);
assert.ok(items.every(({ action }) => [...action.label].length <= 20));

for (const segment of WAITING_SEGMENTS) {
  assert.deepEqual(parseLinePostbackData(postbackData(segment)), { campaign: "september_waiting", segment });
}
for (const malformed of [null, "", "campaign=other&segment=WAIT_ANSWER", "campaign=september_waiting&segment=UNKNOWN", "campaign=september_waiting", "campaign=september_waiting&segment=WAIT_ANSWER&extra=1", "campaign=september_waiting&campaign=september_waiting&segment=WAIT_ANSWER"]) {
  assert.equal(parseLinePostbackData(malformed), null);
}

function request(body: unknown, signature = "valid") {
  return new Request("https://example.test/api/line/webhook", { method: "POST", headers: { "x-line-signature": signature }, body: JSON.stringify(body) });
}

let persisted = 0;
let replied = 0;
const dependencies = {
  verifySignature: (_body: string, signature: string | null) => signature === "valid",
  persistSelection: async () => { persisted += 1; },
  reply: async () => { replied += 1; },
};

assert.equal((await handleLineWebhookRequest(request({ events: [] }, "invalid"), dependencies)).status, 401);
const unrelated = await handleLineWebhookRequest(request({ events: [
  { type: "message", source: { type: "user", userId: `U${"a".repeat(32)}` } },
  { type: "postback", source: { type: "group", userId: `U${"b".repeat(32)}` }, postback: { data: postbackData("WAIT_ANSWER") }, replyToken: "reply-1" },
] }), dependencies);
assert.equal(unrelated.status, 200);
assert.equal(persisted, 0);
assert.equal(replied, 0);

let persistedValue: unknown;
let replyValue: unknown;
const valid = await handleLineWebhookRequest(request({ events: [{
  type: "postback",
  timestamp: 1_700_000_000_000,
  source: { type: "user", userId: `U${"c".repeat(32)}` },
  postback: { data: postbackData("WAIT_STALLED") },
  replyToken: "reply-2",
}] }), {
  verifySignature: () => true,
  persistSelection: async (value) => { persistedValue = value; },
  reply: async (replyToken, segment) => { replyValue = { replyToken, segment }; },
});
assert.equal(valid.status, 200);
assert.deepEqual(persistedValue, { lineUserId: `U${"c".repeat(32)}`, campaign: "september_waiting", segment: "WAIT_STALLED", createdAt: "2023-11-14T22:13:20.000Z" });
assert.deepEqual(replyValue, { replyToken: "reply-2", segment: "WAIT_STALLED" });

const replyFailure = await handleLineWebhookRequest(request({ events: [{
  type: "postback", source: { type: "user", userId: `U${"d".repeat(32)}` }, postback: { data: postbackData("WAIT_ANSWER") }, replyToken: "reply-3",
}] }), {
  verifySignature: () => true,
  persistSelection: async () => {},
  reply: async () => { throw new Error("simulated failure"); },
});
assert.equal(replyFailure.status, 200);

console.log("LINE campaign self-check passed");
