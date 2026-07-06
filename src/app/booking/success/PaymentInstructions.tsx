"use client";

import { useEffect, useState } from "react";
import { CopyButton } from "./CopyButton";
import { LineCta } from "./LineCta";

// Payment Hold Safety (client-side half): once the hold deadline has passed,
// the customer must never see QR/account/reference/copy/LINE-CTA — those
// invite a transfer the server will now refuse to confirm (see
// transition_slot_booking's hold_expired guard). This is a purely local,
// client-clock-only presentational gate: it never talks to the server and
// never changes booking.status. The page itself is a server component
// (force-dynamic) that re-fetches booking.status fresh on every load, so the
// real, authoritative expiry/confirm/cancel state is already decided before
// this component ever mounts — this only prevents a *stale-but-not-yet-
// reloaded* page from continuing to invite a transfer after the deadline.
export function PaymentInstructions({
  holdExpiresAt,
  hasPaymentConfig,
  hasQR,
  qrSrc,
  amount,
  bankName,
  accountName,
  accountNumber,
  reference,
  lineHref,
}: {
  holdExpiresAt: string | null;
  hasPaymentConfig: boolean;
  hasQR: boolean;
  qrSrc: string;
  amount: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  reference: string;
  lineHref: string;
}) {
  // false pre-hydration = matches the server-rendered HTML (server always
  // renders as "not yet expired", same convention as HoldCountdown's
  // pre-hydration placeholder), so there is no hydration mismatch.
  const [holdExpired, setHoldExpired] = useState(false);

  useEffect(() => {
    if (!holdExpiresAt) return;
    const check = () =>
      setHoldExpired(new Date(holdExpiresAt).getTime() <= Date.now());
    check();
    const id = setInterval(check, 1000);
    return () => clearInterval(id);
  }, [holdExpiresAt]);

  if (holdExpired) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center">
        <p className="font-semibold text-red-700">หมดเวลาถือคิวแล้ว</p>
        <p className="mt-2 text-sm text-red-600">
          กรุณาอย่าโอนเงินสำหรับคิวนี้อีก — ระบบไม่รับยืนยันการชำระเงินหลังหมดเวลาถือคิว
          หากต้องการความช่วยเหลือกรุณาติดต่อทีมงาน หรือทำการจองคิวใหม่
        </p>
      </div>
    );
  }

  if (!hasPaymentConfig) {
    return (
      <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-700">
        ทีมงานจะติดต่อเพื่อแจ้งรายละเอียดการชำระเงิน
      </p>
    );
  }

  return (
    <>
      <p className="mb-1 text-center text-3xl font-bold text-rose-700">
        {Number(amount).toLocaleString("th-TH")}{" "}
        <span className="text-lg font-medium">บาท</span>
      </p>
      <p className="mb-4 text-center text-sm text-gray-600">
        โอนยอดเต็มจำนวน แล้วส่งสลิปพร้อมเลขอ้างอิงด้านล่าง
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
        <Row label="ธนาคาร" value={bankName} />
        <Row label="ชื่อบัญชี" value={accountName} />
        <Row
          label="เลขบัญชี"
          value={accountNumber}
          action={<CopyButton text={accountNumber} label="คัดลอก" />}
        />
        <Row
          label="เลขอ้างอิง"
          value={reference}
          action={<CopyButton text={reference} label="คัดลอก" />}
        />
      </dl>

      {lineHref && <LineCta href={lineHref} expiresAt={holdExpiresAt} />}
    </>
  );
}

// Duplicated (not imported) from page.tsx: page.tsx is a server component
// pulling in server-only modules (Supabase admin client, env), so importing
// anything from it here would drag that server-only code into the client
// bundle. This is a few lines of trivial presentational JSX — cheaper and
// safer to duplicate than to cross that boundary.
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
