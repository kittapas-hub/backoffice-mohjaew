import { NextResponse } from "next/server";
import { paymentAmountSatang, promptPayQrTarget, slipVerificationConfig } from "@/lib/env";
import { createSlipPaymentOrder } from "@/lib/payments/payment-orders";
import { generateEasySlipPromptPayQr } from "@/lib/payments/easyslip-qr";

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
  const qrTarget = promptPayQrTarget();
  const secret = process.env.PAYMENT_ORDER_IDEMPOTENCY_SECRET ?? "";
  if (!cfg.enabled || !cfg.easySlipApiKey || !cfg.receiverProfile || cfg.receiverAccounts.length === 0 ||
      cfg.receiverNames.length === 0 || amountSatang === null || !qrTarget || !secret) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const order = await createSlipPaymentOrder(token, amountSatang, cfg.receiverProfile, secret);
  if (!order) return NextResponse.json({ error: "order_unavailable" }, { status: 409 });

  const qr = await generateEasySlipPromptPayQr({
    apiKey: cfg.easySlipApiKey,
    amountSatang: order.amount_satang,
    target: qrTarget,
  });
  if (!qr) {
    console.error("[payment-order] EasySlip dynamic QR generation failed");
    return NextResponse.json({ error: "qr_unavailable" }, { status: 503 });
  }

  // The QR image is safe to reveal only after the durable order exists. The
  // underlying PromptPay identifier and provider API key never leave the server.
  return NextResponse.json(
    { checkoutToken: order.checkout_token, qrDataUrl: qr.dataUrl },
    { headers: { "Cache-Control": "no-store" } },
  );
}
