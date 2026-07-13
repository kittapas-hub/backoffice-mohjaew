import Link from "next/link";
import { getBookingByToken, type BookingTokenData } from "@/lib/booking-core";
import { getOrCreateSlipPaymentOrder } from "@/lib/payments/payment-orders";
import { paymentConfig, paymentAmountSatang, slipVerificationConfig } from "@/lib/env";
import { BookingStatusPanel } from "./BookingStatusPanel";
import { buildLineHref, buildLinePrefill } from "./helpers";
import { Wrapper, IconCircle, formatThaiDeadline } from "./ui";

export const dynamic = "force-dynamic";

export default async function BookingSuccess({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  const booking: BookingTokenData | null = token
    ? await getBookingByToken(token)
    : null;

  // ── Token missing / invalid / booking not found ───────────────────────────
  if (!booking || !token) {
    return (
      <Wrapper>
        <IconCircle>🔍</IconCircle>
        <h1 className="text-xl font-bold text-gray-700">ไม่พบข้อมูลการจอง</h1>
        <p className="mt-2 text-sm text-gray-500">
          ลิงก์อาจหมดอายุหรือไม่ถูกต้อง
        </p>
        <Link
          href="/booking"
          className="mt-6 inline-block rounded-xl bg-rose-600 px-6 py-2.5 text-sm font-semibold text-white"
        >
          จองคิวใหม่
        </Link>
      </Wrapper>
    );
  }

  // ── Found: render via the client panel, which polls for status changes
  // while pending_payment and swaps to the confirmed/expired/cancelled view
  // without a manual refresh. ────────────────────────────────────────────────
  const cfg = paymentConfig();
  const hasPaymentConfig = Boolean(
    cfg.amount && cfg.bankName && cfg.accountName && cfg.accountNumber,
  );
  const hasQR = Boolean(cfg.qrPath);
  const qrSrc = cfg.qrPath.startsWith("/") ? cfg.qrPath : `/${cfg.qrPath}`;
  const deadline = formatThaiDeadline(booking.holdExpiresAt);
  const linePrefillText = buildLinePrefill({ reference: booking.reference });
  const lineHref = buildLineHref(cfg.lineOaUrl, linePrefillText);

  // Automatic slip verification (Phase 1): make sure the booking has a
  // payment order and surface its /pay link. Idempotent get-or-create (the
  // create_payment_order RPC enforces pending_payment + live hold), so a
  // page refresh or concurrent render converges on the same order. Only
  // attempted when everything needed for auto-verification is configured;
  // otherwise the pre-Phase-1 manual LINE flow renders unchanged.
  let payUrl: string | null = null;
  const amountSatang = paymentAmountSatang();
  const slipCfg = slipVerificationConfig();
  const holdLive = Boolean(
    booking.holdExpiresAt &&
      new Date(booking.holdExpiresAt).getTime() > Date.now(),
  );
  if (
    booking.status === "pending_payment" &&
    holdLive &&
    amountSatang !== null &&
    slipCfg.easySlipApiKey &&
    slipCfg.receiverAccounts.length > 0
  ) {
    const order = await getOrCreateSlipPaymentOrder(token, amountSatang);
    if (order) payUrl = `/pay/${order.checkout_token}`;
  }

  return (
    <BookingStatusPanel
      token={token}
      initialStatus={booking.status}
      reference={booking.reference}
      bookingDate={booking.bookingDate}
      slotLabel={booking.slotLabel}
      queueNumber={booking.queueNumber}
      holdExpiresAt={booking.holdExpiresAt}
      deadline={deadline}
      hasPaymentConfig={hasPaymentConfig}
      hasQR={hasQR}
      qrSrc={qrSrc}
      amount={cfg.amount}
      bankName={cfg.bankName}
      accountName={cfg.accountName}
      accountNumber={cfg.accountNumber}
      lineHref={lineHref}
      payUrl={payUrl}
    />
  );
}
