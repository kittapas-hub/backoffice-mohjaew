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
      <p className="py-3 text-center text-sm text-gray-400">
        หมดเวลาถือคิวแล้ว — ไม่สามารถส่งสลิปได้
      </p>
    );
  }

  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-green-500 px-4 py-3 text-base font-semibold text-white shadow-sm hover:bg-green-600 active:bg-green-700"
      >
        <span>💬</span>
        ส่งสลิปทาง LINE @mohjaew
      </a>
      <p className="mt-2 hidden text-center text-xs text-gray-400 sm:block">
        แนะนำให้เปิดผ่านมือถือเพื่อส่งสลิปใน LINE ได้สะดวก
      </p>
    </>
  );
}
