// Server-only: create and query payment orders via Supabase service-role client.
// No HTTP calls to external providers. No secrets beyond the service-role key.
import { supabaseAdmin } from "@/lib/supabase/admin";
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
