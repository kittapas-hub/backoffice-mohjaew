import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  parseChatEvent, chatbotConfig, authorizedChatCallback, chatUserAllowed,
  buildChatMessages, dispatchChatJobs, sendChatDelivery,
} from "./line-chat.ts";
import { handleLineWebhookRequest } from "./line-webhook.ts";

const user = "U" + "a".repeat(32);
const event = { type: "message", webhookEventId: "event-1", replyToken: "token", timestamp: Date.now(),
  source: { type: "user", userId: user }, message: { type: "text", text: "ราคาเท่าไหร่" } };
assert.equal(parseChatEvent(event)?.userId, user);
for (const invalid of [{ ...event, source: { type: "group", userId: user } },
  { ...event, source: { type: "user", userId: "invalid" } }, { ...event, timestamp: NaN },
  { ...event, message: { type: "image" } }, { ...event, message: { type: "text", text: "x".repeat(5001) } }]) {
  assert.equal(parseChatEvent(invalid), null);
}
const saved = { ...process.env };
try {
  delete process.env.N8N_CHATBOT_WEBHOOK_URL; delete process.env.N8N_CHATBOT_SECRET;
  assert.equal(chatbotConfig(), null);
  process.env.N8N_CHATBOT_WEBHOOK_URL = "http://public.example/webhook";
  process.env.N8N_CHATBOT_SECRET = "s".repeat(64);
  assert.equal(chatbotConfig(), null);
  process.env.N8N_CHATBOT_WEBHOOK_URL = "https://n8n.example/webhook";
  assert.ok(chatbotConfig());
  assert.equal(authorizedChatCallback("Bearer " + "s".repeat(64)), true);
  assert.equal(authorizedChatCallback("Bearer bad"), false);
  process.env.LINE_CHATBOT_ALLOW_ALL_USERS = "false"; delete process.env.LINE_CHATBOT_ALLOWED_USER_IDS;
  assert.equal(chatUserAllowed(user), false);
  process.env.LINE_CHATBOT_ALLOWED_USER_IDS = user;
  assert.equal(chatUserAllowed(user), true);
  delete process.env.BOOKING_PAYMENT_AMOUNT_THB;
  const noPrice = buildChatMessages([], "hello");
  assert.ok(noPrice[0].content.includes("ห้ามเดาราคา"));
  process.env.BOOKING_PAYMENT_AMOUNT_THB = "999";
  const context = buildChatMessages([
    { user_text: "old question", reply_text: "old answer", status: "sent" },
    { user_text: "not sent", reply_text: "private draft", status: "ready" },
  ], "new question");
  assert.deepEqual(context.slice(1).map(m => m.content), ["old question", "old answer", "new question"]);
  let payload: { jobs: Array<{ jobId: string }> } | undefined;
  assert.equal(await dispatchChatJobs(["job-1", "job-2"], async (_url, options) => {
    payload = JSON.parse(String(options?.body)); return new Response("OK");
  }), true);
  assert.equal(payload?.jobs.length, 2);
  assert.equal(await dispatchChatJobs(["job-1"], async () => { throw new Error("offline"); }), false);
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
}
const base = { user_id: user, reply_token: "test-token", reply_text: "answer", retry_key: "00000000-0000-4000-8000-000000000001" };
assert.equal(await sendChatDelivery({ ...base, transport: "push" }, "test", async (_url, init) => {
  assert.equal(new Headers(init?.headers).get("x-line-retry-key"), base.retry_key); return new Response("", { status: 409 });
}), "sent");
assert.equal(await sendChatDelivery({ ...base, transport: "reply" }, "test", async () => { throw new Error("ambiguous"); }), "unknown");
assert.equal(await sendChatDelivery({ ...base, transport: "push" }, "test", async () => { throw new Error("offline"); }), "retry");
assert.equal(await sendChatDelivery({ ...base, transport: "reply" }, "test",
  async () => Response.json({ message: "Invalid reply token" }, { status: 400 })), "expired_reply");
assert.equal(await sendChatDelivery({ ...base, transport: "reply" }, "test",
  async () => Response.json({ message: "Bad messages" }, { status: 400 })), "failed");
let enqueued = 0; let dispatched = 0; let paired = 0;
const deps = {
  verifySignature: (_raw: string, signature: string | null) => signature === "valid",
  persistSelection: async () => {}, reply: async () => {},
  completePairing: async () => { paired++; return true; }, replyPairing: async () => {},
  enqueueText: async () => { enqueued++; },
  afterEvents: async () => { dispatched++; throw new Error("n8n unavailable"); },
};
const req = (events: unknown[], signature = "valid") => new Request("https://example.test/api/line/webhook",
  { method: "POST", headers: { "x-line-signature": signature }, body: JSON.stringify({ events }) });
assert.equal((await handleLineWebhookRequest(req([event], "bad"), deps)).status, 401);
assert.equal(enqueued, 0);
assert.equal((await handleLineWebhookRequest(req([event, { ...event, webhookEventId: "event-2" }]), deps)).status, 200);
assert.equal(enqueued, 2); assert.equal(dispatched, 1);
await handleLineWebhookRequest(req([{ ...event, message: { type: "text", text: "MJ-UAT-ABCD1234" } }]), deps);
assert.equal(paired, 1); assert.equal(enqueued, 2, "pairing never reaches the AI");
assert.equal((await handleLineWebhookRequest(req([event]), { ...deps, enqueueText: async () => { throw new Error("database down"); } })).status, 503);

const workflow = JSON.parse(readFileSync("n8n/mohjaew-line-ai-chat.json", "utf8"));
assert.equal(workflow.active, false);
assert.equal(workflow.nodes.find((n: { name: string }) => n.name === "Mohjaew Ingress").parameters.authentication, "headerAuth");
const split = workflow.nodes.find((n: { name: string }) => n.name === "Split Jobs");
const items = runInNewContext("(function(){" + split.parameters.jsCode + "})()", {
  $input: { first: () => ({ json: { body: { version: 2, jobs: [{ jobId: "a" }, { jobId: "b" }] } } }) },
});
assert.equal(items.length, 2);
const completion = workflow.nodes.find((n: { name: string }) => n.name === "Build Completion");
assert.equal(completion.parameters.mode, "runOnceForEachItem");
for (const [id, text] of [["a", "one"], ["b", "two"]]) {
  const result = runInNewContext("(function(){" + completion.parameters.jsCode + "})()", {
    $: () => ({ item: { json: { jobId: id, leaseToken: id + "-lease" } } }),
    $json: { choices: [{ message: { content: text } }] },
  });
  assert.equal(result.json.jobId, id); assert.equal(result.json.reply, text);
}
const failure = runInNewContext("(function(){" + completion.parameters.jsCode + "})()", {
  $: () => ({ item: { json: { jobId: "a", leaseToken: "lease" } } }), $json: { error: "timeout" },
});
assert.equal(failure.json.failed, true);
assert.ok(!JSON.stringify(workflow).includes("$env"), "Cloud-compatible credentials, no environment expressions");
console.log("LINE chat core + legacy webhook + n8n transformation tests passed");
