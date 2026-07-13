// Self-check for the team-notification delivery worker (Phase 1A / Task 3).
// Run: node --experimental-strip-types src/lib/notifications/delivery-worker.test.ts
//
// delivery-worker.ts is dependency-injected and free of Next.js/env imports,
// so its claim/complete/time-budget logic is exercised directly here with
// fakes. The route wrapper (route.ts) wires in real env/Supabase/pushMessage
// and is checked statically below (same convention as
// integration-guards.test.ts's cron checks), since importing a Next.js route
// file (next/server) is not resolvable under a plain Node run.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { PushResult } from "../line.ts";
import { runDeliveryWorker, renderPaymentReceivedMessage, type ClaimedRow } from "./delivery-worker.ts";

const here = dirname(fileURLToPath(import.meta.url));
const routeSrc = readFileSync(
  join(here, "..", "..", "app", "api", "cron", "deliver-notifications", "route.ts"),
  "utf8",
);

// ===========================================================================
// route.ts: auth mirrors expire-bookings, kill switch, LINE-config gate
// ===========================================================================
assert.match(routeSrc, /process\.env\.CRON_SECRET/, "must read CRON_SECRET");
assert.match(routeSrc, /status: 503 \}/, "must return 503 when CRON_SECRET is unset");
assert.match(routeSrc, /Bearer \$\{secret\}/, "must verify the Bearer token");
assert.match(routeSrc, /new NextResponse\("Unauthorized", \{ status: 401 \}\)/, "must return 401 on bad auth");

assert.match(
  routeSrc,
  /process\.env\.OUTBOX_DELIVERY_ENABLED !== "true"/,
  "delivery must default OFF and only enable on the literal string 'true'",
);
// The disabled branch must appear before any claim/RPC call in the file.
assert.ok(
  routeSrc.indexOf('OUTBOX_DELIVERY_ENABLED !== "true"') < routeSrc.indexOf("runDeliveryWorker("),
  "disabled check must short-circuit before the worker (and any claim) runs",
);

assert.match(routeSrc, /LINE_CHANNEL_ACCESS_TOKEN/, "must require LINE_CHANNEL_ACCESS_TOKEN");
assert.match(routeSrc, /LINE_BOOKING_NOTIFY_GROUP_ID/, "must require LINE_BOOKING_NOTIFY_GROUP_ID");
assert.ok(
  routeSrc.indexOf("line_not_configured") < routeSrc.indexOf("runDeliveryWorker("),
  "missing LINE config must return before the worker (and any claim) runs",
);
assert.match(routeSrc, /error: "line_not_configured"[\s\S]*?status: 503/, "missing LINE config must return 503");

// A claim/completion RPC failure must surface as a 500, never a silent 200.
assert.match(
  routeSrc,
  /if \(!result\.ok\)\s*\{\s*\n\s*return NextResponse\.json\(\{ error: "worker_failed" \}, \{ status: 500 \}\);/,
  "route must return a generic 500 when the worker reports a claim/completion failure",
);

// No raw payload, recipient group id, or token in any log/error in the route.
assert.doesNotMatch(routeSrc, /console\.(log|warn|error)\([^)]*\bgroupId\b/, "must not log the recipient group id");
assert.doesNotMatch(routeSrc, /console\.(log|warn|error)\([^)]*\btoken\b/, "must not log the LINE access token");
// The route's failure response must be a fixed generic body, not the raw db/thrown error.
assert.doesNotMatch(routeSrc, /result\.code/, "route must not echo the internal failure code to the HTTP response");

// ===========================================================================
// delivery-worker.ts: message must only use fields process_payment_paid_event
// actually writes (booking_id, payment_order_id) — no invented fields.
// ===========================================================================
const workerSrc = readFileSync(join(here, "delivery-worker.ts"), "utf8");
assert.doesNotMatch(workerSrc, /console\.(log|warn|error)\([^)]*\brow\.payload\b/, "must not log row.payload");
// The only console.error calls anywhere in the worker must be fixed literal
// strings — never error.message, never a template with row/db/thrown content.
const consoleErrorCalls = [...workerSrc.matchAll(/console\.error\(([^)]*)\)/g)].map((m) => m[1].trim());
assert.ok(consoleErrorCalls.length > 0, "sanity check: worker must log something on failure paths");
for (const args of consoleErrorCalls) {
  assert.match(args, /^"[a-z_]+"$/, `console.error must take a single fixed literal string, got: ${args}`);
}

