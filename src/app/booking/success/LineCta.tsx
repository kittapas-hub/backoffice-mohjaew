"use client";

import { useEffect, useState } from "react";

export function LineCta({
  href,
  expiresAt,
}: {
  href: string;
  expiresAt: string | null;
}) {
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (!expiresAt) return;
    const check = () =>
      setExpired(new Date(expiresAt).getTime() - Date.now() <= 0);
    check();
    // ponytail: 5s interval — no need for 1s tick here, CTA state change is not time-critical
    const id = setInterval(check, 5000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (expired) {
    return (
      <p style={{ padding: "12px 0", textAlign: "center", fontSize: 14, color: "#9ca3af" }}>
        หมดเวลาถือคิวแล้ว — ไม่สามารถส่งสลิปได้
      </p>
    );
  }

  return (
    <div>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="checkout-btn checkout-btn-line"
      >
        <span aria-hidden="true">💬</span>
        ส่งสลิปทาง LINE @mohjaew
      </a>
      <p className="checkout-note checkout-note-center line-cta-desktop-hint">
        แนะนำให้เปิดผ่านมือถือเพื่อส่งสลิปใน LINE ได้สะดวก
      </p>
    </div>
  );
}
