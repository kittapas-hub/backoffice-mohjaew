"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CopyButton } from "./CopyButton";
import { HoldCountdown } from "./HoldCountdown";
import { LineCta } from "./LineCta";
import { SlipVerificationLink } from "./SlipVerificationLink";
import { STATUS_POLL_INTERVAL_MS, shouldPollStatus } from "./helpers";
import { CheckoutIcon, STATUS_INFO, formatThaiDate, Wrapper, IconCircle, Row } from "./ui";

type StatusResponse = {
  status: string;
  reference: string;
  paymentStatus: string | null;
};

export function BookingStatusPanel(props: {
  token: string;
  initialStatus: string;
  initialPaymentStatus: string | null;
  reference: string;
  bookingDate: string | null;
  slotLabel: string | null;
  queueNumber: number | null;
  holdExpiresAt: string | null;
  /** Server-rendered gate prevents expired payment copy before hydration. */
  initialHoldExpired: boolean;
  deadline: string;
  hasPaymentConfig: boolean;
  hasQR: boolean;
  qrSrc: string;
  amount: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  lineHref: string;
  /** POST-only endpoint when automatic slip verification is available. */
  slipOrderUrl?: string | null;
}) {
  const [status, setStatus] = useState(props.initialStatus);
  const [paymentStatus, setPaymentStatus] = useState(props.initialPaymentStatus);

  // Local, client-clock-only signal that the hold deadline has passed. This
  // NEVER overrides server-confirmed state: it only gates which payment
  // instructions render while status is still (server-side) pending_payment.
  // The moment a poll observes a real status change, the component leaves
  // this branch entirely (see the !shouldPollStatus(status) render below),
  // so a locally-computed expiry can never mask or fight a server transition.
  const [holdExpired, setHoldExpired] = useState(props.initialHoldExpired);
  useEffect(() => {
    if (!props.holdExpiresAt) {
      setHoldExpired(true);
      return;
    }
    const check = () => {
      const expiry = new Date(props.holdExpiresAt!).getTime();
      setHoldExpired(!Number.isFinite(expiry) || expiry <= Date.now());
    };
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
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as Partial<StatusResponse>;
        if (!cancelled) {
          if (data.status && data.status !== status) setStatus(data.status);
          if (data.paymentStatus !== undefined) {
            setPaymentStatus(data.paymentStatus);
          }
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

  // Payment review is distinct from booking status. It takes precedence over
  // pending/expired booking copy because the system has already accepted a
  // real slip for staff resolution; asking the customer to pay again is unsafe.
  if (paymentStatus === "manual_review") {
    return (
      <Wrapper>
        <IconCircle tone="review"><CheckoutIcon name="clock" /></IconCircle>
        <h1 className="checkout-title">อยู่ระหว่างการตรวจสอบ</h1>
        <p className="checkout-subtitle">
          ระบบได้รับสลิปแล้ว ไม่ต้องโอนเงินหรืออัปโหลดสลิปซ้ำ
        </p>
        <div className="checkout-card" style={{ marginTop: 20, textAlign: "left" }}>
          <dl className="checkout-rows">
            <Row label="เลขอ้างอิง" value={props.reference} strong />
            <Row label="วันที่" value={formatThaiDate(props.bookingDate)} />
            <Row label="รอบเซสชัน" value={props.slotLabel ?? "-"} />
          </dl>
        </div>
        {props.lineHref && (
          <a
            href={props.lineHref}
            target="_blank"
            rel="noopener noreferrer"
            className="checkout-link"
            style={{ marginTop: 16 }}
          >
            ติดต่อทีมงานทาง LINE
          </a>
        )}
      </Wrapper>
    );
  }

  if (paymentStatus === "unknown") {
    return (
      <Wrapper>
        <IconCircle tone="review"><CheckoutIcon name="warning" /></IconCircle>
        <h1 className="checkout-title">ยังตรวจสอบสถานะการชำระเงินไม่ได้</h1>
        <p className="checkout-subtitle">
          กรุณาอย่าโอนเงินหรืออัปโหลดสลิปซ้ำในขณะนี้ แล้วลองเปิดหน้านี้ใหม่หรือติดต่อทีมงาน
        </p>
        <div className="checkout-card" style={{ marginTop: 20, textAlign: "left" }}>
          <dl className="checkout-rows">
            <Row label="เลขอ้างอิง" value={props.reference} strong />
            <Row label="วันที่" value={formatThaiDate(props.bookingDate)} />
            <Row label="รอบเซสชัน" value={props.slotLabel ?? "-"} />
          </dl>
        </div>
        {props.lineHref && (
          <a
            href={props.lineHref}
            target="_blank"
            rel="noopener noreferrer"
            className="checkout-link"
            style={{ marginTop: 16 }}
          >
            ติดต่อทีมงานทาง LINE
          </a>
        )}
      </Wrapper>
    );
  }

  // Payment order status is authoritative for money received. The booking
  // and payment queries are separate reads, so a brief commit-time snapshot
  // can show a paid order beside a still-pending booking; never render pay or
  // re-upload actions in that state.
  if (paymentStatus === "paid") {
    const bookingClosed = status === "cancelled" || status === "expired";
    const bookingConfirmed = status === "confirmed" || status === "completed";
    return (
      <Wrapper>
        <IconCircle tone="success">✅</IconCircle>
        <h1 className="checkout-title">ชำระเงินแล้ว</h1>
        <p className="checkout-subtitle">
          {bookingClosed
            ? "ระบบได้รับการชำระเงินแล้ว แต่รายการจองสิ้นสุดแล้ว กรุณาติดต่อทีมงาน"
            : bookingConfirmed
              ? "คิวของคุณได้รับการยืนยันแล้ว"
              : "ระบบได้รับการชำระเงินแล้ว ทีมงานกำลังตรวจสอบและยืนยันคิวของคุณ"}
        </p>
        <div className="checkout-card" style={{ marginTop: 20, textAlign: "left" }}>
          <dl className="checkout-rows">
            <Row label="เลขอ้างอิง" value={props.reference} strong />
            <Row label="วันที่" value={formatThaiDate(props.bookingDate)} />
            <Row label="รอบเซสชัน" value={props.slotLabel ?? "-"} />
          </dl>
        </div>
        {bookingClosed && props.lineHref && (
          <a
            href={props.lineHref}
            target="_blank"
            rel="noopener noreferrer"
            className="checkout-link"
            style={{ marginTop: 16 }}
          >
            ติดต่อทีมงานทาง LINE
          </a>
        )}
      </Wrapper>
    );
  }

  // A closed payment order must never fall through to the pending-payment
  // instructions, even if the booking read is briefly still pending or the
  // order came from a legacy/future provider path.
  if (paymentStatus === "expired" || paymentStatus === "failed" || paymentStatus === "refunded") {
    return (
      <Wrapper>
        <IconCircle tone="neutral">⏰</IconCircle>
        <h1 className="checkout-title">รายการชำระเงินปิดแล้ว</h1>
        <p className="checkout-subtitle">
          กรุณาอย่าโอนเงินหรืออัปโหลดสลิปซ้ำสำหรับรายการนี้ หากต้องการความช่วยเหลือกรุณาติดต่อทีมงาน
        </p>
        <div className="checkout-card" style={{ marginTop: 20, textAlign: "left" }}>
          <dl className="checkout-rows">
            <Row label="เลขอ้างอิง" value={props.reference} strong />
            <Row label="วันที่" value={formatThaiDate(props.bookingDate)} />
            <Row label="รอบเซสชัน" value={props.slotLabel ?? "-"} />
          </dl>
        </div>
        {props.lineHref && (
          <a
            href={props.lineHref}
            target="_blank"
            rel="noopener noreferrer"
            className="checkout-link"
            style={{ marginTop: 16 }}
          >
            ติดต่อทีมงานทาง LINE
          </a>
        )}
      </Wrapper>
    );
  }

  // ── Non-pending_payment status: same card whether from the initial load
  // or a live poll update — no manual refresh needed. ────────────────────────
  if (!shouldPollStatus(status)) {
    const info = STATUS_INFO[status] ?? {
      icon: "info",
      title: "สถานะการจอง",
      body: "กรุณาติดต่อทีมงาน",
      tone: "neutral" as const,
    };
    return (
      <Wrapper>
        <IconCircle tone={info.tone}><CheckoutIcon name={info.icon} /></IconCircle>
        <h1 className="checkout-title">{info.title}</h1>
        <p className="checkout-subtitle">{info.body}</p>
        <div className="checkout-card" style={{ marginTop: 20, textAlign: "left" }}>
          <dl className="checkout-rows">
            <Row label="เลขอ้างอิง" value={props.reference} strong />
            <Row label="วันที่" value={formatThaiDate(props.bookingDate)} />
            <Row label="รอบเซสชัน" value={props.slotLabel ?? "-"} />
          </dl>
        </div>
        <Link href="/booking" className="checkout-link" style={{ marginTop: 16 }}>
          จองคิวใหม่
        </Link>
      </Wrapper>
    );
  }

  // ── pending_payment: calm summary + clear payment action ────────────────────
  return (
    <main className="checkout-page">
      <div className="checkout-shell checkout-shell-wide">
        <div className="checkout-hero">
          <div className="checkout-badge" data-tone="warn">
            <CheckoutIcon name="clock" />
          </div>
          <h1 className="checkout-title">ระบบกำลังถือคิวให้คุณ</h1>
          <p className="checkout-subtitle">
            กรุณาชำระเงินภายในเวลาที่กำหนด เพื่อยืนยันคิวของคุณ
          </p>
        </div>

        <div className="checkout-grid" data-cols="2">
          {/* Summary: what is held, the amount due, and the hold countdown. */}
          <div className="checkout-summary-col">
            <div className="checkout-card checkout-summary">
              <h2 className="checkout-card-title">สรุปการจอง</h2>
              <dl className="checkout-rows">
                <Row label="เลขอ้างอิง" value={props.reference} strong />
                <Row label="วันที่" value={formatThaiDate(props.bookingDate)} />
                <Row label="รอบเซสชัน" value={props.slotLabel ?? "-"} />
                <Row
                  label="ลำดับคิวในรอบ"
                  value={props.queueNumber ? `#${props.queueNumber}` : "-"}
                />
              </dl>
              <p className="checkout-note">
                ลำดับคิวนี้คือลำดับการจองในรอบเซสชัน ไม่ใช่เวลาโทรที่แน่นอน
                ทีมงานจะติดต่อตามลำดับคิว
              </p>

              {props.hasPaymentConfig && !holdExpired && (
                <div
                  className="checkout-amount-block"
                  style={{ marginTop: 16, borderTop: "1px solid #f3e7e1", paddingTop: 16 }}
                >
                  <p className="checkout-amount-label">ยอดที่ต้องชำระ</p>
                  <p className="checkout-amount">
                    {Number(props.amount).toLocaleString("th-TH")} <span>บาท</span>
                  </p>
                </div>
              )}

              {props.holdExpiresAt && (
                <HoldCountdown
                  expiresAt={props.holdExpiresAt}
                  deadline={props.deadline}
                />
              )}
            </div>
          </div>

          {/* Action: transfer instructions + slip upload / LINE fallback. */}
          <div>
            <div className="checkout-card">
              <h2 className="checkout-card-title">ขั้นตอนชำระเงิน</h2>

              {holdExpired ? (
                <div className="checkout-alert" data-tone="error">
                  <p className="checkout-alert-title">หมดเวลาถือคิวแล้ว</p>
                  <p className="checkout-alert-body">
                    กรุณาอย่าโอนเงินสำหรับคิวนี้อีก — ระบบไม่รับยืนยันการชำระเงินหลังหมดเวลาถือคิว
                    หากต้องการความช่วยเหลือกรุณาติดต่อทีมงาน หรือทำการจองคิวใหม่
                  </p>
                  <Link href="/booking" className="checkout-btn" style={{ marginTop: 14 }}>
                    จองคิวใหม่
                  </Link>
                </div>
              ) : props.hasPaymentConfig ? (
                <>
                  <p className="checkout-note checkout-note-center" style={{ marginTop: 0, marginBottom: 16 }}>
                    โอนยอดเต็มจำนวน แล้วส่งสลิปพร้อมเลขอ้างอิงด้านล่าง
                  </p>

                  {props.hasQR && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={props.qrSrc}
                      alt="QR Code สำหรับโอนเงิน"
                      width={220}
                      height={220}
                      className="checkout-qr"
                    />
                  )}

                  <dl className="checkout-rows" style={{ marginBottom: 16 }}>
                    <Row label="ธนาคาร" value={props.bankName} />
                    <Row label="ชื่อบัญชี" value={props.accountName} />
                    <Row
                      label="เลขบัญชี"
                      value={props.accountNumber}
                      action={<CopyButton text={props.accountNumber} label="คัดลอก" />}
                    />
                    <Row
                      label="เลขอ้างอิง"
                      value={props.reference}
                      action={<CopyButton text={props.reference} label="คัดลอก" />}
                    />
                  </dl>

                  <div className="checkout-stack">
                    {props.slipOrderUrl && (
                      <SlipVerificationLink orderUrl={props.slipOrderUrl} />
                    )}
                    {props.lineHref && (
                      <LineCta href={props.lineHref} expiresAt={props.holdExpiresAt} />
                    )}
                  </div>

                  <p className="checkout-note checkout-note-center" style={{ marginTop: 14 }}>
                    {props.slipOrderUrl
                      ? "ส่งผ่านปุ่มตรวจสอบอัตโนมัติเพื่อให้ระบบตรวจสอบและยืนยันคิวเมื่อข้อมูลถูกต้อง หากส่งสลิปทาง LINE ทีมงานจะตรวจสอบให้"
                      : "คิวของคุณจะยืนยันก็ต่อเมื่อทีมงานตรวจสอบการชำระเงินแล้วเท่านั้น"}
                  </p>
                </>
              ) : (
                <p className="checkout-alert" data-tone="neutral">
                  ทีมงานจะติดต่อเพื่อแจ้งรายละเอียดการชำระเงิน
                </p>
              )}
            </div>

            <div style={{ textAlign: "center", marginTop: 16 }}>
              <Link href="/booking" className="checkout-link checkout-link-muted">
                กลับไปเลือกวันและเวลาอื่น
              </Link>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
