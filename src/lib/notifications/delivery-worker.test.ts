// Self-check for the team-notification delivery workers (Phase 1A / Task 3,
// extended by 0013_payment_slip_notification_image.sql for images).
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
  runImageDeliveryWorker,
  renderPaymentReceivedMessage,
  renderBookingConfirmedMessage,
  renderSlipManualReviewMessage,
  EVENT_TYPES,
  type ClaimedRow,
  type ImageClaimedRow,
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
assert.match(routeSrc, /runImageDeliveryWorker\(/, "route must also run the image delivery worker");
assert.match(routeSrc, /error: "image_worker_failed"/, "route must surface an image-worker claim/completion failure distinctly");
// Image delivery must run regardless of the text loop's own claimed count —
// it is entirely independent (see this file's runImageDeliveryWorker tests).
assert.ok(
  routeSrc.indexOf("runDeliveryWorker(") < routeSrc.indexOf("runImageDeliveryWorker("),
  "text delivery must be attempted before image delivery in the route (ordering only, not a dependency)",
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
// 0012_booking_confirmed_notification.sql / 0013_payment_slip_notification_image.sql
// — no invented fields. The payload never carries an image-path field at
// all (0013): image delivery is driven entirely by notification_image_deliveries.
function makeConfirmedRow(
  id: string,
  opts: { confirmationMethod?: string; amounts?: boolean } = {},
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
    },
    idempotency_key: `booking:confirmed:team:booking-${id}`,
    attempt_count: 0,
    line_retry_key: "22222222-2222-4222-8222-222222222222",
  };
}

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
  const row = makeConfirmedRow("missing");
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

// ===========================================================================
// runImageDeliveryWorker (0013_payment_slip_notification_image.sql):
// entirely separate claim/complete RPC pair from the text worker above — an
// image failure never touches notification_deliveries/complete_notification_delivery,
// and a text failure never touches notification_image_deliveries.
// ===========================================================================

function makeImageRow(id: string, kind: "face" | "payment_slip", path: string, retryKey: string): ImageClaimedRow {
  return {
    id,
    notification_delivery_id: `notif-${id}`,
    image_kind: kind,
    storage_path: path,
    line_retry_key: retryKey,
    attempt_count: 0,
  };
}

// ---------------------------------------------------------------------------
// Claims from claim_notification_image_deliveries only.
// ---------------------------------------------------------------------------
{
  const calls: FakeCall[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: [], error: null };
    },
  };
  const result = await runImageDeliveryWorker({
    db,
    sendImage: async () => ({ ok: true }),
    signFaceUrl: async (p) => `https://signed.example/${p}`,
    signSlipUrl: async (p) => `https://signed.example/${p}`,
    groupId: "group",
    now: () => 0,
    batch: 20,
    timeBudgetMs: 50_000,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, "claim_notification_image_deliveries");
}

// ---------------------------------------------------------------------------
// A face row and a slip row in the same batch: each is signed with the
// correct bucket-specific signer, sent to the same groupId with its own
// stable, distinct retry key, and completed independently.
// ---------------------------------------------------------------------------
{
  const calls: FakeCall[] = [];
  let claimCount = 0;
  const signedFacePaths: string[] = [];
  const signedSlipPaths: string[] = [];
  const imageSends: { to: string; url: string; retryKey: string }[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "claim_notification_image_deliveries") {
        claimCount++;
        if (claimCount === 1) {
          return {
            data: [
              makeImageRow("f1", "face", "booking-1/face.jpg", "aaaaaaaa-1111-4111-8111-111111111111"),
              makeImageRow("s1", "payment_slip", "booking-1/order-1.jpg", "bbbbbbbb-2222-4222-8222-222222222222"),
            ],
            error: null,
          };
        }
        return { data: [], error: null };
      }
      return { data: true, error: null };
    },
  };
  const result = await runImageDeliveryWorker({
    db,
    sendImage: async (to, url, retryKey) => {
      imageSends.push({ to, url, retryKey });
      return { ok: true };
    },
    signFaceUrl: async (p) => {
      signedFacePaths.push(p);
      return `https://signed.example/face/${p}`;
    },
    signSlipUrl: async (p) => {
      signedSlipPaths.push(p);
      return `https://signed.example/slip/${p}`;
    },
    groupId: "correct-group-id",
    now: () => 0,
    batch: 20,
    timeBudgetMs: 50_000,
  });
  assert.deepEqual(result, { ok: true, processed: 2, sent: 2, retried: 0, dead: 0 });
  assert.deepEqual(signedFacePaths, ["booking-1/face.jpg"]);
  assert.deepEqual(signedSlipPaths, ["booking-1/order-1.jpg"]);
  assert.deepEqual(imageSends, [
    { to: "correct-group-id", url: "https://signed.example/face/booking-1/face.jpg", retryKey: "aaaaaaaa-1111-4111-8111-111111111111" },
    { to: "correct-group-id", url: "https://signed.example/slip/booking-1/order-1.jpg", retryKey: "bbbbbbbb-2222-4222-8222-222222222222" },
  ]);
  assert.notEqual(imageSends[0].retryKey, imageSends[1].retryKey, "face and slip must use distinct, stable retry keys");

  const completions = calls.filter((c) => c.fn === "complete_notification_image_delivery");
  assert.equal(completions.length, 2);
  assert.ok(completions.every((c) => c.args.p_outcome === "sent"));
}

