// Self-check for pushMessage() result classification (Phase 1A / Task 2).
// Run: node --experimental-strip-types src/lib/line.test.ts
import assert from "node:assert";

process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token-do-not-log";
process.env.LINE_CHANNEL_SECRET = "test-secret";
process.env.LINE_BOOKING_NOTIFY_GROUP_ID = "test-group";

const { pushMessage } = await import("./line.ts");

const originalFetch = globalThis.fetch;
function mockFetch(handler: () => Promise<Response> | Response | never) {
  globalThis.fetch = (async () => handler()) as typeof fetch;
}

// The retry key is supplied by the durable outbox row and must be transmitted
// unchanged. LINE 409 for that key means the prior request was accepted.
let observedRetryKey: string | null = null;
globalThis.fetch = (async (_url, init) => {
  observedRetryKey = new Headers(init?.headers).get("X-Line-Retry-Key");
  return new Response("{}", { status: 409 });
}) as typeof fetch;
assert.deepEqual(await pushMessage("U123", "hello", "retry-key-1"), { ok: true });
assert.equal(observedRetryKey, "retry-key-1");

// --- 2xx => success -----------------------------------------------------
mockFetch(() => new Response("{}", { status: 200 }));
{
  const result = await pushMessage("U123", "hello");
  assert.deepEqual(result, { ok: true });
}

// --- 429 => retryable -----------------------------------------------------
mockFetch(() => new Response("rate limited body", { status: 429 }));
{
  const result = await pushMessage("U123", "hello");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.retryable, true);
}

// --- 5xx => retryable -------------------------------------------------------
for (const status of [500, 502, 503]) {
  mockFetch(() => new Response("server error body", { status }));
  const result = await pushMessage("U123", "hello");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.retryable, true, `status ${status} must be retryable`);
}

// --- other 4xx => permanent / non-retryable ---------------------------------
for (const status of [400, 401, 403, 404]) {
  mockFetch(() => new Response("bad request body", { status }));
  const result = await pushMessage("U123", "hello");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.retryable, false, `status ${status} must NOT be retryable`);
}

// --- network failure => retryable -------------------------------------------
mockFetch(() => {
  throw new TypeError("fetch failed");
});
{
  const result = await pushMessage("U123", "hello");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.retryable, true);
}

// --- errors must never leak the token, recipient id, or raw response body --
mockFetch(() => new Response("secret-response-body U123", { status: 500 }));
{
  const result = await pushMessage("U999-secret-recipient", "hello");
  assert.equal(result.ok, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /test-token-do-not-log/, "must not leak the access token");
  assert.doesNotMatch(serialized, /U999-secret-recipient/, "must not leak the recipient id");
  assert.doesNotMatch(serialized, /secret-response-body/, "must not leak the raw response body");
}

globalThis.fetch = originalFetch;

console.log("line self-check passed");
