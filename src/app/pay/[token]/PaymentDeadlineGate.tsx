"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isPaymentDeadlinePassed } from "./pay-page-gate";
import { CheckoutIcon } from "@/app/booking/success/ui";

const CHECKOUT_REFRESH_MS = 15_000;

/** Hides every payment instruction when an already-open checkout reaches its
 * trusted server-supplied deadline. The server page performs the same check
 * on initial render; this component closes the stale-tab gap. */
export function PaymentDeadlineGate({
  deadline,
  children,
}: {
  deadline: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  // Keep the hydration render identical to the server. The effect immediately
  // rechecks the clock and schedules the one state change this page needs.
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (isPaymentDeadlinePassed(deadline)) {
      setExpired(true);
      return;
    }

    const delay = new Date(deadline).getTime() - Date.now();
    const deadlineId = window.setTimeout(() => setExpired(true), delay + 50);
    // Re-render from trusted server state so another tab's upload, an admin
    // action, or an expiry worker closes this already-open checkout promptly.
    const refreshId = window.setInterval(() => router.refresh(), CHECKOUT_REFRESH_MS);
    return () => {
      window.clearTimeout(deadlineId);
      window.clearInterval(refreshId);
    };
  }, [deadline, router]);

  if (!expired) return children;

  return (
    <main className="checkout-page">
      <div className="checkout-shell" style={{ maxWidth: 460 }}>
        <div className="checkout-hero">
          <div className="checkout-badge" data-tone="neutral"><CheckoutIcon name="clock" /></div>
          <h1 className="checkout-title">รายการหมดอายุ</h1>
          <p className="checkout-subtitle">
            หมดเวลาถือคิวแล้ว กรุณาอย่าโอนเงินหรืออัปโหลดสลิปสำหรับรายการนี้
          </p>
        </div>
        <div className="checkout-alert" data-tone="neutral">
          <p className="checkout-alert-title">กรุณาจองคิวใหม่</p>
          <Link href="/booking" className="checkout-link" style={{ marginTop: 8 }}>
            กลับไปหน้าจองคิว
          </Link>
        </div>
      </div>
    </main>
  );
}
