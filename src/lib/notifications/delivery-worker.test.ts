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
import {
  runDeliveryWorker,
  renderPaymentReceivedMessage,
  renderBookingConfirmedMessage,
  renderSlipManualReviewMessage,
  EVENT_TYPES,
  type ClaimedRow,
} from "./delivery-worker.ts";

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
assert.match(routeSrc, /LINE_BOOKING_GROUP_ID/, "must require LINE_BOOKING_GROUP_ID");
// The group id must be run through the format validator (trims, rejects
// blank/malformed/userId/roomId, no fallback) — never used raw from env.
assert.match(routeSrc, /validateLineGroupId\(process\.env\.LINE_BOOKING_GROUP_ID\)/, "must validate the group id format, not read it raw");
assert.doesNotMatch(routeSrc, /groupId\s*=\s*process\.env\.LINE_BOOKING_GROUP_ID;/, "must not use the raw unvalidated env value as groupId");
assert.ok(
  routeSrc.indexOf("line_not_configured") < routeSrc.indexOf("runDeliveryWorker("),
  "missing/invalid LINE config must return before the worker (and any claim) runs",
);
assert.ok(
  routeSrc.indexOf("validateLineGroupId(process.env.LINE_BOOKING_GROUP_ID)") < routeSrc.indexOf("runDeliveryWorker("),
  "group id validation must happen before the worker (and any claim) runs — fail closed before claiming rows",
);
assert.match(routeSrc, /error: "line_not_configured"[\s\S]*?status: 503/, "missing/invalid LINE config must return 503");

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
  workerSrc.indexOf("function field("),
);
assert.doesNotMatch(
  reviewFnSrc,
  /row\.(amount|customer_name|phone)\b|payload\?\.(amount|customer_name|phone)\b/,
  "slip_manual_review renderer must not invent fields absent from its payload",
);

