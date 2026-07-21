import crypto from "node:crypto";
import type { PushResult } from "../line.ts";

// Phase 1A / Task 3: durable delivery worker core. Delivers ONLY
// recipient_type = 'team' rows for the event types listed below
// (0007_team_notification_outbox.sql) — never customer rows, never any other
// event type. Kept free of Next.js/env imports (only relative imports) and
// dependency-injected (db/sendPush/clock) so it can be exercised directly
// under a plain Node test without a bundler; the route wrapper wires in the
// real Supabase client, pushMessage, and Date.now().
// 'slip_manual_review' (Phase 1 slip automation, 0011_slip_verification.sql):
// a verified payment landed on an ineligible booking and needs a human.
// 'booking_confirmed' (0012_booking_confirmed_notification.sql): a booking
// summary, enqueued exactly once per booking regardless of which of the
// three confirmation paths (admin override / manual review approval /
// EasySlip automatic) reached 'confirmed' first.
export const EVENT_TYPES = ["payment_received", "slip_manual_review", "booking_confirmed"];
export const DEFAULT_BATCH = 20;
export const TIME_BUDGET_MS = 50_000;

export type ClaimedRow = {
  id: string;
  booking_id: string;
  payment_order_id: string | null;
  channel: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  idempotency_key: string;
  attempt_count: number;
  line_retry_key: string;
  // Stable per-row key for the image push, distinct from line_retry_key
  // (0012_booking_confirmed_notification.sql). Never regenerated per
  // attempt — reused on every retry so a crash after LINE accepts the image
  // but before completion commits can never resend a distinct, undeduped
  // image on the next claim.
  image_retry_key: string;
};

// Renders strictly from the fields process_payment_paid_event actually
// writes for a team payment_received row (booking_id, payment_order_id) —
// see 0005_payment_foundation.sql. No amount/name/phone: those are not part
// of the outbox payload and must not be invented here.
export function renderPaymentReceivedMessage(row: ClaimedRow): string {
  return [
    "แจ้งเตือน: ได้รับการชำระเงินแล้ว",
    `Booking: ${row.booking_id}`,
    `Payment order: ${row.payment_order_id ?? "-"}`,
  ].join("\n");
}

// Renders strictly from the fields confirm_slip_payment writes for a team
// slip_manual_review row (booking_id, payment_order_id, reference_code,
// reason, expected_amount_satang, received_amount_satang) — see
// 0011_slip_verification.sql / 0012_booking_confirmed_notification.sql. The
// reason is one of the fixed codes the migration emits (booking_<status> /
// hold_expired / amount_mismatch / ...), never free text. Never includes the
// full provider payload or an unredacted transaction reference — those are
// never written to this payload in the first place.
export function renderSlipManualReviewMessage(row: ClaimedRow, appUrl?: string): string {
  const payload = row.payload;
  const reason = typeof payload?.reason === "string" ? payload.reason : "-";
  const lines = [
    "แจ้งเตือน: สลิปที่ยืนยันแล้วต้องการการตรวจสอบโดยทีมงาน",
    `Booking: ${row.booking_id}`,
    `เลขอ้างอิง: ${field(payload, "reference_code")}`,
    `Payment order: ${row.payment_order_id ?? "-"}`,
    `เหตุผล: ${reason}`,
  ];
  const expected = moneyField(payload, "expected_amount_satang");
  const received = moneyField(payload, "received_amount_satang");
  if (expected) lines.push(`ยอดที่ต้องชำระ: ${expected}`);
  if (received) lines.push(`ยอดที่ได้รับ: ${received}`);
  const url = backofficeUrl(payload, appUrl);
  if (url) lines.push(`Backoffice: ${url}`);
  return lines.join("\n");
}