// ---------------------------------------------------------------------------
// A face failure must not block or resend the slip, and vice versa: each row
// in a batch is completed independently, one retryable failure does not
// affect the other row's outcome.
// ---------------------------------------------------------------------------
{
  let claimCount = 0;
  const completions: { id: string; outcome: string; error?: string }[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "claim_notification_image_deliveries") {
        claimCount++;
        if (claimCount === 1) {
          return {
            data: [
              makeImageRow("f2", "face", "booking-2/face.jpg", "cccccccc-1111-4111-8111-111111111111"),
              makeImageRow("s2", "payment_slip", "booking-2/order-2.jpg", "dddddddd-2222-4222-8222-222222222222"),
            ],
            error: null,
          };
        }
        return { data: [], error: null };
      }
      completions.push({ id: args.p_id as string, outcome: args.p_outcome as string, error: args.p_error as string | undefined });
      return { data: true, error: null };
    },
  };
  const result = await runImageDeliveryWorker({
    db,
    sendImage: async (_to, url) => {
      if (url.includes("face")) return { ok: false, retryable: true, error: "line_push_failed_500" };
      return { ok: true };
    },
    signFaceUrl: async (p) => `https://signed.example/face/${p}`,
    signSlipUrl: async (p) => `https://signed.example/slip/${p}`,
    groupId: "group",
    now: () => 0,
    batch: 20,
    timeBudgetMs: 50_000,
  });
  assert.deepEqual(result, { ok: true, processed: 2, sent: 1, retried: 1, dead: 0 });
  const byId = Object.fromEntries(completions.map((c) => [c.id, c]));
  assert.equal(byId["f2"].outcome, "retry");
  assert.equal(byId["f2"].error, "line_push_failed_500");
  assert.equal(byId["s2"].outcome, "sent");
}

// ---------------------------------------------------------------------------
// A permanent (non-retryable) failure completes as 'dead'; a signing failure
// (null URL) is treated as retryable rather than silently dropped, so a
// transient signing hiccup gets picked up again by a later cron tick.
// ---------------------------------------------------------------------------
{
  let claimCount = 0;
  const completions: { outcome: string; error?: string }[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "claim_notification_image_deliveries") {
        claimCount++;
        if (claimCount === 1) {
          return { data: [makeImageRow("f3", "face", "booking-3/face.jpg", "eeeeeeee-1111-4111-8111-111111111111")], error: null };
        }
        return { data: [], error: null };
      }
      completions.push({ outcome: args.p_outcome as string, error: args.p_error as string | undefined });
      return { data: true, error: null };
    },
  };
  const deadResult = await runImageDeliveryWorker({
    db,
    sendImage: async () => ({ ok: false, retryable: false, error: "line_push_failed_400" }),
    signFaceUrl: async (p) => `https://signed.example/${p}`,
    signSlipUrl: async (p) => `https://signed.example/${p}`,
    groupId: "group",
    now: () => 0,
    batch: 20,
    timeBudgetMs: 50_000,
  });
  assert.deepEqual(deadResult, { ok: true, processed: 1, sent: 0, retried: 0, dead: 1 });
  assert.equal(completions[0].outcome, "dead");
  assert.equal(completions[0].error, "line_push_failed_400");
}

