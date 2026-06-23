// Server-only: process paid webhook events and expire stale payment orders.
// No public endpoints. No "mark paid" button. No real provider calls.
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { PaidEventResult } from "./types.ts";

/** Atomically process a provider paid event.
 *  Inserts the webhook event idempotently, validates amount, and on success
 *  transitions the booking from pending_payment → booked and inserts
 *  notification outbox entries. Does NOT send any messages.
 *
 *  Called from a future provider webhook handler AFTER signature verification. */
export async function processPaymentPaidEvent(opts: {
  provider: string;
  providerEventId: string;
  paymentOrderId: string;
  eventType: string;
  payload: Record<string, unknown>;
  amountReceivedSatang: number;
  providerPaidAt?: Date;
}): Promise<{ ok: true; data: PaidEventResult } | { ok: false; error: string }> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("process_payment_paid_event", {
    p_provider: opts.provider,
    p_provider_event_id: opts.providerEventId,
    p_payment_order_id: opts.paymentOrderId,
    p_event_type: opts.eventType,
    p_payload: opts.payload,
    p_amount_received_satang: opts.amountReceivedSatang,
    p_provider_paid_at: opts.providerPaidAt?.toISOString() ?? null,
  });

  if (error) {
    console.error("process_payment_paid_event failed", error);
    return { ok: false, error: error.message ?? "server_error" };
  }

  return { ok: true, data: data as PaidEventResult };
}

/** Expire payment orders past their expiry and transition the linked booking
 *  from pending_payment → expired. Safe to call from the existing cron route.
 *  Never expires a booked/confirmed booking. */
export async function expireDuePaymentOrders(
  batchSize = 50,
): Promise<{ ok: true; expired: number } | { ok: false; error: string }> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("expire_due_payment_orders", {
    p_batch_size: batchSize,
  });

  if (error) {
    console.error("expire_due_payment_orders failed", error);
    return { ok: false, error: error.message ?? "server_error" };
  }

  return { ok: true, expired: (data as number) ?? 0 };
}
