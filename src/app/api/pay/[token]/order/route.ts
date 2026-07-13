import { NextResponse } from "next/server";
import { paymentAmountSatang, slipVerificationConfig } from "@/lib/env";
import { createSlipPaymentOrder } from "@/lib/payments/payment-orders";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Payment-order creation is intentionally POST-only. Rendering /booking/success
// remains read-only even when React retries or prefetches it.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!UUID_RE.test(token)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const cfg = slipVerificationConfig();
  const amountSatang = paymentAmountSatang();
  const secret = process.env.PAYMENT_ORDER_IDEMPOTENCY_SECRET ?? "";
  if (!cfg.enabled || !cfg.easySlipApiKey || !cfg.receiverProfile || cfg.receiverAccounts.length === 0 ||
      cfg.receiverNames.length === 0 || amountSatang === null || !secret) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const order = await createSlipPaymentOrder(token, amountSatang, cfg.receiverProfile, secret);
  if (!order) return NextResponse.json({ error: "order_unavailable" }, { status: 409 });

  // The checkout token is a fresh database-generated capability; never return
  // booking/order IDs or the deterministic idempotency key to the browser.
  return NextResponse.json({ checkoutToken: order.checkout_token });
}
