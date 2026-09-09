// Central booking core. Every channel (website now; LINE/FB/IG later) creates
// slot bookings through createSlotBooking — one capacity-safe path. The real
// overbooking guard lives in the Postgres create_booking() function (row lock);
// this layer validates input and maps errors. Team notifications are emitted only after payment confirmation or when manual review is required.
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  filterCustomerAvailableSlots,
} from "@/lib/slot-seeding";
import {
  paymentHoldMinutes,
  validateBookingInput,
  type BookingInput,
} from "@/lib/slots";

export type CreateBookingError =
  | "invalid_input"
  | "invalid_source"
  | "slot_not_found"
  | "slot_closed"
  | "slot_full"
  | "duplicate_booking"
  | "face_token_expired"
  | "face_token_invalid"
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
  "face_token_expired",
  "face_token_invalid",
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createSlotBooking(
  raw: Partial<BookingInput>,
  opts: { idempotencyKey: string; faceUploadToken?: string },
): Promise<
  { ok: true; booking: CreatedBooking } | { ok: false; error: CreateBookingError }
> {
  if (!UUID_RE.test(opts.idempotencyKey)) {
    return { ok: false, error: "invalid_input" };
  }
  const valid = validateBookingInput(raw);
  if (!valid.ok) return { ok: false, error: valid.error };
  const v = valid.value;
  // The public slot-booking flow requires the face upload to be claimed in
  // the same transaction as the booking. The RPC keeps its parameter
  // optional for legacy/manual callers, but this shared current flow must not
  // let a direct API caller bypass the UI's required face step.
  if (!opts.faceUploadToken || !UUID_RE.test(opts.faceUploadToken)) {
    return { ok: false, error: "face_token_invalid" };
  }
  const logContext = {
    source: v.source,
    slotId: v.slotId,
    attempt: opts.idempotencyKey.slice(0, 8),
  };

  const db = supabaseAdmin();
  const { data, error } = await db.rpc("create_booking", {
    p_slot_id: v.slotId,
    p_source: v.source,
    p_nickname: v.nickname,
    p_phone: v.phone,
    p_consultation_topic: v.consultationTopic,
    p_birth_date_text: v.birthDateText,
    p_hold_minutes: paymentHoldMinutes(process.env.BOOKING_HOLD_MINUTES),
    p_idempotency_key: opts.idempotencyKey,
    p_face_upload_token: opts.faceUploadToken ?? null,
  });

  if (error) {
    const matched = KNOWN_ERRORS.find((e) => error.message?.includes(e));
    if (matched) {
      console.warn("[booking] create rejected", {
        ...logContext,
        reason: matched,
        dbCode: error.code ?? null,
      });
      return { ok: false, error: matched };
    }
    console.error("[booking] create failed", {
      ...logContext,
      dbCode: error.code ?? null,
    });
    return { ok: false, error: "server_error" };
  }

  const booking = (Array.isArray(data) ? data[0] : data) as CreatedBooking;
  if (!booking?.id) {
    console.error("[booking] create returned no record", logContext);
    return { ok: false, error: "server_error" };
  }
  const bookingRef = booking.id.slice(0, 8).toUpperCase();
  console.info("[booking] create succeeded", {
    ...logContext,
    bookingRef,
    status: booking.status,
  });

  return { ok: true, booking };
}

export type BookingTokenData = {
  reference: string;       // first 8 chars of id, uppercase (display only)
  status: string;
  queueNumber: number | null;
  holdExpiresAt: string | null;
  slotLabel: string | null;   // bookings.preferred_time
  bookingDate: string | null; // booking_slots.booking_date (YYYY-MM-DD)
  paymentStatus: string | null; // latest payment order status; "unknown" fails closed
};

/** Looks up non-PII booking data by the full booking UUID (token).
 *  Selects only non-PII booking fields plus the latest payment-order status. */
export async function getBookingByToken(
  token: string,
): Promise<BookingTokenData | null> {
  if (!UUID_RE.test(token)) return null;

  const db = supabaseAdmin();
  const [{ data, error }, { data: paymentOrder, error: paymentError }] = await Promise.all([
    db
      .from("bookings")
      .select(
        "id, status, queue_number, hold_expires_at, preferred_time, booking_slots(booking_date)",
      )
      .eq("id", token)
      .single(),
    db
      .from("payment_orders")
      .select("status")
      .eq("booking_id", token)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

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
    // A payment-status read failure must not look like "no payment order". The
    // success page treats this sentinel as do-not-pay until the next poll can
    // establish whether a slip is already under review.
    paymentStatus: paymentError ? "unknown" : (paymentOrder?.status ?? null),
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

/** Customer-facing filter: seats left, and post-cutover dates show only the
 *  four canonical session windows (never hourly + session together). */
export async function getAvailableSlots(date: string): Promise<OpenSlot[]> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("get_open_slots", { p_date: date });
  if (error) {
    console.error("get_open_slots failed", error);
    return [];
  }
  return filterCustomerAvailableSlots(date, (data ?? []) as OpenSlot[]);
}
