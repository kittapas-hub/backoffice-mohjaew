// Server-only wrappers around the slip-verification database objects.
// Confirmation itself is ONE atomic RPC (confirm_slip_payment) — never a
// sequence of application writes. Rejected pre-RPC attempts are recorded
// best-effort for audit; their failure never blocks the customer response.
import { supabaseAdmin } from "@/lib/supabase/admin";
import { slipVerificationEnabled } from "@/lib/env";
import { buildEvidence, redactTxRef } from "./evidence.ts";
import type { NormalizedSlipVerification } from "./types.ts";

export { buildEvidence, redactTxRef };

export type SlipConfirmResult =
  | { result: "ok" | "already_paid"; bookingId: string }
  | { result: "rejected"; reason: string }
  | { result: "manual_review"; reason: string }
  | { result: "error" };

export async function confirmSlipPayment(opts: {
  paymentOrderId: string;
  slip: NormalizedSlipVerification;
  /** Present only after strict server-side receiver-profile matching. */
  receiverProfile: string | null;
}): Promise<SlipConfirmResult> {
  if (!slipVerificationEnabled()) return { result: "error" };
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("confirm_slip_payment", {
    p_payment_order_id: opts.paymentOrderId,
    p_provider: opts.slip.provider,
    p_provider_tx_ref: opts.slip.providerTransactionReference,
    p_transfer_at: opts.slip.transferTimestamp?.toISOString() ?? null,
    p_amount_satang: opts.slip.amountSatang,
    p_currency: opts.slip.currency,
    p_receiver_profile: opts.receiverProfile,
    p_evidence: buildEvidence(opts.slip),
  });

  if (error) {
    console.error("[slip] confirm_slip_payment failed", {
      orderId: opts.paymentOrderId,
      txRef: redactTxRef(opts.slip.providerTransactionReference),
      dbCode: error.code ?? null,
    });
    return { result: "error" };
  }

  const row = data as { result?: string; reason?: string; booking_id?: string };
  if (row?.result === "ok" || row?.result === "already_paid") {
    return { result: row.result, bookingId: String(row.booking_id ?? "") };
  }
  if (row?.result === "rejected") {
    return { result: "rejected", reason: String(row.reason ?? "rejected") };
  }
  if (row?.result === "manual_review") {
    return { result: "manual_review", reason: String(row.reason ?? "manual_review") };
  }
  return { result: "error" };
}

/** Pre-RPC rejection outcomes the server decides (provider/policy failures). */
export type SlipRejectionOutcome =
  | "provider_unverified"
  | "tx_ref_missing"
  | "timestamp_out_of_window"
  | "receiver_mismatch"
  | "invalid_image"
  | "provider_error";

/** Best-effort audit insert for attempts rejected before the confirm RPC. */
export async function recordSlipRejection(opts: {
  paymentOrderId: string;
  bookingId: string;
  provider: string;
  outcome: SlipRejectionOutcome;
  slip?: NormalizedSlipVerification;
}): Promise<void> {
  const db = supabaseAdmin();
  const { error } = await db.from("payment_slip_verifications").insert({
    payment_order_id: opts.paymentOrderId,
    booking_id: opts.bookingId,
    provider: opts.provider,
    provider_tx_ref: opts.slip?.providerTransactionReference ?? null,
    transfer_at: opts.slip?.transferTimestamp?.toISOString() ?? null,
    amount_satang: opts.slip?.amountSatang ?? null,
    outcome: opts.outcome,
    evidence: opts.slip ? buildEvidence(opts.slip) : null,
  });
  if (error) {
    console.error("[slip] audit insert failed", {
      orderId: opts.paymentOrderId,
      outcome: opts.outcome,
    });
  }
}

/** Attempts recorded for an order — the per-order abuse ceiling. */
export async function countSlipAttempts(paymentOrderId: string): Promise<number> {
  const db = supabaseAdmin();
  const { count, error } = await db
    .from("payment_slip_verifications")
    .select("id", { count: "exact", head: true })
    .eq("payment_order_id", paymentOrderId);
  if (error) {
    console.error("[slip] attempt count failed", { orderId: paymentOrderId });
    return -1;
  }
  return count ?? 0;
}
