import Link from "next/link";
import { getBookingByToken, type BookingTokenData } from "@/lib/booking-core";
import { paymentConfig } from "@/lib/env";
import { CopyButton } from "./CopyButton";
import { HoldCountdown } from "./HoldCountdown";

export const dynamic = "force-dynamic";

// Status states other than pending_payment.
const STATUS_INFO: Record<
  string,
  { icon: string; title: string; body: string }
> = {
  booked: {
    icon: "✅",
    title: "ชำระเงินแล้ว รอยืนยัน",
    body: "ทีมงานจะตรวจสอบและยืนยันคิวของคุณเร็วๆ นี้",
  },
  confirmed: {
    icon: "✅",
    title: "ยืนยันการจองแล้ว",
    body: "ทีมงานได้ยืนยันคิวของคุณแล้ว",
  },
  cancelled: {
    icon: "❌",
    title: "คิวถูกยกเลิกแล้ว",
    body: "กรุณาจองคิวใหม่หากต้องการนัดหมาย",
  },
  expired: {
    icon: "⏰",
    title: "คิวหมดอายุแล้ว",
    body: "ไม่ได้ชำระภายในเวลาที่กำหนด กรุณาจองคิวใหม่",
  },
  completed: {
    icon: "⭐",
    title: "เสร็จสิ้น",
    body: "ขอบคุณที่ใช้บริการหมอแจว",
  },
};

function formatThaiDate(iso: string | null): string {
  if (!iso) return "-";
  try {
    // Append T00:00:00Z so the date is interpreted as UTC, not local time.
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

function formatThaiDeadline(iso: string | null): string {
  if (!iso) return "";
  try {
    return (
      new Date(iso).toLocaleString("th-TH", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Bangkok",
      }) + " น."
    );
  } catch {
    return "";
  }
}

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
  if (!booking) {
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

  // ── Non-pending_payment status ─────────────────────────────────────────────
  if (booking.status !== "pending_payment") {
    const info = STATUS_INFO[booking.status] ?? {
      icon: "ℹ️",
      title: "สถานะการจอง",
      body: "กรุณาติดต่อทีมงาน",
    };
    return (
      <Wrapper>
        <IconCircle>{info.icon}</IconCircle>
        <h1 className="text-xl font-bold text-gray-700">{info.title}</h1>
        <p className="mt-2 text-sm text-gray-500">{info.body}</p>
        <dl className="mt-5 w-full space-y-3 rounded-2xl border border-gray-100 bg-white p-4 text-left shadow-sm">
          <Row label="เลขอ้างอิง" value={booking.reference} strong />
          <Row label="วันที่" value={formatThaiDate(booking.bookingDate)} />
          <Row label="รอบเวลา" value={booking.slotLabel ?? "-"} />
        </dl>
        <Link
          href="/booking"
          className="mt-4 text-sm text-rose-600 hover:underline"
        >
          จองคิวใหม่
        </Link>
      </Wrapper>
    );
  }

  // ── pending_payment: show full payment instructions ────────────────────────
  const cfg = paymentConfig();
  const hasPaymentConfig =
    cfg.amount && cfg.bankName && cfg.accountName && cfg.accountNumber;
  const hasQR = Boolean(cfg.qrPath);
  const qrSrc = cfg.qrPath.startsWith("/") ? cfg.qrPath : `/${cfg.qrPath}`;
  const deadline = formatThaiDeadline(booking.holdExpiresAt);

  return (
    <main className="mx-auto min-h-screen max-w-md px-5 py-10">
      {/* Header */}
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-rose-100 text-4xl">
          ✓
        </div>
        <h1 className="text-2xl font-bold text-rose-700">จองคิวสำเร็จ</h1>
        <p className="mt-1 text-sm text-gray-500">รอชำระเงินเพื่อยืนยันคิว</p>
      </div>

      {/* Booking summary */}
      <div className="mb-5 rounded-2xl border border-rose-100 bg-white p-5 shadow-sm">
        <dl className="space-y-3">
          <Row label="เลขอ้างอิง" value={booking.reference} strong />
          <Row label="วันที่" value={formatThaiDate(booking.bookingDate)} />
          <Row label="รอบเวลา" value={booking.slotLabel ?? "-"} />
          <Row
            label="ลำดับคิวในรอบ"
            value={booking.queueNumber ? `#${booking.queueNumber}` : "-"}
          />
        </dl>

        {booking.holdExpiresAt && deadline && (
          <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            <p>
              ถือคิวถึง <span className="font-semibold">{deadline}</span>
            </p>
            <p className="mt-0.5 text-xs">
              เวลาที่เหลือ: <HoldCountdown expiresAt={booking.holdExpiresAt} />
            </p>
          </div>
        )}
      </div>

      {/* Payment section */}
      <div className="mb-5 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <h2 className="mb-4 font-bold">ขั้นตอนชำระเงิน</h2>

        {hasPaymentConfig ? (
          <>
            <p className="mb-4 text-center text-3xl font-bold text-rose-700">
              {Number(cfg.amount).toLocaleString("th-TH")}{" "}
              <span className="text-lg font-medium">บาท</span>
            </p>

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

            <dl className="mb-5 space-y-3">
              <Row label="ธนาคาร" value={cfg.bankName} />
              <Row label="ชื่อบัญชี" value={cfg.accountName} />
              <Row
                label="เลขบัญชี"
                value={cfg.accountNumber}
                action={
                  <CopyButton text={cfg.accountNumber} label="คัดลอก" />
                }
              />
              <Row
                label="เลขอ้างอิง"
                value={booking.reference}
                action={
                  <CopyButton text={booking.reference} label="คัดลอก" />
                }
              />
            </dl>

            <p className="mb-5 rounded-lg bg-blue-50 p-3 text-xs text-blue-800">
              กรุณาส่งสลิปพร้อมเลขอ้างอิงการจอง เพื่อให้ทีมงานยืนยันคิว
            </p>

            {cfg.lineOaUrl && (
              <a
                href={cfg.lineOaUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-green-500 px-4 py-3 text-base font-semibold text-white shadow-sm hover:bg-green-600 active:bg-green-700"
              >
                <span>💬</span>
                ส่งสลิปผ่าน LINE
              </a>
            )}
          </>
        ) : (
          <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-700">
            ทีมงานจะติดต่อเพื่อแจ้งรายละเอียดการชำระเงิน
          </p>
        )}
      </div>

      <Link
        href="/booking"
        className="block text-center text-sm text-rose-600 hover:underline"
      >
        จองคิวเพิ่ม
      </Link>
    </main>
  );
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-5 py-12 text-center">
      {children}
    </main>
  );
}

function IconCircle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 text-3xl">
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  action,
}: {
  label: string;
  value: string;
  strong?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-gray-100 pb-2">
      <dt className="shrink-0 text-sm text-gray-500">{label}</dt>
      <dd className="ml-3 flex items-center gap-2">
        <span
          className={
            strong ? "text-lg font-bold tracking-wide" : "text-sm text-right"
          }
        >
          {value}
        </span>
        {action}
      </dd>
    </div>
  );
}