const renderFnSrc = workerSrc.slice(
  workerSrc.indexOf("export function renderPaymentReceivedMessage"),
  workerSrc.indexOf("export function renderSlipManualReviewMessage"),
);
assert.doesNotMatch(
  renderFnSrc,
  /row\.(amount|customer_name|phone|payload)\b/,
  "message renderer must not invent fields absent from the payment_received payload",
);
// The slip_manual_review renderer may read ONLY payload.reason (which
// confirm_slip_payment writes) — never amount/name/phone.
const reviewFnSrc = workerSrc.slice(
  workerSrc.indexOf("export function renderSlipManualReviewMessage"),
  workerSrc.indexOf("export function renderMessage"),
);
assert.doesNotMatch(
  reviewFnSrc,
  /row\.(amount|customer_name|phone)\b|payload\?\.(amount|customer_name|phone)\b/,
  "slip_manual_review renderer must not invent fields absent from its payload",
);

function makeRow(id: string): ClaimedRow {
  return {
    id,
    booking_id: `booking-${id}`,
    payment_order_id: `order-${id}`,
    channel: "line",
    event_type: "payment_received",
    payload: { booking_id: `booking-${id}`, payment_order_id: `order-${id}` },
    idempotency_key: `pay:received:team:order-${id}`,
    attempt_count: 0,
  };
}

{
  const text = renderPaymentReceivedMessage(makeRow("abc"));
  assert.match(text, /booking-abc/);
  assert.match(text, /order-abc/);
  // Pin the exact UTF-8 Thai literal so mojibake/encoding corruption of the
  // source file cannot silently pass — this must be byte-for-byte equal to
  // "แจ้งเตือน: ได้รับการชำระเงินแล้ว", not merely "look right" in an editor.
  const firstLine = text.split("\n")[0];
  assert.equal(firstLine, "แจ้งเตือน: ได้รับการชำระเงินแล้ว");
}

// --- console.error capture helper for privacy assertions --------------------
function captureConsoleErrors<T>(fn: () => Promise<T>): Promise<{ result: T; logs: unknown[][] }> {
  const logs: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args);
  };
  return fn()
    .then((result) => ({ result, logs }))
    .finally(() => {
      console.error = original;
    });
}

type FakeCall = { fn: string; args: Record<string, unknown> };

// ===========================================================================
// runDeliveryWorker: payment_received-only is passed to the claim RPC
// ===========================================================================
{
  const calls: FakeCall[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: [], error: null };
    },
  };
  const result = await runDeliveryWorker({
    db,
    sendPush: async () => ({ ok: true }),
    groupId: "group",
    now: () => 0,
    batch: 20,
    timeBudgetMs: 50_000,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, "claim_team_notification_deliveries");
  assert.deepEqual(calls[0].args.p_event_types, [
    "payment_received",
    "slip_manual_review",
  ]);
}

