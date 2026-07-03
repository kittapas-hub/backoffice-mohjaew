import crypto from "node:crypto";
import type { PushResult } from "../line.ts";

// Phase 1A / Task 3: durable delivery worker core. Delivers ONLY
// recipient_type = 'team', event_type = 'payment_received' rows
// (0007_team_notification_outbox.sql) — never customer rows, never any other
// event type. Kept free of Next.js/env imports (only relative imports) and
// dependency-injected (db/sendPush/clock) so it can be exercised directly
// under a plain Node test without a bundler; the route wrapper wires in the
// real Supabase client, pushMessage, and Date.now().
export const EVENT_TYPES = ["payment_received"];
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

export type RpcResult = { data: unknown; error: { message: string } | null };

export type Deps = {
  db: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult> };
  sendPush: (to: string, text: string) => Promise<PushResult>;
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
      const text = renderPaymentReceivedMessage(row);

      let push: PushResult;
      try {
        push = await deps.sendPush(deps.groupId, text);
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
