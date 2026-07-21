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
// Image attachment (face/slip) is not part of this text at all — see
// runImageDeliveryWorker below (0013_payment_slip_notification_image.sql).
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

export type RpcResult = { data: unknown; error: { message: string } | null };

export type Deps = {
  db: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult> };
  sendPush: (to: string, text: string, retryKey: string) => Promise<PushResult>;
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

// Sends the text summary only. Image delivery (face/slip) is entirely
// separate — see runImageDeliveryWorker below — so an image failure can
// never resend this text, and this text's own failure/retry never touches
// any image row.
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

// ===========================================================================
// Image delivery worker (0013_payment_slip_notification_image.sql).
//
// Entirely independent of runDeliveryWorker above: claims from
// notification_image_deliveries via claim_notification_image_deliveries,
// which has its own status/lease/backoff lifecycle unrelated to the parent
// notification_deliveries row (which may already be 'sent'). One row per
// (notification, image kind) — 'face' or 'payment_slip' — each with its own
// stable line_retry_key, so a face failure can never block or resend the
// slip and vice versa, and a future cron tick retries only whichever image
// is still outstanding.
// ===========================================================================

export type ImageKind = "face" | "payment_slip";

export type ImageClaimedRow = {
  id: string;
  notification_delivery_id: string;
  image_kind: ImageKind;
  storage_path: string;
  line_retry_key: string;
  attempt_count: number;
};

export type ImageDeps = {
  db: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult> };
  sendImage: (to: string, imageUrl: string, retryKey: string) => Promise<PushResult>;
  signFaceUrl: (storagePath: string) => Promise<string | null>;
  signSlipUrl: (storagePath: string) => Promise<string | null>;
  groupId: string;
  now: () => number;
  batch: number;
  timeBudgetMs: number;
};

export type ImageDeliveryWorkerResult = { processed: number; sent: number; retried: number; dead: number };
export type ImageWorkerFailureCode = "claim_failed" | "completion_failed";
export type ImageWorkerOutcome =
  | ({ ok: true } & ImageDeliveryWorkerResult)
  | { ok: false; code: ImageWorkerFailureCode };

async function completeImageDelivery(
  deps: ImageDeps,
  workerId: string,
  rowId: string,
  outcome: CompletionOutcome,
  errorCode?: string,
): Promise<CompletionStatus> {
  let res: RpcResult;
  try {
    res = await deps.db.rpc("complete_notification_image_delivery", {
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

export async function runImageDeliveryWorker(deps: ImageDeps): Promise<ImageWorkerOutcome> {
  const workerId = crypto.randomUUID();
  const startedAt = deps.now();
  const result: ImageDeliveryWorkerResult = { processed: 0, sent: 0, retried: 0, dead: 0 };

  while (deps.now() - startedAt < deps.timeBudgetMs) {
    let claimResult: RpcResult;
    try {
      claimResult = await deps.db.rpc("claim_notification_image_deliveries", {
        p_worker_id: workerId,
        p_batch: deps.batch,
      });
    } catch {
      console.error("notification_image_claim_failed");
      return { ok: false, code: "claim_failed" };
    }
    if (claimResult.error) {
      console.error("notification_image_claim_failed");
      return { ok: false, code: "claim_failed" };
    }

    const rows = (claimResult.data ?? []) as ImageClaimedRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      result.processed++;
      const sign = row.image_kind === "face" ? deps.signFaceUrl : deps.signSlipUrl;

      let outcome: CompletionOutcome;
      let errorCode: string | undefined;
      try {
        const url = await sign(row.storage_path);
        if (!url) {
          outcome = "retry";
          errorCode = "sign_failed";
        } else {
          const push = await deps.sendImage(deps.groupId, url, row.line_retry_key);
          if (push.ok) {
            outcome = "sent";
            errorCode = undefined;
          } else {
            outcome = push.retryable ? "retry" : "dead";
            errorCode = push.error;
          }
        }
      } catch {
        outcome = "retry";
        errorCode = "image_send_unexpected_error";
      }

      const status = await completeImageDelivery(deps, workerId, row.id, outcome, errorCode);

      if (status === "failed") {
        console.error("notification_image_completion_failed");
        return { ok: false, code: "completion_failed" };
      }
      if (status === "fence_lost") {
        console.error("notification_image_completion_fence_lost");
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
