"use client";

import { useTransition } from "react";
import { confirmBookingOverride, confirmPayment } from "@/app/admin/actions";

type Props = {
  bookingId: string;
  nickname: string;
  phone: string;
  slotInfo: string | null;
  refCode: string;
  redirectTo: string;
  verifiedClaimAvailable?: boolean;
};

export function ConfirmPaymentButton({
  bookingId,
  nickname,
  phone,
  slotInfo,
  refCode,
  redirectTo,
  verifiedClaimAvailable = false,
}: Props) {
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    const lines = verifiedClaimAvailable
      ? [
          "อนุมัติรายการชำระเงินที่ระบบตรวจสอบและบันทึกไว้แล้ว?",
          "",
          `ชื่อเล่น: ${nickname}`,
          `เบอร์โทร: ${phone}`,
          slotInfo ? `วัน/รอบ: ${slotInfo}` : null,
          `เลขอ้างอิง: ${refCode}`,
        ]
      : [
          "ยืนยันคิวโดยไม่บันทึกว่าเป็นการชำระเงินที่ตรวจสอบแล้ว?",
          "",
          `ชื่อเล่น: ${nickname}`,
          `เบอร์โทร: ${phone}`,
          slotInfo ? `วัน/รอบ: ${slotInfo}` : null,
          `เลขอ้างอิง: ${refCode}`,
          "",
          "การดำเนินการนี้เป็น booking override และไม่สร้างหลักฐานการชำระเงิน",
        ];

    if (!confirm(lines.filter(Boolean).join("\n"))) return;

    const fd = new FormData();
    fd.set("bookingId", bookingId);
    fd.set("redirectTo", redirectTo);
    const action = verifiedClaimAvailable ? confirmPayment : confirmBookingOverride;
    startTransition(() => action(fd));
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
    >
      {isPending
        ? "กำลังดำเนินการ…"
        : verifiedClaimAvailable
          ? "อนุมัติรายการชำระที่ตรวจแล้ว"
          : "ยืนยันคิว (ไม่บันทึกการชำระ)"}
    </button>
  );
}
