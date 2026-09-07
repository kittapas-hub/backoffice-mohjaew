// Shared presentational pieces used by both the server-rendered "not found"
// case (page.tsx) and the client-rendered status panel (BookingStatusPanel),
// so the confirmed/cancelled/expired card looks identical regardless of
// whether it was the initial render or a live status-poll update.

type StatusTone = "success" | "neutral" | "warn" | "review";
export type CheckoutIconName =
  | "card"
  | "check"
  | "clock"
  | "cross"
  | "info"
  | "search"
  | "star"
  | "warning";

// Status states other than pending_payment.
export const STATUS_INFO: Record<
  string,
  { icon: CheckoutIconName; title: string; body: string; tone: StatusTone }
> = {
  booked: {
    icon: "check",
    title: "ชำระเงินแล้ว รอยืนยัน",
    body: "ทีมงานจะตรวจสอบและยืนยันคิวของคุณเร็วๆ นี้",
    tone: "success",
  },
  confirmed: {
    icon: "check",
    title: "ยืนยันการจองแล้ว",
    body: "ทีมงานได้ยืนยันคิวของคุณแล้ว",
    tone: "success",
  },
  cancelled: {
    icon: "cross",
    title: "คิวถูกยกเลิกแล้ว",
    body: "กรุณาจองคิวใหม่หากต้องการนัดหมาย",
    tone: "neutral",
  },
  expired: {
    icon: "clock",
    title: "คิวหมดอายุแล้ว",
    body: "ไม่ได้ชำระภายในเวลาที่กำหนด กรุณาจองคิวใหม่",
    tone: "warn",
  },
  completed: {
    icon: "star",
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

export function CheckoutIcon({ name }: { name: CheckoutIconName }) {
  let shape: React.ReactNode;
  switch (name) {
    case "card":
      shape = <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="M3.5 10h17M7 14.5h3" /></>;
      break;
    case "check":
      shape = <path d="m5.5 12.5 4.2 4.2 8.8-9.4" />;
      break;
    case "clock":
      shape = <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>;
      break;
    case "cross":
      shape = <path d="m7.5 7.5 9 9m0-9-9 9" />;
      break;
    case "info":
      shape = <><circle cx="12" cy="12" r="8.5" /><path d="M12 10.5v5M12 7.5h.01" /></>;
      break;
    case "search":
      shape = <><circle cx="10.8" cy="10.8" r="5.8" /><path d="m15.2 15.2 4.3 4.3" /></>;
      break;
    case "star":
      shape = <path d="m12 4.3 2.3 4.6 5.1.7-3.7 3.6.9 5.1-4.6-2.4-4.6 2.4.9-5.1-3.7-3.6 5.1-.7z" />;
      break;
    case "warning":
      shape = <><path d="m12 4 8.2 15H3.8z" /><path d="M12 9v4M12 16h.01" /></>;
      break;
  }

  return (
    <svg
      className="checkout-icon"
      viewBox="0 0 24 24"
      focusable="false"
      aria-hidden="true"
    >
      {shape}
    </svg>
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
