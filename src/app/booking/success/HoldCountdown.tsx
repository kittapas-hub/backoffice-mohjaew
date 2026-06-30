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
      <div className="mt-4 rounded-lg bg-amber-50 p-4 text-center">
        {deadline && (
          <p className="text-sm text-amber-700">
            กรุณาชำระเงินก่อน <span className="font-semibold">{deadline}</span>
          </p>
        )}
        <div className="mt-2 h-9" />
      </div>
    );
  }

  const expired = ms <= 0;
  const warn = !expired && ms < 120_000; // < 2 min

  if (expired) {
    return (
      <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-center">
        <p className="font-semibold text-red-700">หมดเวลาถือคิวแล้ว</p>
        <p className="mt-1 text-sm text-red-600">กรุณาเลือกช่วงเวลาใหม่</p>
      </div>
    );
  }

  return (
    <div
      className={`mt-4 rounded-lg p-4 text-center ${
        warn ? "border border-orange-200 bg-orange-50" : "bg-amber-50"
      }`}
    >
      {deadline && (
        <p className={`text-sm ${warn ? "text-orange-700" : "text-amber-700"}`}>
          กรุณาชำระเงินก่อน{" "}
          <span className="font-semibold">{deadline}</span>
        </p>
      )}
      <p
        className={`mt-2 text-3xl font-bold tabular-nums ${
          warn ? "text-orange-600" : "text-amber-600"
        }`}
      >
        เหลือเวลา {formatMmSs(ms)}
      </p>
    </div>
  );
}
