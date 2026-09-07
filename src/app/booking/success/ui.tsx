// Shared presentational pieces used by both the server-rendered "not found"
// case (page.tsx) and the client-rendered status panel (BookingStatusPanel),
// so the confirmed/cancelled/expired card looks identical regardless of
// whether it was the initial render or a live status-poll update.

type StatusTone = "success" | "neutral" | "warn" | "review";

// Status states other than pending_payment.
export const STATUS_INFO: Record<
  string,
  { icon: string; title: string; body: string; tone: StatusTone }
> = {
  booked: {
    icon: "✅",
    title: "ชำระเงินแล้ว รอยืนยัน",
    body: "ทีมงานจะตรวจสอบและยืนยันคิวของคุณเร็วๆ นี้",
    tone: "success",
  },
  confirmed: {
    icon: "✅",
    title: "ยืนยันการจองแล้ว",
    body: "ทีมงานได้ยืนยันคิวของคุณแล้ว",
    tone: "success",
  },
  cancelled: {
    icon: "❌",
    title: "คิวถูกยกเลิกแล้ว",
    body: "กรุณาจองคิวใหม่หากต้องการนัดหมาย",
    tone: "neutral",
  },
  expired: {
    icon: "⏰",
    title: "คิวหมดอายุแล้ว",
    body: "ไม่ได้ชำระภายในเวลาที่กำหนด กรุณาจองคิวใหม่",
    tone: "warn",
  },
  completed: {
    icon: "⭐",
    title: "เสร็จสิ้น",
    body: "ขอบคุณที่ใช้บริการหมอแจว",
    tone: "success",
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
    <main className="checkout-page">
      <div className="checkout-shell" style={{ maxWidth: 440 }}>
        <div className="checkout-hero" style={{ marginBottom: 0 }}>{children}</div>
      </div>
    </main>
  );
}

export function IconCircle({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: StatusTone;
}) {
  return (
    <div className="checkout-badge" data-tone={tone}>
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
    <div className="checkout-row">
      <dt className="checkout-row-label">{label}</dt>
      <dd className="checkout-row-value" data-strong={strong ? "true" : undefined}>
        <span>{value}</span>
        {action}
      </dd>
    </div>
  );
}