// ===========================================================================
// runDeliveryWorker: success / retryable / permanent failure call
// complete_notification_delivery with the correct outcome and error, and
// the completion RPC "true" result is required to count the metric.
// ===========================================================================
{
  const calls: FakeCall[] = [];
  let claimCount = 0;
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "claim_team_notification_deliveries") {
        claimCount++;
        if (claimCount === 1) return { data: [makeRow("1"), makeRow("2"), makeRow("3")], error: null };
        return { data: [], error: null };
      }
      return { data: true, error: null };
    },
  };
  const pushResults: Record<string, PushResult> = {
    "booking-1": { ok: true },
    "booking-2": { ok: false, retryable: true, error: "line_push_failed_500" },
    "booking-3": { ok: false, retryable: false, error: "line_push_failed_400" },
  };
  const result = await runDeliveryWorker({
    db,
    sendPush: async (_to, text) => {
      const key = Object.keys(pushResults).find((k) => text.includes(k))!;
      return pushResults[key];
    },
    groupId: "group",
    now: () => 0,
    batch: 20,
    timeBudgetMs: 50_000,
  });
  assert.deepEqual(result, { ok: true, processed: 3, sent: 1, retried: 1, dead: 1 });

  const completions = calls.filter((c) => c.fn === "complete_notification_delivery");
  assert.equal(completions.length, 3);
  const byId = Object.fromEntries(completions.map((c) => [c.args.p_id as string, c.args]));
  assert.equal(byId["1"].p_outcome, "sent");
  assert.equal(byId["1"].p_error, undefined);
  assert.equal(byId["2"].p_outcome, "retry");
  assert.equal(byId["2"].p_error, "line_push_failed_500");
  assert.equal(byId["3"].p_outcome, "dead");
  assert.equal(byId["3"].p_error, "line_push_failed_400");
}

// ===========================================================================
// runDeliveryWorker: time-budget behavior — stops once elapsed >= budget,
// even with an inexhaustible queue.
// ===========================================================================
{
  let claimCount = 0;
  let clock = 0;
  const db = {
    rpc: async (fn: string) => {
      if (fn === "claim_team_notification_deliveries") {
        claimCount++;
        return { data: [makeRow(String(claimCount))], error: null };
      }
      return { data: true, error: null };
    },
  };
  const result = await runDeliveryWorker({
    db,
    sendPush: async () => {
      clock += 30; // each send "costs" 30ms of simulated time
      return { ok: true };
    },
    groupId: "group",
    now: () => clock,
    batch: 1,
    timeBudgetMs: 100,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.processed < 10, "must stop well before an unbounded number of rows");
    assert.ok(result.processed >= 1, "must process at least one row before the budget is spent");
    assert.equal(result.sent, result.processed);
  }
}

// ===========================================================================
// runDeliveryWorker: sendPush throwing => treated as retryable
// push_unexpected_error, completion called with outcome "retry", and the
// thrown message never enters logs.
// ===========================================================================
{
  const calls: FakeCall[] = [];
  let claimCount = 0;
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "claim_team_notification_deliveries") {
        claimCount++;
        if (claimCount === 1) return { data: [makeRow("1")], error: null };
        return { data: [], error: null };
      }
      return { data: true, error: null };
    },
  };
  const { result, logs } = await captureConsoleErrors(() =>
    runDeliveryWorker({
      db,
      sendPush: async () => {
        throw new Error("super-secret-line-token-abc123");
      },
      groupId: "group",
      now: () => 0,
      batch: 20,
      timeBudgetMs: 50_000,
    }),
  );
  assert.deepEqual(result, { ok: true, processed: 1, sent: 0, retried: 1, dead: 0 });
  const completion = calls.find((c) => c.fn === "complete_notification_delivery");
  assert.equal(completion?.args.p_outcome, "retry");
  assert.equal(completion?.args.p_error, "push_unexpected_error");
  for (const args of logs) {
    assert.doesNotMatch(JSON.stringify(args), /super-secret-line-token-abc123/);
  }
}

// ===========================================================================
// runDeliveryWorker: claim RPC returned error => safe typed worker failure,
// never a silent success, and the db error message never enters logs.
// ===========================================================================
{
  const { result, logs } = await captureConsoleErrors(() =>
    runDeliveryWorker({
      db: { rpc: async () => ({ data: null, error: { message: "leaked-db-detail-xyz" } }) },
      sendPush: async () => ({ ok: true }),
      groupId: "group",
      now: () => 0,
      batch: 20,
      timeBudgetMs: 50_000,
    }),
  );
  assert.deepEqual(result, { ok: false, code: "claim_failed" });
  for (const args of logs) {
    assert.doesNotMatch(JSON.stringify(args), /leaked-db-detail-xyz/);
  }
  assert.ok(logs.some((args) => args.length === 1 && args[0] === "notification_claim_failed"));
}

