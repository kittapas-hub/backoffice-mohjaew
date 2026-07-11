// Shared presentational pieces used by both the server-rendered "not found"
// case (page.tsx) and the client-rendered status panel (BookingStatusPanel),
// so the confirmed/cancelled/expired card looks identical regardless of
// whether it was the initial render or a live status-poll update.

// Status states other than pending_payment.
export const STATUS_INFO: Record<
  string,
  { icon: string; title: string; body: string }
> = {
  booked: {
    icon: "✅",
    title: "ชำระเงินแล้ว รอยืนยัน",
    body: "ทีมงานจะตรวจสอบและยืนยันคิวของคุณเร็วๆ นี้",
  },
  confirmed: {
    icon: "✅",
    title: "ยืนยันการจองแล้ว",
    body: "ทีมงานได้ยืนยันคิวของคุณแล้ว",
  },
  cancelled: {
    icon: "❌",
    title: "คิวถูกยกเลิกแล้ว",
    body: "กรุณาจองคิวใหม่หากต้องการนัดหมาย",
  },
  expired: {
    icon: "⏰",
    title: "คิวหมดอายุแล้ว",
    body: "ไม่ได้ชำระภายในเวลาที่กำหนด กรุณาจองคิวใหม่",
  },
  completed: {
    icon: "⭐",
    title: "เสร็จสิ้น",
    body: "ขอบคุณที่ใช้บริการหมอแจว",
  },
};

export function formatThaiDate(iso: string | null): string {
  if (!iso) return "-";
  try {
    // Append T00:00:00Z so the date is interpreted as UTC, not local time.
    return new Date(iso + "T00:00:00Z").toLocaleDateString("th-TH", {
      weekday: "short",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

export function formatThaiDeadline(iso: string | null): string {
  if (!iso) return "";
  try {
    return (
      new Date(iso).toLocaleString("th-TH", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Bangkok",
      }) + " น."
    );
  } catch {
    return "";
  }
}

export function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-5 py-12 text-center">
      {children}
    </main>
  );
}

export function IconCircle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 text-3xl">
      {children}
    </div>
  );
}

export function Row({
  label,
  value,
  strong,
  action,
}: {
  label: string;
  value: string;
  strong?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-gray-100 pb-2">
      <dt className="shrink-0 text-sm text-gray-500">{label}</dt>
      <dd className="ml-3 flex items-center gap-2">
        <span
          className={
            strong ? "text-lg font-bold tracking-wide" : "text-sm text-right"
          }
        >
          {value}
        </span>
        {action}
      </dd>
    </div>
  );
}
