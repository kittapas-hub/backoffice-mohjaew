import Link from "next/link";
import { getBookingByToken, type BookingTokenData } from "@/lib/booking-core";
import { paymentConfig } from "@/lib/env";
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
    />
  );
}
