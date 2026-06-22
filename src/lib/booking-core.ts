// Central booking core. Every channel (website now; LINE/FB/IG later) creates
// slot bookings through createSlotBooking — one capacity-safe path. The real
// overbooking guard lives in the Postgres create_booking() function (row lock);
// this layer validates input, maps errors, and fires the team notification.
import { supabaseAdmin } from "@/lib/supabase/admin";
import { APP_URL } from "@/lib/env";
import { notifyTeamSafe } from "@/lib/line";
import { validateBookingInput, type BookingInput } from "@/lib/slots";

export type CreateBookingError =
  | "invalid_input"
  | "invalid_source"
  | "slot_not_found"
  | "slot_closed"
  | "slot_full"
  | "duplicate_booking"
  | "server_error";

export type CreatedBooking = {
  id: string;
  queue_number: number;
  status: string;
  hold_expires_at: string | null;
  preferred_time: string;
  slot_id: string;
  nickname: string;
  phone: string;
  consultation_topic: string;
  source: string;
};

const KNOWN_ERRORS: CreateBookingError[] = [
  "invalid_input",
  "invalid_source",
  "slot_not_found",
  "slot_closed",
  "slot_full",
  "duplicate_booking",
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createSlotBooking(
  raw: Partial<BookingInput>,
  opts: { idempotencyKey: string },
): Promise<
  { ok: true; booking: CreatedBooking } | { ok: false; error: CreateBookingError }
> {
  if (!UUID_RE.test(opts.idempotencyKey)) {
    return { ok: false, error: "invalid_input" };
  }
  const valid = validateBookingInput(raw);
  if (!valid.ok) return { ok: false, error: valid.error };
  const v = valid.value;

  const db = supabaseAdmin();
  const { data, error } = await db.rpc("create_booking", {
    p_slot_id: v.slotId,
    p_source: v.source,
    p_nickname: v.nickname,
    p_phone: v.phone,
    p_consultation_topic: v.consultationTopic,
    p_birth_date_text: v.birthDateText,
    p_idempotency_key: opts.idempotencyKey,
  });

  if (error) {
    const matched = KNOWN_ERRORS.find((e) => error.message?.includes(e));
    if (matched) return { ok: false, error: matched };
    console.error("create_booking failed", error);
    return { ok: false, error: "server_error" };
  }

  const booking = (Array.isArray(data) ? data[0] : data) as CreatedBooking;

  // Fire-and-await team notify (non-fatal — must never block the booking).
  await sendTeamNotify(booking, v.birthDateText);

  return { ok: true, booking };
}

async function sendTeamNotify(b: CreatedBooking, birthDateText: string) {
  const base = APP_URL || "";
  const link = base ? `${base}/admin/bookings/${b.id}` : `/admin/bookings/${b.id}`;
  const text = [
    "📥 คำขอจองคิวใหม่ (เว็บ/ช่องทางออนไลน์)",
    "",
    `วันรอบ/เวลา: ${b.preferred_time}`,
    `ลำดับคิว: ${b.queue_number}`,
    `ชื่อ: ${b.nickname}`,
    `โทร: ${b.phone}`,
    `หัวข้อ: ${b.consultation_topic}`,
    `วันเกิด: ${birthDateText}`,
    `ช่องทาง: ${b.source}`,
    "สถานะ: รอชำระเงิน (hold 60 นาที)",
    `Backoffice: ${link}`,
  ].join("\n");
  await notifyTeamSafe(text);
}

export type BookingTokenData = {
  reference: string;       // first 8 chars of id, uppercase (display only)
  status: string;
  queueNumber: number | null;
  holdExpiresAt: string | null;
  slotLabel: string | null;   // bookings.preferred_time
  bookingDate: string | null; // booking_slots.booking_date (YYYY-MM-DD)
};

/** Looks up non-PII booking data by the full booking UUID (token).
 *  Selects only id, status, queue_number, hold_expires_at, preferred_time, and
 *  the related slot's booking_date — no name / phone / birth date returned. */
export async function getBookingByToken(
  token: string,
): Promise<BookingTokenData | null> {
  if (!UUID_RE.test(token)) return null;

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("bookings")
    .select(
      "id, status, queue_number, hold_expires_at, preferred_time, booking_slots(booking_date)",
    )
    .eq("id", token)
    .single();

  if (error || !data) return null;

  const row = data as {
    id: string;
    status: string;
    queue_number: number | null;
    hold_expires_at: string | null;
    preferred_time: string | null;
    booking_slots: { booking_date: string } | { booking_date: string }[] | null;
  };

  const slotRow = Array.isArray(row.booking_slots)
    ? row.booking_slots[0]
    : row.booking_slots;

  return {
    reference: row.id.slice(0, 8).toUpperCase(),
    status: row.status,
    queueNumber: row.queue_number,
    holdExpiresAt: row.hold_expires_at,
    slotLabel: row.preferred_time,
    bookingDate: slotRow?.booking_date ?? null,
  };
}

export type OpenSlot = {
  id: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  label: string;
  capacity: number;
  occupied: number;
  remaining: number;
};

// DB-backed rate limit (cross-instance). Returns the hit count in the window,
// or -1 on backend error so the caller can fail closed rather than silently
// disabling the limit.
export async function recordRateHit(
  bucket: string,
  windowSeconds: number,
): Promise<number> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("record_rate_hit", {
    p_bucket: bucket,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    console.error("record_rate_hit failed", error);
    return -1;
  }
  return (data as number) ?? -1;
}

// Open slots for a date that still have seats. Clears stale holds first
// (the SQL function calls expire_pending_bookings) so counts aren't stale.
export async function getAvailableSlots(date: string): Promise<OpenSlot[]> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("get_open_slots", { p_date: date });
  if (error) {
    console.error("get_open_slots failed", error);
    return [];
  }
  return ((data ?? []) as OpenSlot[]).filter((s) => s.remaining > 0);
}