// renderBookingConfirmedMessage must only read payload fields via the field()
// helper (which safely defaults to "-"), never raw `.payload.x` access that
// could throw on a missing key.
const confirmedRenderFnSrc = workerSrc.slice(
  workerSrc.indexOf("export function renderBookingConfirmedMessage"),
  workerSrc.indexOf("export function renderMessage"),
);
assert.doesNotMatch(
  confirmedRenderFnSrc,
  /\bp\.\w/,
  "renderBookingConfirmedMessage must access payload fields only through field(), never p.<key>",
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
    line_retry_key: "11111111-1111-4111-8111-111111111111",
    image_retry_key: "11111111-2222-4222-8222-111111111111",
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

// makeConfirmedRow: mirrors the exact payload shape written by
// 0012_booking_confirmed_notification.sql — no invented fields.
function makeConfirmedRow(
  id: string,
  opts: { imagePath?: string | null; confirmationMethod?: string; amounts?: boolean } = {},
): ClaimedRow {
  const { confirmationMethod = "easyslip_auto", amounts = true } = opts;
  return {
    id,
    booking_id: `booking-${id}`,
    payment_order_id: null,
    channel: "line",
    event_type: "booking_confirmed",
    payload: {
      booking_id: `booking-${id}`,
      reference_code: "ABCD1234",
      customer_name: "สมชาย",
      birth_date: "1990-01-01",
      consultation_topic: "การงาน",
      phone: "0812345678",
      booking_date: "2026-07-20",
      session_time: "09:00–12:00 (เช้า)",
      queue_number: 3,
      confirmation_method: confirmationMethod,
      ...(amounts ? { expected_amount_satang: 99900, received_amount_satang: 99900 } : {}),
      updated_at: "2026-07-14T10:00:00Z",
      image_storage_path: "imagePath" in opts ? opts.imagePath : `booking-${id}/face.jpg`,
    },
    idempotency_key: `booking:confirmed:team:booking-${id}`,
    attempt_count: 0,
    line_retry_key: "22222222-2222-4222-8222-222222222222",
    // Deliberately a different value from line_retry_key above — text and
    // image must never share a retry key.
    image_retry_key: "33333333-3333-4333-8333-333333333333",
  };
}

// Sanity check on the fixture itself: text and image retry keys must differ.
assert.notEqual(
  makeConfirmedRow("sanity").line_retry_key,
  makeConfirmedRow("sanity").image_retry_key,
  "line_retry_key and image_retry_key must be distinct values",
);

// ===========================================================================
// Wording must depend on the confirmation path. EasySlip automatic success
// claims both payment received AND booking confirmed — this is the sole
// team notification for that path (no separate payment_received message).
// ===========================================================================
{
  const text = renderBookingConfirmedMessage(makeConfirmedRow("xyz", { confirmationMethod: "easyslip_auto" }));
  assert.match(text, /ABCD1234/);
  assert.match(text, /สมชาย/);
  assert.match(text, /1990-01-01/);
  assert.match(text, /การงาน/);
  assert.match(text, /0812345678/);
  assert.match(text, /2026-07-20/);
  assert.match(text, /09:00–12:00/);
  assert.match(text, /3/);
  assert.match(text, /easyslip_auto/);
  assert.match(text, /2026-07-14T10:00:00Z/);
  assert.equal(text.split("\n")[0], "ได้รับชำระเงินและยืนยันการจองแล้ว");
  assert.match(text, /ยอดที่ต้องชำระ: 999 บาท/);
  assert.match(text, /ยอดที่ได้รับ: 999 บาท/);
}

// Provider-verified manual-review approval: distinct wording, still shows
// both amounts (the payment order backs this confirmation too).
{
  const text = renderBookingConfirmedMessage(
    makeConfirmedRow("manual", { confirmationMethod: "manual_review_approved" }),
  );
  assert.equal(text.split("\n")[0], "ตรวจสอบการชำระเงินและยืนยันการจองแล้ว");
  assert.match(text, /ยอดที่ต้องชำระ: 999 บาท/);
  assert.match(text, /ยอดที่ได้รับ: 999 บาท/);
}

// Admin override without verified payment: must never claim a payment was
// received, and — since there is no payment order — never show an amount.
{
  const text = renderBookingConfirmedMessage(
    makeConfirmedRow("override", { confirmationMethod: "admin_override", amounts: false }),
  );
  assert.equal(text.split("\n")[0], "ทีมงานยืนยันการจองแล้ว");
  assert.doesNotMatch(text, /ได้รับชำระเงิน/, "admin override must never claim payment was received");
  assert.doesNotMatch(text, /ยอดที่ต้องชำระ|ยอดที่ได้รับ/, "admin override has no payment order and must never show an amount");
}

// An unrecognized/absent confirmation_method falls back to the generic
// headline rather than throwing or showing "undefined".
{
  const row = makeConfirmedRow("unknown", { amounts: false });
  row.payload = { ...row.payload, confirmation_method: "something_else" };
  const text = renderBookingConfirmedMessage(row);
  assert.equal(text.split("\n")[0], "ยืนยันการจองคิวแล้ว");
}

// renderBookingConfirmedMessage must fall back to "-" for absent fields
// rather than throwing or printing "undefined", and must omit amount/
// Backoffice lines entirely when those fields are absent.
{
  const row = makeConfirmedRow("missing", { imagePath: null });
  row.payload = { booking_id: row.booking_id };
  const text = renderBookingConfirmedMessage(row);
  assert.doesNotMatch(text, /undefined/);
  assert.match(text, /เลขอ้างอิง: -/);
  assert.doesNotMatch(text, /ยอดที่ต้องชำระ|ยอดที่ได้รับ|Backoffice/);
}

// ===========================================================================
// Backoffice URL: included only when an appUrl is supplied, built from the
// trusted booking_id in the payload — never a relative/broken link.
// ===========================================================================
{
  const withUrl = renderBookingConfirmedMessage(makeConfirmedRow("link"), "https://backoffice.example.com/");
  assert.match(withUrl, /Backoffice: https:\/\/backoffice\.example\.com\/admin\/bookings\/booking-link/);

  const withoutUrl = renderBookingConfirmedMessage(makeConfirmedRow("nolink"));
  assert.doesNotMatch(withoutUrl, /Backoffice:/);
}

// ===========================================================================
// renderSlipManualReviewMessage: reference code, both amounts, fixed reason
// code, and the Backoffice link when configured — never the raw provider
// payload or an unredacted transaction reference (those are simply never
// present in the payload to begin with).
// ===========================================================================
function makeManualReviewRow(id: string): ClaimedRow {
  return {
    id,
    booking_id: `booking-${id}`,
    payment_order_id: `order-${id}`,
    channel: "line",
    event_type: "slip_manual_review",
    payload: {
      booking_id: `booking-${id}`,
      payment_order_id: `order-${id}`,
      reference_code: "ABCD1234",
      reason: "amount_mismatch",
      expected_amount_satang: 99900,
      received_amount_satang: 100,
    },
    idempotency_key: `slip:review:${id}`,
    attempt_count: 0,
    line_retry_key: "44444444-4444-4444-8444-444444444444",
    image_retry_key: "55555555-5555-4555-8555-555555555555",
  };
}

{
  const text = renderSlipManualReviewMessage(makeManualReviewRow("mismatch"), "https://backoffice.example.com");
  assert.match(text, /ABCD1234/);
  assert.match(text, /เหตุผล: amount_mismatch/);
  // The canonical 1 THB-against-999-THB mismatch scenario: both figures
  // must be visible, distinctly, in the alert.
  assert.match(text, /ยอดที่ต้องชำระ: 999 บาท/);
  assert.match(text, /ยอดที่ได้รับ: 1 บาท/);
  assert.match(text, /Backoffice: https:\/\/backoffice\.example\.com\/admin\/bookings\/booking-mismatch/);
  assert.doesNotMatch(text, /provider_payload|providerPayload/i);
}

{
  // No appUrl configured => no Backoffice line, never a broken relative link.
  const text = renderSlipManualReviewMessage(makeManualReviewRow("nourl"));
  assert.doesNotMatch(text, /Backoffice:/);
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
// runDeliveryWorker: payment_received, slip_manual_review, and
// booking_confirmed are passed to the claim RPC — never any other event type.
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
    "booking_confirmed",
  ]);
  assert.deepEqual(EVENT_TYPES, ["payment_received", "slip_manual_review", "booking_confirmed"]);
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
    sendPush: async (_to, text, retryKey) => {
      assert.equal(retryKey, "11111111-1111-4111-8111-111111111111");
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

// ===========================================================================
// runDeliveryWorker: booking_confirmed row with an image_storage_path sends
// text (with its stable line_retry_key) THEN signs + sends the image (with
// its OWN stable image_retry_key — never the text's key), both addressed to
// the same groupId (never a customer/different recipient).
// ===========================================================================
{
  const calls: FakeCall[] = [];
  let claimCount = 0;
  const pushedTo: string[] = [];
  const pushedRetryKeys: string[] = [];
  const signedPaths: string[] = [];
  const imageSentTo: { to: string; url: string; retryKey: string }[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "claim_team_notification_deliveries") {
        claimCount++;
        if (claimCount === 1) return { data: [makeConfirmedRow("1")], error: null };
        return { data: [], error: null };
      }
      return { data: true, error: null };
    },
  };
  const result = await runDeliveryWorker({
    db,
    sendPush: async (to, text, retryKey) => {
      pushedTo.push(to);
      pushedRetryKeys.push(retryKey);
      assert.match(text, /ได้รับชำระเงินและยืนยันการจองแล้ว/);
      return { ok: true };
    },
    signFaceUrl: async (path) => {
      signedPaths.push(path);
      return `https://signed.example/${path}`;
    },
    sendImage: async (to, url, retryKey) => {
      imageSentTo.push({ to, url, retryKey });
      return { ok: true };
    },
    groupId: "correct-group-id",
    now: () => 0,
    batch: 20,
    timeBudgetMs: 50_000,
  });
  assert.deepEqual(result, { ok: true, processed: 1, sent: 1, retried: 0, dead: 0 });
  assert.deepEqual(pushedTo, ["correct-group-id"]);
  assert.deepEqual(pushedRetryKeys, ["22222222-2222-4222-8222-222222222222"]);
  assert.deepEqual(signedPaths, ["booking-1/face.jpg"]);
  assert.deepEqual(imageSentTo, [
    {
      to: "correct-group-id",
      url: "https://signed.example/booking-1/face.jpg",
      retryKey: "33333333-3333-4333-8333-333333333333",
    },
  ]);
  assert.notEqual(pushedRetryKeys[0], imageSentTo[0].retryKey, "text and image must use different retry keys");

  const completion = calls.find((c) => c.fn === "complete_notification_delivery");
  assert.equal(completion?.args.p_outcome, "sent");
}

