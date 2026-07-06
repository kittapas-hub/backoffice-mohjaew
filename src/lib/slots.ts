// Pure slot/capacity rules — NO imports, so it runs under `node --strip-types`
// in tests and stays the single source of truth shared with the SQL functions
// in 0002_booking_slots.sql. Keep the occupancy rule here identical to the SQL.

export const ALLOWED_SOURCES = [
  "line",
  "website",
  "facebook",
  "instagram",
] as const;
export type BookingSource = (typeof ALLOWED_SOURCES)[number];

export function isAllowedSource(s: unknown): s is BookingSource {
  return (
    typeof s === "string" && (ALLOWED_SOURCES as readonly string[]).includes(s)
  );
}

export type BookingLike = {
  status: string;
  hold_expires_at?: string | null;
  queue_number?: number | null;
};

// Does this booking currently occupy a seat? Mirrors create_booking()'s count.
// 'booked' = payment received; always occupies (like confirmed/completed).
export function occupies(b: BookingLike, now: number = Date.now()): boolean {
  if (b.status === "confirmed" || b.status === "completed" || b.status === "booked") return true;
  if (b.status === "pending_payment" && b.hold_expires_at) {
    return new Date(b.hold_expires_at).getTime() > now;
  }
  return false;
}

export function countOccupied(
  bookings: BookingLike[],
  now: number = Date.now(),
): number {
  return bookings.reduce((n, b) => n + (occupies(b, now) ? 1 : 0), 0);
}

export function groupBookingsBySlot<
  T extends BookingLike & { slot_id: string | null },
>(bookings: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const booking of bookings) {
    if (!booking.slot_id) continue;
    const list = grouped.get(booking.slot_id) ?? [];
    list.push(booking);
    grouped.set(booking.slot_id, list);
  }
  return grouped;
}

export function remainingSeats(
  capacity: number,
  bookings: BookingLike[],
  now: number = Date.now(),
): number {
  return Math.max(capacity - countOccupied(bookings, now), 0);
}

export function isSlotFull(
  capacity: number,
  bookings: BookingLike[],
  now: number = Date.now(),
): boolean {
  return remainingSeats(capacity, bookings, now) <= 0;
}

// Mirrors transition_slot_booking() in 0008_reject_expired_hold_confirmation.sql.
// A live pending_payment hold already occupies its seat, so confirming it
// never needs an extra seat (succeeds even when the slot is exactly full). A
// lapsed hold can NEVER be confirmed — not even if the slot has room —
// because the hold deadline is the customer-facing promise that payment
// instructions are still valid; admins must not confirm a payment against an
// expired hold, they must ask the customer to book again.
export function canConfirm(
  self: BookingLike,
  others: BookingLike[],
  capacity: number,
  now: number = Date.now(),
): { ok: true } | { ok: false; error: "not_confirmable" | "slot_full" | "hold_expired" } {
  if (self.status === "confirmed") return { ok: true }; // idempotent
  if (self.status === "cancelled" || self.status === "expired") {
    return { ok: false, error: "not_confirmable" };
  }
  if (occupies(self, now)) return { ok: true }; // already holds a seat
  if (self.status === "pending_payment") {
    return { ok: false, error: "hold_expired" };
  }
  if (countOccupied(others, now) >= capacity) {
    return { ok: false, error: "slot_full" };
  }
  return { ok: true };
}

// Allowed slot-booking state transitions. Mirrors transition_slot_booking()
// in 0005_payment_foundation.sql. Terminal states map to [].
// Used by the admin UI to render only valid actions and by tests.
// Note: pending_payment -> booked is NOT here; that path is payment-only.
export const SLOT_TRANSITIONS: Record<string, string[]> = {
  pending_payment: ["confirmed", "cancelled", "expired"],
  booked: ["confirmed", "cancelled"],
  confirmed: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  expired: [],
};

export function canTransition(from: string, to: string): boolean {
  return (SLOT_TRANSITIONS[from] ?? []).includes(to);
}

// Monotonic per-slot queue number (never reused). Mirrors max+1 in SQL.
export function nextQueueNumber(bookings: BookingLike[]): number {
  return (
    bookings.reduce((m, b) => Math.max(m, b.queue_number ?? 0), 0) + 1
  );
}

// ---- Public booking input validation (shared by API) ----------------------
export type BookingInput = {
  slotId: string;
  source: string;
  nickname: string;
  phone: string;
  consultationTopic: string;
  birthDateText: string;
};

export type ValidatedInput = Omit<BookingInput, "source"> & {
  source: BookingSource;
};

// Default payment hold. Overridable per environment via BOOKING_HOLD_MINUTES
// (parsed by paymentHoldMinutes below). Trade-off: a short hold frees seats
// fast but risks "paid but expired" — the customer bank-transfers near the
// deadline, the hold lapses before the slip is seen, the seat is resold and
// the expired booking has no valid transition back. With manual bank-transfer
// verification 30 minutes is the safer default; shorten only once payment
// confirmation is instant (provider webhook).
export const PAYMENT_HOLD_MINUTES = 30;
const HOLD_MINUTES_MIN = 5;
const HOLD_MINUTES_MAX = 120;

// Pure parse of the BOOKING_HOLD_MINUTES env value. Non-numeric/absent input
// falls back to the default; numeric input is clamped to a sane range so a
// typo (e.g. "3000") can't create day-long phantom holds or sub-minute churn.
export function paymentHoldMinutes(raw?: string | null): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return PAYMENT_HOLD_MINUTES;
  return Math.min(HOLD_MINUTES_MAX, Math.max(HOLD_MINUTES_MIN, Math.trunc(n)));
}

export const DEFAULT_CONSULTATION_TOPIC = "ไม่ได้ระบุหัวข้อพิเศษ";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateBookingInput(
  raw: Partial<BookingInput>,
):
  | { ok: true; value: ValidatedInput }
  | { ok: false; error: "invalid_input" | "invalid_source" } {
  const slotId = String(raw.slotId ?? "").trim();
  const nickname = String(raw.nickname ?? "").trim();
  const phone = String(raw.phone ?? "").trim();
  const consultationTopic =
    String(raw.consultationTopic ?? "").trim() || DEFAULT_CONSULTATION_TOPIC;
  const birthDateText = String(raw.birthDateText ?? "").trim();

  if (!isAllowedSource(raw.source)) return { ok: false, error: "invalid_source" };
  if (!UUID_RE.test(slotId)) return { ok: false, error: "invalid_input" };
  if (!nickname || !birthDateText) {
    return { ok: false, error: "invalid_input" };
  }
  // Phone: 9–15 digits after stripping common separators.
  const digits = phone.replace(/[\s\-()+]/g, "");
  if (!/^\d{9,15}$/.test(digits)) return { ok: false, error: "invalid_input" };

  return {
    ok: true,
    value: {
      slotId,
      source: raw.source,
      nickname,
      phone: digits,
      consultationTopic,
      birthDateText,
    },
  };
}
