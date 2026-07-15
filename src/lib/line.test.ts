// Self-check for pushMessage() result classification (Phase 1A / Task 2).
// Run: node --experimental-strip-types src/lib/line.test.ts
import assert from "node:assert";

process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token-do-not-log";
process.env.LINE_CHANNEL_SECRET = "test-secret";
process.env.LINE_BOOKING_GROUP_ID = "C" + "0".repeat(32);

const { pushMessage, pushImageMessage, validateLineGroupId } = await import("./line.ts");

// ===========================================================================
// validateLineGroupId: only a real LINE groupId (C + 32 hex chars) passes.
// userId (U…) and roomId (R…) are a different LINE source type and must be
// rejected, not treated as interchangeable with a group. No fallback: every
// rejection path returns null, never a substitute value.
// ===========================================================================
const VALID_GROUP_ID = "C1234567890abcdef1234567890abcdef";
assert.equal(validateLineGroupId(VALID_GROUP_ID), VALID_GROUP_ID);
assert.equal(validateLineGroupId(VALID_GROUP_ID.toUpperCase()), VALID_GROUP_ID.toUpperCase(), "uppercase hex must still validate");

// Trims surrounding whitespace before validating.
assert.equal(validateLineGroupId(`  ${VALID_GROUP_ID}  `), VALID_GROUP_ID);
assert.equal(validateLineGroupId(`\t${VALID_GROUP_ID}\n`), VALID_GROUP_ID);

// Blank / whitespace-only.
assert.equal(validateLineGroupId(undefined), null);
assert.equal(validateLineGroupId(null), null);
assert.equal(validateLineGroupId(""), null);
assert.equal(validateLineGroupId("   "), null);
assert.equal(validateLineGroupId("\t\n"), null);

// userId / roomId must never be accepted as a group.
assert.equal(validateLineGroupId("U1234567890abcdef1234567890abcdef"), null, "userId (U…) must be rejected");
assert.equal(validateLineGroupId("R1234567890abcdef1234567890abcdef"), null, "roomId (R…) must be rejected");

// Malformed: wrong length, non-hex characters, wrong prefix, extra content.
assert.equal(validateLineGroupId("C123"), null, "too short must be rejected");
assert.equal(validateLineGroupId(VALID_GROUP_ID + "0"), null, "too long must be rejected");
assert.equal(validateLineGroupId("Cabcdefghij1234567890abcdef123456"), null, "non-hex characters must be rejected");
assert.equal(validateLineGroupId("X1234567890abcdef1234567890abcdef"), null, "wrong prefix must be rejected");
assert.equal(validateLineGroupId(`${VALID_GROUP_ID} DROP TABLE x`), null, "trailing garbage must be rejected, not truncated/accepted");
assert.equal(validateLineGroupId("test-group"), null, "an arbitrary placeholder string must be rejected");

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

// ===========================================================================
// pushImageMessage: same retry-key/409-as-success/retryable classification
// as pushMessage, sending an image message instead of text.
// ===========================================================================
let observedImageRetryKey: string | null = null;
globalThis.fetch = (async (_url, init) => {
  observedImageRetryKey = new Headers(init?.headers).get("X-Line-Retry-Key");
  return new Response("{}", { status: 409 });
}) as typeof fetch;
assert.deepEqual(
  await pushImageMessage("Cgroup", "https://example.com/signed.jpg", "img-retry-key-1"),
  { ok: true },
);
assert.equal(observedImageRetryKey, "img-retry-key-1");

mockFetch(() => new Response("{}", { status: 200 }));
{
  const result = await pushImageMessage("Cgroup", "https://example.com/signed.jpg");
  assert.deepEqual(result, { ok: true });
}

mockFetch(() => new Response("server error body", { status: 500 }));
{
  const result = await pushImageMessage("Cgroup", "https://example.com/signed.jpg");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.retryable, true);
}

mockFetch(() => new Response("bad request body", { status: 400 }));
{
  const result = await pushImageMessage("Cgroup", "https://example.com/signed.jpg");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.retryable, false);
}

mockFetch(() => {
  throw new TypeError("fetch failed");
});
{
  const result = await pushImageMessage("Cgroup", "https://example.com/signed.jpg");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.retryable, true);
}

// --- errors must never leak the signed URL or group id ---------------------
mockFetch(() => new Response("secret-response-body https://example.com/signed.jpg", { status: 500 }));
{
  const result = await pushImageMessage("Csecret-group-id", "https://example.com/signed-secret.jpg");
  assert.equal(result.ok, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /Csecret-group-id/, "must not leak the recipient group id");
  assert.doesNotMatch(serialized, /signed-secret/, "must not leak the signed URL");
  assert.doesNotMatch(serialized, /secret-response-body/, "must not leak the raw response body");
}

globalThis.fetch = originalFetch;

console.log("line self-check passed");
