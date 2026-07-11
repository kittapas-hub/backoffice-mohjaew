"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CopyButton } from "./CopyButton";
import { HoldCountdown } from "./HoldCountdown";
import { LineCta } from "./LineCta";
import { STATUS_POLL_INTERVAL_MS, shouldPollStatus } from "./helpers";
import { STATUS_INFO, formatThaiDate, Wrapper, IconCircle, Row } from "./ui";

type StatusResponse = { status: string; reference: string };

export function BookingStatusPanel(props: {
  token: string;
  initialStatus: string;
  reference: string;
  bookingDate: string | null;
  slotLabel: string | null;
  queueNumber: number | null;
  holdExpiresAt: string | null;
  deadline: string;
  hasPaymentConfig: boolean;
  hasQR: boolean;
  qrSrc: string;
  amount: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  lineHref: string;
}) {
  const [status, setStatus] = useState(props.initialStatus);

  // Local, client-clock-only signal that the hold deadline has passed. This
  // NEVER overrides server-confirmed state: it only gates which payment
  // instructions render while status is still (server-side) pending_payment.
  // The moment a poll observes a real status change, the component leaves
  // this branch entirely (see the !shouldPollStatus(status) render below),
  // so a locally-computed expiry can never mask or fight a server transition.
  const [holdExpired, setHoldExpired] = useState(false);
  useEffect(() => {
    if (!props.holdExpiresAt) return;
    const check = () =>
      setHoldExpired(new Date(props.holdExpiresAt!).getTime() <= Date.now());
    check();
    const id = setInterval(check, 1000);
    return () => clearInterval(id);
  }, [props.holdExpiresAt]);

  // Re-checks status via the opaque success token only (never a raw booking
  // id) while pending_payment, at a fixed 15s cadence. Stops as soon as the
  // status leaves pending_payment, or when this component unmounts. This
  // keeps running even after the hold looks locally expired, since the DB
  // (via the expire-bookings cron) is the only source of truth for status.
  useEffect(() => {
    if (!shouldPollStatus(status)) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/bookings/status?token=${encodeURIComponent(props.token)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as Partial<StatusResponse>;
        if (!cancelled && data.status && data.status !== status) {
          setStatus(data.status);
        }
      } catch {
        // Transient network error — the next tick retries.
      }
    };

    const id = setInterval(poll, STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [status, props.token]);

  // ── Non-pending_payment status: same card whether from the initial load
  // or a live poll update — no manual refresh needed. ────────────────────────
  if (!shouldPollStatus(status)) {
    const info = STATUS_INFO[status] ?? {
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
          <Row label="เลขอ้างอิง" value={props.reference} strong />
          <Row label="วันที่" value={formatThaiDate(props.bookingDate)} />
          <Row label="รอบเวลา" value={props.slotLabel ?? "-"} />
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

  // ── pending_payment: full payment instructions ──────────────────────────────
  return (
    <main className="mx-auto min-h-screen max-w-md px-5 py-10">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 text-4xl">
          ⏳
        </div>
        <h1 className="text-2xl font-bold text-gray-800">
          ระบบกำลังถือคิวให้คุณ
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          กรุณาชำระเงินภายในเวลาที่กำหนด เพื่อยืนยันคิวของคุณ
        </p>
      </div>

      <div className="mb-5 rounded-2xl border border-rose-100 bg-white p-5 shadow-sm">
        <dl className="space-y-3">
          <Row label="เลขอ้างอิง" value={props.reference} strong />
          <Row label="วันที่" value={formatThaiDate(props.bookingDate)} />
          <Row label="รอบเวลา" value={props.slotLabel ?? "-"} />
          <Row
            label="ลำดับคิวในรอบ"
            value={props.queueNumber ? `#${props.queueNumber}` : "-"}
          />
        </dl>

        {props.holdExpiresAt && (
          <HoldCountdown
            expiresAt={props.holdExpiresAt}
            deadline={props.deadline}
          />
        )}
      </div>

      <div className="mb-5 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <h2 className="mb-4 font-bold">ขั้นตอนชำระเงิน</h2>

        {holdExpired ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center">
            <p className="font-semibold text-red-700">หมดเวลาถือคิวแล้ว</p>
            <p className="mt-2 text-sm text-red-600">
              กรุณาอย่าโอนเงินสำหรับคิวนี้อีก — ระบบไม่รับยืนยันการชำระเงินหลังหมดเวลาถือคิว
              หากต้องการความช่วยเหลือกรุณาติดต่อทีมงาน หรือทำการจองคิวใหม่
            </p>
            <Link
              href="/booking"
              className="mt-4 inline-block rounded-xl bg-rose-600 px-5 py-2 text-sm font-semibold text-white"
            >
              จองคิวใหม่
            </Link>
          </div>
        ) : props.hasPaymentConfig ? (
          <>
            <p className="mb-1 text-center text-3xl font-bold text-rose-700">
              {Number(props.amount).toLocaleString("th-TH")}{" "}
              <span className="text-lg font-medium">บาท</span>
            </p>
            <p className="mb-4 text-center text-sm text-gray-600">
              โอนยอดเต็มจำนวน แล้วส่งสลิปพร้อมเลขอ้างอิงด้านล่าง
            </p>

            {props.hasQR && (
              <div className="mb-5 flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={props.qrSrc}
                  alt="QR Code สำหรับโอนเงิน"
                  width={220}
                  height={220}
                  className="rounded-xl border border-gray-200"
                />
              </div>
            )}

            <dl className="mb-5 space-y-3">
              <Row label="ธนาคาร" value={props.bankName} />
              <Row label="ชื่อบัญชี" value={props.accountName} />
              <Row
                label="เลขบัญชี"
                value={props.accountNumber}
                action={
                  <CopyButton text={props.accountNumber} label="คัดลอก" />
                }
              />
              <Row
                label="เลขอ้างอิง"
                value={props.reference}
                action={<CopyButton text={props.reference} label="คัดลอก" />}
              />
            </dl>

            {props.lineHref && (
              <LineCta href={props.lineHref} expiresAt={props.holdExpiresAt} />
            )}

            <p className="mt-3 text-center text-xs text-gray-400">
              คิวของคุณจะยืนยันก็ต่อเมื่อทีมงานตรวจสอบการชำระเงินแล้วเท่านั้น
            </p>
          </>
        ) : (
          <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-700">
            ทีมงานจะติดต่อเพื่อแจ้งรายละเอียดการชำระเงิน
          </p>
        )}
      </div>

      <Link
        href="/booking"
        className="block text-center text-sm text-gray-500 hover:underline"
      >
        กลับไปเลือกวันและเวลาอื่น
      </Link>
    </main>
  );
}
