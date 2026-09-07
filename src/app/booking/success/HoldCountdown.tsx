"use client";

import { useEffect, useState } from "react";
import { formatMmSs } from "./helpers";

function msRemaining(expiresAt: string): number {
  return new Date(expiresAt).getTime() - Date.now();
}

export function HoldCountdown({
  expiresAt,
  deadline,
}: {
  expiresAt: string;
  deadline: string;
}) {
  // null = pre-hydration; keeps server render identical to first client render
  const [ms, setMs] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setMs(msRemaining(expiresAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (ms === null) {
    // Placeholder matching the server-rendered HTML to avoid hydration mismatch
    return (
      <div className="checkout-countdown">
        {deadline && (
          <p className="checkout-countdown-deadline">
            กรุณาชำระเงินก่อน <span style={{ fontWeight: 700 }}>{deadline}</span>
          </p>
        )}
        <div className="checkout-countdown-placeholder" />
      </div>
    );
  }

  const expired = ms <= 0;
  const warn = !expired && ms < 120_000; // < 2 min

  if (expired) {
    return (
      <div className="checkout-countdown" data-state="expired">
        <p className="checkout-alert-title" style={{ color: "#b42318" }}>
          หมดเวลาถือคิวแล้ว
        </p>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "#b42318" }}>
          กรุณาเลือกช่วงเวลาใหม่
        </p>
      </div>
    );
  }

  return (
    <div className="checkout-countdown" data-state={warn ? "warn" : undefined}>
      {deadline && (
        <p className="checkout-countdown-deadline">
          กรุณาชำระเงินก่อน <span style={{ fontWeight: 700 }}>{deadline}</span>
        </p>
      )}
      <p className="checkout-countdown-time">เหลือเวลา {formatMmSs(ms)}</p>
    </div>
  );
}
