export const STATUSES = [
  "pending",
  "contacted",
  "confirmed",
  "cancelled",
] as const;

export const STATUS_LABEL: Record<string, string> = {
  pending: "รอดำเนินการ",
  contacted: "ติดต่อแล้ว",
  confirmed: "ยืนยันแล้ว",
  cancelled: "ยกเลิก",
};

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-amber-100 text-amber-800",
    contacted: "bg-blue-100 text-blue-800",
    confirmed: "bg-green-100 text-green-800",
    cancelled: "bg-gray-200 text-gray-600",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${colors[status] ?? "bg-gray-100"}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
