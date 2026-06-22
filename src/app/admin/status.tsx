export const STATUSES = [
  "pending",
  "contacted",
  "pending_payment",
  "confirmed",
  "cancelled",
  "expired",
  "completed",
] as const;

export const STATUS_LABEL: Record<string, string> = {
  pending: "รอดำเนินการ",
  contacted: "ติดต่อแล้ว",
  pending_payment: "รอชำระเงิน",
  confirmed: "ยืนยันแล้ว",
  cancelled: "ยกเลิก",
  expired: "หมดเวลา",
  completed: "เสร็จสิ้น",
};

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-amber-100 text-amber-800",
    contacted: "bg-blue-100 text-blue-800",
    pending_payment: "bg-orange-100 text-orange-800",
    confirmed: "bg-green-100 text-green-800",
    cancelled: "bg-gray-200 text-gray-600",
    expired: "bg-gray-200 text-gray-500",
    completed: "bg-emerald-100 text-emerald-800",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${colors[status] ?? "bg-gray-100"}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