// ===========================================================================
// runDeliveryWorker: the image retry key is STABLE across separate claims of
// the same row (e.g. a stale-lease reclaim after a crash between LINE
// accepting the image and complete_notification_delivery committing) — it
// is never regenerated per attempt, since the row's image_retry_key column
// is fixed at insert time and simply passed through on every claim.
// ===========================================================================
{
  const seenRetryKeys: string[] = [];
  let claimCount = 0;
  const db = {
    rpc: async (fn: string) => {
      if (fn === "claim_team_notification_deliveries") {
        claimCount++;
        // Simulate two separate claims of the identical row (same
        // image_retry_key each time, as the DB column would provide).
        if (claimCount <= 2) return { data: [makeConfirmedRow("stable")], error: null };
        return { data: [], error: null };
      }
      return { data: true, error: null };
    },
  };
  await runDeliveryWorker({
    db,
    sendPush: async () => ({ ok: true }),
    signFaceUrl: async (path) => `https://signed.example/${path}`,
    sendImage: async (_to, _url, retryKey) => {
      seenRetryKeys.push(retryKey);
      return { ok: true };
    },
    groupId: "group",
    now: () => 0,
    batch: 20,
    timeBudgetMs: 50_000,
  });
  assert.deepEqual(seenRetryKeys, [
    "33333333-3333-4333-8333-333333333333",
    "33333333-3333-4333-8333-333333333333",
  ]);
}