function field(payload: Record<string, unknown> | null, key: string): string {
  const v = payload?.[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : "-";
}

// Formats a satang integer payload field as a THB display string, or null
// when the field is absent/not a finite number (e.g. the admin-override path,
// which has no payment order and therefore no amount to show).
function moneyField(payload: Record<string, unknown> | null, key: string): string | null {
  const v = payload?.[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return `${(v / 100).toLocaleString("th-TH")} บาท`;
}

// Absolute admin booking-detail link, or null when either the app URL isn't
// configured or the payload has no booking_id — "include the Backoffice URL
// when configured" is best-effort, never a broken/relative link in a LINE
// message.
function backofficeUrl(payload: Record<string, unknown> | null, appUrl: string | undefined): string | null {
  if (!appUrl) return null;
  const bookingId = payload?.booking_id;
  if (typeof bookingId !== "string" || bookingId.length === 0) return null;
  return `${appUrl.replace(/\/+$/, "")}/admin/bookings/${bookingId}`;
}

// Combined wording depends on how payment was established for this
// confirmation — never claim a payment was received on the admin-override
// path, which has no verified payment at all.
const CONFIRMED_HEADLINE: Record<string, string> = {
  easyslip_auto: "ได้รับชำระเงินและยืนยันการจองแล้ว",
  manual_review_approved: "ตรวจสอบการชำระเงินและยืนยันการจองแล้ว",
  admin_override: "ทีมงานยืนยันการจองแล้ว",
};

// Renders strictly from the fields the transition_slot_booking /
// confirm_slip_payment / approve_manual_review_payment 'confirmed' paths
// actually write (0012_booking_confirmed_notification.sql) — no invented
// fields. This is the sole team notification for a successful confirmation:
// the payment-verified paths no longer also enqueue a separate
// payment_received row (see the migration's 2026-07-20 hardening note).
export function renderBookingConfirmedMessage(row: ClaimedRow, appUrl?: string): string {
  const p = row.payload;
  const method = field(p, "confirmation_method");
  const lines = [
    CONFIRMED_HEADLINE[method] ?? "ยืนยันการจองคิวแล้ว",
    `เลขอ้างอิง: ${field(p, "reference_code")}`,
    `ชื่อ: ${field(p, "customer_name")}`,
    `วันเกิด: ${field(p, "birth_date")}`,
    `หัวข้อ: ${field(p, "consultation_topic")}`,
    `โทร: ${field(p, "phone")}`,
    `วันที่จอง: ${field(p, "booking_date")}`,
    `เวลา: ${field(p, "session_time")}`,
    `ลำดับคิว: ${field(p, "queue_number")}`,
  ];
  const expected = moneyField(p, "expected_amount_satang");
  const received = moneyField(p, "received_amount_satang");
  if (expected) lines.push(`ยอดที่ต้องชำระ: ${expected}`);
  if (received) lines.push(`ยอดที่ได้รับ: ${received}`);
  lines.push(`ยืนยันโดย: ${method}`, `อัปเดตล่าสุด: ${field(p, "updated_at")}`);
  const url = backofficeUrl(p, appUrl);
  if (url) lines.push(`Backoffice: ${url}`);
  return lines.join("\n");
}

export function renderMessage(row: ClaimedRow, appUrl?: string): string {
  if (row.event_type === "slip_manual_review") {
    return renderSlipManualReviewMessage(row, appUrl);
  }
  if (row.event_type === "booking_confirmed") {
    return renderBookingConfirmedMessage(row, appUrl);
  }
  return renderPaymentReceivedMessage(row);
}

// slip_storage_path (0013_payment_slip_notification_image.sql): the actual
// uploaded payment-slip image, never the customer's face photo. Never
// present for admin_override (guarded explicitly here too, as defense in
// depth — that path has no verified payment and must never attach or imply
// one, even if a future payload change accidentally carried the field).
function slipStoragePath(row: ClaimedRow): string | null {
  if (row.payload?.confirmation_method === "admin_override") return null;
  const v = row.payload?.slip_storage_path;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export type RpcResult = { data: unknown; error: { message: string } | null };

export type Deps = {
  db: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult> };
  sendPush: (to: string, text: string, retryKey: string) => Promise<PushResult>;
  // Both optional: only rows with a slip_storage_path in their payload
  // (booking_confirmed payment-verified paths, slip_manual_review) ever use
  // these. Omitting them just means no image is attempted — the text
  // summary is unaffected either way.
  sendImage?: (to: string, imageUrl: string, retryKey: string) => Promise<PushResult>;
  signSlipUrl?: (storagePath: string) => Promise<string | null>;
  // Optional: absolute app URL used to build the "Backoffice: ..." link in
  // booking_confirmed/slip_manual_review messages. Omitted (or falsy) means
  // that line is left out of the message entirely — never a broken relative
  // link in a LINE message.
  appUrl?: string;
  groupId: string;
  now: () => number;
  batch: number;
  timeBudgetMs: number;
};

export type DeliveryWorkerResult = { processed: number; sent: number; retried: number; dead: number };

// Only fixed, non-dynamic failure codes ever surface — no error.message, no
// thrown-exception text, no payload/recipient/token content.
export type WorkerFailureCode = "claim_failed" | "completion_failed";
export type WorkerOutcome =
  | ({ ok: true } & DeliveryWorkerResult)
  | { ok: false; code: WorkerFailureCode };

type CompletionOutcome = "sent" | "retry" | "dead";
type CompletionStatus = "completed" | "fence_lost" | "failed";

// Wraps complete_notification_delivery: distinguishes an RPC-level failure
// (error thrown or returned) from a fenced no-op (RPC returned false because
// this worker no longer holds the lease, e.g. a stale-lease reclaim raced
// it) — the latter must never be counted as a completed sent/retried/dead
// outcome.
async function completeDelivery(
  deps: Deps,
  workerId: string,
  rowId: string,
  outcome: CompletionOutcome,
  errorCode?: string,
): Promise<CompletionStatus> {
  let res: RpcResult;
  try {
    res = await deps.db.rpc("complete_notification_delivery", {
      p_id: rowId,
      p_worker_id: workerId,
      p_outcome: outcome,
      ...(errorCode ? { p_error: errorCode } : {}),
    });
  } catch {
    return "failed";
  }
  if (res.error) return "failed";
  if (res.data === true) return "completed";
  return "fence_lost";
}

// Signs and sends the payment-slip image for a confirmed/manual-review
// booking. Swallows every failure (signing error, send error, or a
// retryable/permanent push rejection) behind a single fixed log literal —
// never the storage path, signed URL, or group id — since image delivery is
// best-effort and must never affect the row's retry/dead outcome.
async function sendImageBestEffort(deps: Deps, row: ClaimedRow): Promise<void> {
  if (!deps.signSlipUrl || !deps.sendImage) return;
  const path = slipStoragePath(row);
  if (!path) return;
  try {
    const url = await deps.signSlipUrl(path);
    if (!url) return;
    const result = await deps.sendImage(deps.groupId, url, row.image_retry_key);
    if (!result.ok) console.error("notification_image_send_failed");
  } catch {
    console.error("notification_image_send_failed");
  }
}

export async function runDeliveryWorker(deps: Deps): Promise<WorkerOutcome> {
  const workerId = crypto.randomUUID();
  const startedAt = deps.now();
  const result: DeliveryWorkerResult = { processed: 0, sent: 0, retried: 0, dead: 0 };

  while (deps.now() - startedAt < deps.timeBudgetMs) {
    let claimResult: RpcResult;
    try {
      claimResult = await deps.db.rpc("claim_team_notification_deliveries", {
        p_worker_id: workerId,
        p_batch: deps.batch,
        p_event_types: EVENT_TYPES,
      });
    } catch {
      console.error("notification_claim_failed");
      return { ok: false, code: "claim_failed" };
    }
    if (claimResult.error) {
      console.error("notification_claim_failed");
      return { ok: false, code: "claim_failed" };
    }

    const rows = (claimResult.data ?? []) as ClaimedRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      result.processed++;
      const text = renderMessage(row, deps.appUrl);

      let push: PushResult;
      try {
        push = await deps.sendPush(deps.groupId, text, row.line_retry_key);
      } catch {
        push = { ok: false, retryable: true, error: "push_unexpected_error" };
      }

      const outcome: CompletionOutcome = push.ok ? "sent" : push.retryable ? "retry" : "dead";
      const errorCode = push.ok ? undefined : push.error;

      // Best-effort image, only once the text summary is confirmed sent.
      // Never affects outcome/retry — a missing or failed image must never
      // cause the text summary to be resent.
      if (push.ok) {
        await sendImageBestEffort(deps, row);
      }

      const status = await completeDelivery(deps, workerId, row.id, outcome, errorCode);

      if (status === "failed") {
        console.error("notification_completion_failed");
        return { ok: false, code: "completion_failed" };
      }
      if (status === "fence_lost") {
        console.error("notification_completion_fence_lost");
      } else if (outcome === "sent") {
        result.sent++;
      } else if (outcome === "retry") {
        result.retried++;
      } else {
        result.dead++;
      }

      if (deps.now() - startedAt >= deps.timeBudgetMs) return { ok: true, ...result };
    }
  }

  return { ok: true, ...result };
}
