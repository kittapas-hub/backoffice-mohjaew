// Server-only: create and query payment orders via Supabase service-role client.
// No HTTP calls to external providers. No secrets beyond the service-role key.
import { supabaseAdmin } from "@/lib/supabase/admin";
import crypto from "node:crypto";
import type { PaymentOrder, CreateOrderError } from "./types.ts";

const KNOWN_CREATE_ERRORS: CreateOrderError[] = [
  "booking_not_found",
  "booking_not_pending_payment",
  "booking_hold_expired",
  "active_order_exists",
];

/** Create (or idempotently return) a payment order for a pending_payment booking.
 *  Calls the create_payment_order DB RPC which enforces all invariants. */
export async function createPaymentOrder(opts: {
  bookingId: string;
  idempotencyKey: string;
  provider: string;
  amountSatang: number;
  currency?: string;
  expiresAt?: Date;
}): Promise<
  { ok: true; order: PaymentOrder } | { ok: false; error: CreateOrderError }
> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("create_payment_order", {
    p_booking_id: opts.bookingId,
    p_idempotency_key: opts.idempotencyKey,
    p_provider: opts.provider,
    p_amount_satang: opts.amountSatang,
    p_currency: opts.currency ?? "THB",
    p_expires_at: opts.expiresAt?.toISOString() ?? null,
  });

  if (error) {
    const matched = KNOWN_CREATE_ERRORS.find((e) => error.message?.includes(e));
    if (matched) return { ok: false, error: matched };
    console.error("create_payment_order failed", error);
    return { ok: false, error: "server_error" };
  }

  const order = (Array.isArray(data) ? data[0] : data) as PaymentOrder;
  return { ok: true, order };
}

// Provider tag for orders paid by manual PromptPay transfer + slip
// verification (Phase 1). Distinct from the verification provider name
// ('easyslip') recorded on payment_slip_verifications rows.
export const SLIP_ORDER_PROVIDER = "promptpay_slip";

/** Get (or idempotently create) the slip-payment order for a booking.
 *  Deterministic idempotency key ⇒ any number of callers converge on one
 *  order. Returns null when the booking is not eligible (RPC enforces
 *  pending_payment + live hold) or the amount is not configured.
 *  Trusted amount comes from server env — never from the browser. */
export function slipOrderIdempotencyKey(bookingId: string, secret: string): string {
  return `slip:v1:${crypto.createHmac("sha256", secret).update(bookingId).digest("hex")}`;
}

/** Explicit POST-only creation for the Phase 1 PromptPay slip flow. The RPC
 * rejects a previously-created order when provider/currency/amount/profile
 * differ, rather than accidentally reusing it. */
export async function createSlipPaymentOrder(
  bookingId: string,
  amountSatang: number,
  receiverProfile: string,
  idempotencySecret: string,
): Promise<PaymentOrder | null> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("create_slip_payment_order", {
    p_booking_id: bookingId,
    p_idempotency_key: slipOrderIdempotencyKey(bookingId, idempotencySecret),
    p_amount_satang: amountSatang,
    p_receiver_profile: receiverProfile,
  });
  if (error || !data) {
    if (error) console.error("create_slip_payment_order failed", { code: error.code });
    return null;
  }
  return (Array.isArray(data) ? data[0] : data) as PaymentOrder;
}

/** Look up a payment order by its public checkout_token (used by /pay/[token]). */
export async function getPaymentOrderByCheckoutToken(
  checkoutToken: string,
): Promise<PaymentOrder | null> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("payment_orders")
    .select(
      "id, booking_id, provider, provider_order_id, checkout_token, " +
        "idempotency_key, amount_satang, currency, status, expires_at, " +
        "paid_at, amount_received_satang, provider_paid_at, " +
        "failure_code, failure_message, created_at, updated_at",
    )
    .eq("checkout_token", checkoutToken)
    .maybeSingle();

  if (error || !data) return null;
  return data as unknown as PaymentOrder;
}

/** All payment orders for a booking, newest first. Used by admin view. */
export async function getPaymentOrdersForBooking(
  bookingId: string,
): Promise<PaymentOrder[]> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("payment_orders")
    .select(
      "id, booking_id, provider, provider_order_id, checkout_token, " +
        "idempotency_key, amount_satang, currency, status, expires_at, " +
        "paid_at, amount_received_satang, provider_paid_at, provider_payload, " +
        "failure_code, failure_message, created_at, updated_at",
    )
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getPaymentOrdersForBooking failed", error);
    return [];
  }
  return (data ?? []) as unknown as PaymentOrder[];
}
