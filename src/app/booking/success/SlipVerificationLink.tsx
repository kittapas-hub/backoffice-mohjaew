"use client";

import { useState } from "react";

export function SlipVerificationLink({ orderUrl }: { orderUrl: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function createOrder() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(orderUrl, { method: "POST", credentials: "same-origin" });
      const body = (await res.json()) as { checkoutToken?: string };
      if (!res.ok || !body.checkoutToken) throw new Error("order_unavailable");
      window.location.assign(`/pay/${encodeURIComponent(body.checkoutToken)}`);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <div className="mb-3">
      <button type="button" onClick={createOrder} disabled={busy}
        className="block w-full rounded-xl bg-rose-600 px-5 py-3 text-center text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60">
        {busy ? "กำลังเปิดหน้าส่งสลิป…" : "อัปโหลดสลิป — ยืนยันคิวอัตโนมัติ"}
      </button>
      {failed && <p className="mt-2 text-center text-xs text-rose-700">ยังเปิดการส่งสลิปไม่ได้ กรุณาติดต่อทีมงาน</p>}
    </div>
  );
}