// ===========================================================================
// runDeliveryWorker: claim RPC throws => safe typed worker failure, never a
// silent success, and the thrown message never enters logs.
// ===========================================================================
{
  const { result, logs } = await captureConsoleErrors(() =>
    runDeliveryWorker({
      db: {
        rpc: async () => {
          throw new Error("leaked-thrown-detail-xyz");
        },
      },
      sendPush: async () => ({ ok: true }),
      groupId: "group",
      now: () => 0,
      batch: 20,
      timeBudgetMs: 50_000,
    }),
  );
  assert.deepEqual(result, { ok: false, code: "claim_failed" });
  for (const args of logs) {
    assert.doesNotMatch(JSON.stringify(args), /leaked-thrown-detail-xyz/);
  }
}

// ===========================================================================
// runDeliveryWorker: completion RPC error/throw => safe typed worker failure,
// never a silent success.
// ===========================================================================
{
  let claimCount = 0;
  const dbError = {
    rpc: async (fn: string) => {
      if (fn === "claim_team_notification_deliveries") {
        claimCount++;
        if (claimCount === 1) return { data: [makeRow("1")], error: null };
        return { data: [], error: null };
      }
      return { data: null, error: { message: "leaked-completion-db-detail" } };
    },
  };
  const { result, logs } = await captureConsoleErrors(() =>
    runDeliveryWorker({
      db: dbError,
      sendPush: async () => ({ ok: true }),
      groupId: "group",
      now: () => 0,
      batch: 20,
      timeBudgetMs: 50_000,
    }),
  );
  assert.deepEqual(result, { ok: false, code: "completion_failed" });
  for (const args of logs) {
    assert.doesNotMatch(JSON.stringify(args), /leaked-completion-db-detail/);
  }
}

{
  let claimCount = 0;
  const dbThrow = {
    rpc: async (fn: string) => {
      if (fn === "claim_team_notification_deliveries") {
        claimCount++;
        if (claimCount === 1) return { data: [makeRow("1")], error: null };
        return { data: [], error: null };
      }
      throw new Error("leaked-completion-thrown-detail");
    },
  };
  const { result, logs } = await captureConsoleErrors(() =>
    runDeliveryWorker({
      db: dbThrow,
      sendPush: async () => ({ ok: true }),
      groupId: "group",
      now: () => 0,
      batch: 20,
      timeBudgetMs: 50_000,
    }),
  );
  assert.deepEqual(result, { ok: false, code: "completion_failed" });
  for (const args of logs) {
    assert.doesNotMatch(JSON.stringify(args), /leaked-completion-thrown-detail/);
  }
}

// ===========================================================================
// runDeliveryWorker: completion RPC returns false (fence lost — this worker
// no longer holds the lease) => must NOT be counted as sent/retried/dead,
// and only a fixed generic event name is logged.
// ===========================================================================
{
  let claimCount = 0;
  const db = {
    rpc: async (fn: string) => {
      if (fn === "claim_team_notification_deliveries") {
        claimCount++;
        if (claimCount === 1) return { data: [makeRow("1"), makeRow("2")], error: null };
        return { data: [], error: null };
      }
      return { data: false, error: null };
    },
  };
  const { result, logs } = await captureConsoleErrors(() =>
    runDeliveryWorker({
      db,
      sendPush: async () => ({ ok: true }),
      groupId: "group",
      now: () => 0,
      batch: 20,
      timeBudgetMs: 50_000,
    }),
  );
  assert.deepEqual(result, { ok: true, processed: 2, sent: 0, retried: 0, dead: 0 });
  assert.ok(
    logs.filter((args) => args.length === 1 && args[0] === "notification_completion_fence_lost").length === 2,
  );
}

console.log("delivery-worker self-check passed");