{
  let claimCount = 0;
  const completions: { outcome: string; error?: string }[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "claim_notification_image_deliveries") {
        claimCount++;
        if (claimCount === 1) {
          return { data: [makeImageRow("f4", "face", "booking-4/face.jpg", "ffffffff-1111-4111-8111-111111111111")], error: null };
        }
        return { data: [], error: null };
      }
      completions.push({ outcome: args.p_outcome as string, error: args.p_error as string | undefined });
      return { data: true, error: null };
    },
  };
  const signFailResult = await runImageDeliveryWorker({
    db,
    sendImage: async () => ({ ok: true }),
    signFaceUrl: async () => null,
    signSlipUrl: async (p) => `https://signed.example/${p}`,
    groupId: "group",
    now: () => 0,
    batch: 20,
    timeBudgetMs: 50_000,
  });
  assert.deepEqual(signFailResult, { ok: true, processed: 1, sent: 0, retried: 1, dead: 0 });
  assert.equal(completions[0].outcome, "retry");
  assert.equal(completions[0].error, "sign_failed");
}

// ---------------------------------------------------------------------------
// sendImage throwing is treated as retryable, never crashes the worker, and
// the thrown message never enters logs.
// ---------------------------------------------------------------------------
{
  let claimCount = 0;
  const db = {
    rpc: async (fn: string) => {
      if (fn === "claim_notification_image_deliveries") {
        claimCount++;
        if (claimCount === 1) {
          return { data: [makeImageRow("f5", "face", "booking-5/face.jpg", "11111111-9999-4999-8999-999999999999")], error: null };
        }
        return { data: [], error: null };
      }
      return { data: true, error: null };
    },
  };
  const { result, logs } = await captureConsoleErrors(() =>
    runImageDeliveryWorker({
      db,
      sendImage: async () => {
        throw new Error("leaked-image-send-detail");
      },
      signFaceUrl: async (p) => `https://signed.example/${p}`,
      signSlipUrl: async (p) => `https://signed.example/${p}`,
      groupId: "group",
      now: () => 0,
      batch: 20,
      timeBudgetMs: 50_000,
    }),
  );
  assert.deepEqual(result, { ok: true, processed: 1, sent: 0, retried: 1, dead: 0 });
  for (const args of logs) {
    assert.doesNotMatch(JSON.stringify(args), /leaked-image-send-detail/);
  }
}

// ---------------------------------------------------------------------------
// The retry key is STABLE across separate claims of the identical row (a
// stale-lease reclaim after a worker crash) — never regenerated per attempt.
// ---------------------------------------------------------------------------
{
  let claimCount = 0;
  const seenRetryKeys: string[] = [];
  const db = {
    rpc: async (fn: string) => {
      if (fn === "claim_notification_image_deliveries") {
        claimCount++;
        if (claimCount <= 2) {
          return { data: [makeImageRow("stable", "payment_slip", "booking-stable/order-stable.jpg", "22222222-8888-4888-8888-888888888888")], error: null };
        }
        return { data: [], error: null };
      }
      return { data: true, error: null };
    },
  };
  await runImageDeliveryWorker({
    db,
    sendImage: async (_to, _url, retryKey) => {
      seenRetryKeys.push(retryKey);
      return { ok: true };
    },
    signFaceUrl: async (p) => `https://signed.example/${p}`,
    signSlipUrl: async (p) => `https://signed.example/${p}`,
    groupId: "group",
    now: () => 0,
    batch: 20,
    timeBudgetMs: 50_000,
  });
  assert.deepEqual(seenRetryKeys, [
    "22222222-8888-4888-8888-888888888888",
    "22222222-8888-4888-8888-888888888888",
  ]);
}

// ---------------------------------------------------------------------------
// claim/completion RPC failures surface as a safe typed worker failure —
// never a silent success — and no thrown/db detail ever enters logs. Same
// shape as runDeliveryWorker's own claim/completion failure handling, kept
// entirely on the image RPC pair.
// ---------------------------------------------------------------------------
{
  const { result, logs } = await captureConsoleErrors(() =>
    runImageDeliveryWorker({
      db: { rpc: async () => ({ data: null, error: { message: "leaked-image-claim-detail" } }) },
      sendImage: async () => ({ ok: true }),
      signFaceUrl: async (p) => p,
      signSlipUrl: async (p) => p,
      groupId: "group",
      now: () => 0,
      batch: 20,
      timeBudgetMs: 50_000,
    }),
  );
  assert.deepEqual(result, { ok: false, code: "claim_failed" });
  for (const args of logs) {
    assert.doesNotMatch(JSON.stringify(args), /leaked-image-claim-detail/);
  }
}

console.log("delivery-worker self-check passed");