// ===========================================================================
// runDeliveryWorker: booking_confirmed row with no image_storage_path sends
// text only — signFaceUrl/sendImage are never called.
// ===========================================================================
{
  let claimCount = 0;
  let signCalled = false;
  let imageCalled = false;
  const db = {
    rpc: async (fn: string) => {
      if (fn === "claim_team_notification_deliveries") {
        claimCount++;
        if (claimCount === 1) return { data: [makeConfirmedRow("1", { imagePath: null })], error: null };
        return { data: [], error: null };
      }
      return { data: true, error: null };
    },
  };
  const result = await runDeliveryWorker({
    db,
    sendPush: async () => ({ ok: true }),
    signFaceUrl: async (path) => {
      signCalled = true;
      return `https://signed.example/${path}`;
    },
    sendImage: async () => {
      imageCalled = true;
      return { ok: true };
    },
    groupId: "group",
    now: () => 0,
    batch: 20,
    timeBudgetMs: 50_000,
  });
  assert.deepEqual(result, { ok: true, processed: 1, sent: 1, retried: 0, dead: 0 });
  assert.equal(signCalled, false);
  assert.equal(imageCalled, false);
}

// ===========================================================================
// runDeliveryWorker: booking_confirmed row also works with signFaceUrl/
// sendImage entirely omitted (route always supplies them, but the worker
// must not crash if it doesn't) — text still sends.
// ===========================================================================
{
  let claimCount = 0;
  const db = {
    rpc: async (fn: string) => {
      if (fn === "claim_team_notification_deliveries") {
        claimCount++;
        if (claimCount === 1) return { data: [makeConfirmedRow("1")], error: null };
        return { data: [], error: null };
      }
      return { data: true, error: null };
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
  assert.deepEqual(result, { ok: true, processed: 1, sent: 1, retried: 0, dead: 0 });
}

// ===========================================================================
// runDeliveryWorker: image signing/send failure never affects the row's
// outcome — text was already sent, so it must be recorded 'sent', not
// retried, and the failure must be logged behind a single fixed literal
// (never the storage path, signed URL, or group id).
// ===========================================================================
{
  let claimCount = 0;
  const db = {
    rpc: async (fn: string) => {
      if (fn === "claim_team_notification_deliveries") {
        claimCount++;
        if (claimCount === 1) return { data: [makeConfirmedRow("1")], error: null };
        return { data: [], error: null };
      }
      return { data: true, error: null };
    },
  };
  const { result, logs } = await captureConsoleErrors(() =>
    runDeliveryWorker({
      db,
      sendPush: async () => ({ ok: true }),
      signFaceUrl: async () => {
        throw new Error("leaked-signing-detail-secret-path");
      },
      sendImage: async () => ({ ok: true }),
      groupId: "group",
      now: () => 0,
      batch: 20,
      timeBudgetMs: 50_000,
    }),
  );
  assert.deepEqual(result, { ok: true, processed: 1, sent: 1, retried: 0, dead: 0 });
  for (const args of logs) {
    assert.doesNotMatch(JSON.stringify(args), /leaked-signing-detail-secret-path/);
  }
  assert.ok(logs.some((args) => args.length === 1 && args[0] === "notification_image_send_failed"));
}

// ===========================================================================
// runDeliveryWorker: a retryable LINE failure on a booking_confirmed row
// only ever touches notification_deliveries (via complete_notification_delivery)
// — the worker never issues an RPC against bookings/transition_slot_booking/
// confirm_slip_payment/approve_manual_review_payment, so a LINE outage can
// never affect booking status.
// ===========================================================================
{
  const calls: FakeCall[] = [];
  let claimCount = 0;
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "claim_team_notification_deliveries") {
        claimCount++;
        if (claimCount === 1) return { data: [makeConfirmedRow("1")], error: null };
        return { data: [], error: null };
      }
      return { data: true, error: null };
    },
  };
  const result = await runDeliveryWorker({
    db,
    sendPush: async () => ({ ok: false, retryable: true, error: "line_push_failed_500" }),
    groupId: "group",
    now: () => 0,
    batch: 20,
    timeBudgetMs: 50_000,
  });
  assert.deepEqual(result, { ok: true, processed: 1, sent: 0, retried: 1, dead: 0 });
  assert.ok(calls.every((c) => c.fn === "claim_team_notification_deliveries" || c.fn === "complete_notification_delivery"));
}

console.log("delivery-worker self-check passed");
