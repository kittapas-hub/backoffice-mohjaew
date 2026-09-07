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
    <div>
      <button type="button" onClick={createOrder} disabled={busy} className="checkout-btn">
        {busy ? "กำลังเปิดหน้าส่งสลิป…" : "อัปโหลดสลิป — ยืนยันคิวอัตโนมัติ"}
      </button>
      {failed && (
        <p className="checkout-note checkout-note-center" style={{ color: "var(--mj-primary-dark)" }}>
          ยังเปิดการส่งสลิปไม่ได้ กรุณาติดต่อทีมงาน
        </p>
      )}
    </div>
  );
}
