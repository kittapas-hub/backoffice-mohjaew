// /pay/[token] — PromptPay payment page with automatic slip verification.
// 'token' is payment_orders.checkout_token (a UUID, non-guessable).
//
// Does not expose customer PII (name, contact number, birth date, topic
// omitted). Shows only non-sensitive booking/payment summary. The slip is
// verified server-side via /api/pay/[token]/slip — no secret and no provider
// detail ever reaches this page.
import Link from "next/link";
import { getPaymentOrderByCheckoutToken } from "@/lib/payments/payment-orders";
import { paymentConfig, slipVerificationConfig } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { SlipUpload } from "./SlipUpload";

export const dynamic = "force-dynamic";

function formatThaiDate(iso: string | null): string {
  if (!iso) return "-";
  try {
    return new Date(iso + "T00:00:00Z").toLocaleDateString("th-TH", {
      weekday: "short",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

function formatThaiDateTime(iso: string | null): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString("th-TH", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Bangkok",
    }) + " น.";
  } catch {
    return iso;
  }
}

export default async function PayPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const order = await getPaymentOrderByCheckoutToken(token);

  if (!order) {
    return (
      <Wrapper>
        <div className="mb-4 text-4xl">🔍</div>
        <h1 className="text-xl font-bold text-gray-700">ไม่พบรายการชำระเงิน</h1>
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

  // Fetch non-PII booking summary (slot date and label only).
  const db = supabaseAdmin();
  const { data: bookingRow } = await db
    .from("bookings")
    .select("status, preferred_time, booking_slots(booking_date)")
    .eq("id", order.booking_id)
    .maybeSingle();

  const slotRow = Array.isArray(bookingRow?.booking_slots)
    ? bookingRow.booking_slots[0]
    : bookingRow?.booking_slots;
  const bookingDate = slotRow?.booking_date ?? null;

  const isExpiredOrClosed =
    order.status === "expired" ||
    order.status === "failed" ||
    bookingRow?.status === "expired" ||
    bookingRow?.status === "cancelled";

  // Payment truth: only the payment order proves money was received.
  // Booking status (confirmed, completed) is about admin actions, not payment.
  const isPaid = order.status === "paid";

  const BOOKING_STATUS_LABEL: Record<string, string> = {
    pending_payment: "รอชำระเงิน",
    booked: "ชำระแล้ว รอทีมงานตรวจข้อมูล",
    confirmed: "ทีมงานยืนยันคิวแล้ว",
    completed: "ให้บริการเสร็จแล้ว",
    expired: "หมดอายุ",
    cancelled: "ยกเลิก",
  };
  const bookingStatusLabel =
    (bookingRow?.status && BOOKING_STATUS_LABEL[bookingRow.status]) ?? "-";

  return (
    <main className="mx-auto min-h-screen max-w-md px-5 py-10">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-rose-100 text-3xl">
          {isPaid ? "✅" : isExpiredOrClosed ? "⏰" : "💳"}
        </div>
        <h1 className="text-2xl font-bold text-rose-700">
          {isPaid
            ? "ชำระเงินแล้ว"
            : isExpiredOrClosed
              ? "รายการหมดอายุ"
              : "ชำระเงิน"}
        </h1>
      </div>

      <div className="mb-5 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <dl className="space-y-3">
          <Row label="เลขอ้างอิง" value={order.id.slice(0, 8).toUpperCase()} />
          <Row
            label="จำนวนเงิน"
            value={`${(order.amount_satang / 100).toLocaleString("th-TH")} บาท`}
          />
          <Row label="วันที่" value={formatThaiDate(bookingDate)} />
          <Row label="รอบเวลา" value={bookingRow?.preferred_time ?? "-"} />
          <Row label="สถานะการจอง" value={bookingStatusLabel} />
          {!isPaid && !isExpiredOrClosed && (
            <Row
              label="หมดอายุ"
              value={formatThaiDateTime(order.expires_at)}
            />
          )}
        </dl>
      </div>

      {isPaid ? (
        <div className="rounded-2xl border border-teal-100 bg-teal-50 p-5 text-center">
          <p className="font-semibold text-teal-800">ชำระเงินสำเร็จแล้ว</p>
          <p className="mt-1 text-sm text-teal-700">
            สถานะคิวของคุณแสดงในหัวข้อ &ldquo;สถานะการจอง&rdquo; ด้านบน
          </p>
        </div>
      ) : isExpiredOrClosed ? (
        <div className="rounded-2xl border border-gray-200 bg-gray-50 p-5 text-center">
          <p className="font-semibold text-gray-700">รายการนี้หมดอายุแล้ว</p>
          <Link
            href="/booking"
            className="mt-4 inline-block text-sm text-rose-600 hover:underline"
          >
            จองคิวใหม่
          </Link>
        </div>
      ) : (
        <PayableSection token={token} />
      )}
    </main>
  );
}

// Payment instructions + slip upload. Server component: reads env config
// only to decide WHAT to render — no secret is passed to the client.
function PayableSection({ token }: { token: string }) {
  const cfg = paymentConfig();
  const hasBankDetails = Boolean(
    cfg.bankName && cfg.accountName && cfg.accountNumber,
  );
  const hasQR = Boolean(cfg.qrPath);
  const qrSrc = cfg.qrPath.startsWith("/") ? cfg.qrPath : `/${cfg.qrPath}`;
  const slipCfg = slipVerificationConfig();
  const autoVerifyReady = Boolean(
    slipCfg.easySlipApiKey && slipCfg.receiverAccounts.length > 0,
  );

  return (
    <>
      {hasBankDetails && (
        <div className="mb-5 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
          <h2 className="mb-4 font-bold">โอนเงินผ่าน PromptPay / บัญชีธนาคาร</h2>
          {hasQR && (
            <div className="mb-5 flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrSrc}
                alt="QR Code สำหรับโอนเงิน"
                width={220}
                height={220}
                className="rounded-xl border border-gray-200"
              />
            </div>
          )}
          <dl className="space-y-3">
            <Row label="ธนาคาร" value={cfg.bankName} />
            <Row label="ชื่อบัญชี" value={cfg.accountName} />
            <Row label="เลขบัญชี" value={cfg.accountNumber} />
          </dl>
        </div>
      )}

      {autoVerifyReady ? (
        <SlipUpload token={token} />
      ) : (
        <div className="rounded-2xl border border-amber-100 bg-amber-50 p-5 text-center">
          <p className="font-semibold text-amber-800">ส่งสลิปให้ทีมงาน</p>
          <p className="mt-2 text-sm text-amber-700">
            โอนแล้วส่งสลิปให้ทีมงานทาง LINE เพื่อยืนยันคิวของคุณ
          </p>
        </div>
      )}
    </>
  );
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-5 py-12 text-center">
      {children}
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-gray-100 pb-2">
      <dt className="shrink-0 text-sm text-gray-500">{label}</dt>
      <dd className="ml-3 text-sm">{value}</dd>
    </div>
  );
}
