"use client";

import { useTransition } from "react";
import { confirmPayment } from "@/app/admin/actions";

type Props = {
  bookingId: string;
  nickname: string;
  phone: string;
  slotInfo: string | null;
  refCode: string;
  redirectTo: string;
};

export function ConfirmPaymentButton({
  bookingId,
  nickname,
  phone,
  slotInfo,
  refCode,
  redirectTo,
}: Props) {
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    const lines = [
      "ยืนยันการชำระเงิน?",
      "",
      `ชื่อเล่น: ${nickname}`,
      `เบอร์โทร: ${phone}`,
      slotInfo ? `วัน/รอบ: ${slotInfo}` : null,
      `เลขอ้างอิง: ${refCode}`,
      "ยอด: 999 บาท",
      "",
      "⚠️ ตรวจสอบเงินเข้าบัญชีและสลิปเรียบร้อยแล้ว?",
    ]
      .filter(Boolean)
      .join("\n");

    if (!confirm(lines)) return;

    const fd = new FormData();
    fd.set("bookingId", bookingId);
    fd.set("redirectTo", redirectTo);
    startTransition(() => confirmPayment(fd));
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
    >
      {isPending ? "กำลังดำเนินการ…" : "ยืนยันการชำระเงิน"}
    </button>
  );
}
