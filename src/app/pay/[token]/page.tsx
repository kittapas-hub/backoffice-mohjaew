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
import { PaymentDeadlineGate } from "./PaymentDeadlineGate";
import {
  isPaymentDeadlinePassed,
  isSlipUploadReady,
  resolvePaymentDeadline,
} from "./pay-page-gate";

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
      <Centered
        tone="neutral"
        icon="🔍"
        title="ไม่พบรายการชำระเงิน"
        subtitle="ลิงก์อาจหมดอายุหรือไม่ถูกต้อง"
      >
        <Link href="/booking" className="checkout-btn" style={{ marginTop: 20 }}>
          จองคิวใหม่
        </Link>
      </Centered>
    );
  }

  // Fetch non-PII booking summary (slot date and label only).
  const db = supabaseAdmin();
  const { data: bookingRow } = await db
    .from("bookings")
    .select("status, preferred_time, hold_expires_at, booking_slots(booking_date)")
    .eq("id", order.booking_id)
    .maybeSingle();

  const slotRow = Array.isArray(bookingRow?.booking_slots)
    ? bookingRow.booking_slots[0]
    : bookingRow?.booking_slots;
  const bookingDate = slotRow?.booking_date ?? null;

  // Payment order is under team review (e.g. late-but-verified transfer, or a
  // provider result that needs a human). Distinct from paid/expired: the
  // customer should NOT be shown the upload form again (it would only 409).
  const isUnderReview = order.status === "manual_review";

  const paymentDeadline = resolvePaymentDeadline(
    order.expires_at,
    bookingRow?.hold_expires_at,
  );

  const isExpiredOrClosed =
    order.status === "expired" ||
    order.status === "failed" ||
    order.status === "refunded" ||
    bookingRow?.status === "expired" ||
    bookingRow?.status === "cancelled" ||
    bookingRow?.status !== "pending_payment" ||
    isPaymentDeadlinePassed(paymentDeadline);

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
    isUnderReview
      ? "รอตรวจสอบการชำระเงิน"
      : isPaid && bookingRow?.status === "pending_payment"
        ? "ชำระแล้ว รอทีมงานยืนยันคิว"
        : ["expired", "failed", "refunded"].includes(order.status) &&
            bookingRow?.status === "pending_payment"
          ? "รายการชำระเงินปิดแล้ว"
          : (bookingRow?.status && BOOKING_STATUS_LABEL[bookingRow.status]) ?? "-";
  const bookingConfirmed =
    bookingRow?.status === "confirmed" || bookingRow?.status === "completed";
  const bookingClosedAfterPayment =
    bookingRow?.status === "cancelled" || bookingRow?.status === "expired";
  const paidSubtitle = bookingClosedAfterPayment
    ? "ระบบได้รับการชำระเงินแล้ว แต่รายการจองสิ้นสุดแล้ว กรุณาติดต่อทีมงาน"
    : bookingConfirmed
      ? "คิวของคุณได้รับการยืนยันแล้ว"
      : "ระบบได้รับการชำระเงินแล้ว ทีมงานกำลังตรวจสอบและยืนยันคิวของคุณ";

  const summaryCard = (
    <div className="checkout-card checkout-summary">
      <h2 className="checkout-card-title">สรุปการชำระเงิน</h2>
      <dl className="checkout-rows">
        <Row label="เลขอ้างอิง" value={order.booking_id.slice(0, 8).toUpperCase()} />
        <Row
          label="จำนวนเงิน"
          value={`${(order.amount_satang / 100).toLocaleString("th-TH")} บาท`}
          strong
        />
        <Row label="วันที่" value={formatThaiDate(bookingDate)} />
        <Row label="รอบเวลา" value={bookingRow?.preferred_time ?? "-"} />
        <Row label="สถานะการจอง" value={bookingStatusLabel} />
        {!isPaid && !isExpiredOrClosed && !isUnderReview && (
          <Row label="หมดอายุ" value={formatThaiDateTime(order.expires_at)} />
        )}
      </dl>
    </div>
  );

  // ── Paid ───────────────────────────────────────────────────────────────
  if (isPaid) {
    return (
      <Centered
        tone="success"
        icon="✅"
        title="ชำระเงินแล้ว"
        subtitle={paidSubtitle}
      >
        {summaryCard}
        <div
          className="checkout-alert"
          data-tone={bookingClosedAfterPayment ? "warn" : "success"}
          style={{ marginTop: 16 }}
        >
          <p className="checkout-alert-title">ชำระเงินสำเร็จแล้ว</p>
          <p className="checkout-alert-body">
            {bookingClosedAfterPayment
              ? "กรุณาติดต่อทีมงานเพื่อตรวจสอบสถานะการจองและการชำระเงิน"
              : "สถานะคิวของคุณแสดงในหัวข้อ “สถานะการจอง” ด้านบน"}
          </p>
        </div>
      </Centered>
    );
  }

  // ── Under team review ────────────────────────────────────────────────────
  if (isUnderReview) {
    return (
      <Centered
        tone="review"
        icon="🕓"
        title="อยู่ระหว่างการตรวจสอบ"
        subtitle="ระบบได้รับสลิปของคุณแล้ว ทีมงานกำลังตรวจสอบการชำระเงินเพิ่มเติม"
      >
        {summaryCard}
        <div className="checkout-alert" data-tone="review" style={{ marginTop: 16 }}>
          <p className="checkout-alert-title">ทีมงานกำลังตรวจสอบ</p>
          <p className="checkout-alert-body">
            ไม่ต้องโอนเงินหรืออัปโหลดสลิปซ้ำ หากต้องการสอบถามเพิ่มเติม กรุณาติดต่อทีมงานทาง LINE พร้อมเลขอ้างอิงด้านบน
          </p>
        </div>
      </Centered>
    );
  }

  // ── Expired / closed ─────────────────────────────────────────────────────
  if (isExpiredOrClosed) {
    return (
      <Centered tone="neutral" icon="⏰" title="รายการหมดอายุ">
        {summaryCard}
        <div className="checkout-alert" data-tone="neutral" style={{ marginTop: 16 }}>
          <p className="checkout-alert-title">รายการนี้หมดอายุแล้ว</p>
          <p className="checkout-alert-body">
            กรุณาอย่าโอนเงินหรืออัปโหลดสลิปสำหรับรายการนี้
          </p>
          <Link href="/booking" className="checkout-link" style={{ marginTop: 8 }}>
            จองคิวใหม่
          </Link>
        </div>
      </Centered>
    );
  }

  // ── Payable: summary + payment action, one coherent checkout ─────────────
  return (
    <PaymentDeadlineGate deadline={paymentDeadline!}>
      <main className="checkout-page">
        <div className="checkout-shell checkout-shell-wide">
          <div className="checkout-hero">
            <div className="checkout-badge">💳</div>
            <h1 className="checkout-title">ชำระเงิน</h1>
            <p className="checkout-subtitle">
              โอนเงินแล้วอัปโหลดสลิปเพื่อยืนยันคิวของคุณ
            </p>
          </div>

          <div className="checkout-grid" data-cols="2">
            <div className="checkout-summary-col">{summaryCard}</div>
            <div>
              <PayableSection token={token} />
            </div>
          </div>
        </div>
      </main>
    </PaymentDeadlineGate>
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
  const autoVerifyReady = isSlipUploadReady(slipCfg);

  return (
    <div className="checkout-stack">
      {hasBankDetails && (
        <div className="checkout-card">
          <h2 className="checkout-card-title">โอนเงินผ่าน PromptPay / บัญชีธนาคาร</h2>
          {hasQR && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={qrSrc}
              alt="QR Code สำหรับโอนเงิน"
              width={220}
              height={220}
              className="checkout-qr"
            />
          )}
          <dl className="checkout-rows">
            <Row label="ธนาคาร" value={cfg.bankName} />
            <Row label="ชื่อบัญชี" value={cfg.accountName} />
            <Row label="เลขบัญชี" value={cfg.accountNumber} />
          </dl>
        </div>
      )}

      {autoVerifyReady ? (
        <SlipUpload token={token} />
      ) : (
        <div className="checkout-alert" data-tone="warn">
          <p className="checkout-alert-title">ส่งสลิปให้ทีมงาน</p>
          <p className="checkout-alert-body">
            โอนแล้วส่งสลิปให้ทีมงานทาง LINE เพื่อยืนยันคิวของคุณ
          </p>
        </div>
      )}
    </div>
  );
}

// Centered single-column layout for terminal / message states, matching the
// success page's terminal card so the two pages read as one journey.
function Centered({
  tone,
  icon,
  title,
  subtitle,
  children,
}: {
  tone?: "success" | "neutral" | "warn" | "review";
  icon: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="checkout-page">
      <div className="checkout-shell" style={{ maxWidth: 460 }}>
        <div className="checkout-hero">
          <div className="checkout-badge" data-tone={tone}>
            {icon}
          </div>
          <h1 className="checkout-title">{title}</h1>
          {subtitle && <p className="checkout-subtitle">{subtitle}</p>}
        </div>
        {children}
      </div>
    </main>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="checkout-row">
      <dt className="checkout-row-label">{label}</dt>
      <dd className="checkout-row-value" data-strong={strong ? "true" : undefined}>
        <span>{value}</span>
      </dd>
    </div>
  );
}
