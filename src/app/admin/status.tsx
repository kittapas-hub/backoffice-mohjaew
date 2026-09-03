export const STATUSES = [
  "pending",
  "contacted",
  "pending_payment",
  "booked",
  "confirmed",
  "cancelled",
  "expired",
  "completed",
] as const;

export const STATUS_LABEL: Record<string, string> = {
  pending: "รอดำเนินการ",
  contacted: "ติดต่อแล้ว",
  pending_payment: "รอชำระเงิน",
  booked: "ชำระแล้ว",
  confirmed: "ยืนยันแล้ว",
  cancelled: "ยกเลิก",
  expired: "หมดเวลา",
  completed: "เสร็จสิ้น",
};

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "border-amber-200 bg-amber-50 text-amber-800",
    contacted: "border-blue-200 bg-blue-50 text-blue-800",
    pending_payment: "border-orange-200 bg-orange-50 text-orange-800",
    booked: "border-teal-200 bg-teal-50 text-teal-800",
    confirmed: "border-green-200 bg-green-50 text-green-800",
    cancelled: "border-gray-200 bg-gray-100 text-gray-600",
    expired: "border-gray-200 bg-gray-100 text-gray-500",
    completed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  };
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${colors[status] ?? "border-gray-200 bg-gray-100"}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
