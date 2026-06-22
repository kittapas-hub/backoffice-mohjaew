import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  createSlotBooking,
  recordRateHit,
  type CreateBookingError,
} from "@/lib/booking-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rate limit: 5 requests / 15 min per client (by hashed IP).
const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 15 * 60;

// Customer-facing messages for each failure mode.
const MESSAGES: Record<CreateBookingError, string> = {
  invalid_input: "ข้อมูลไม่ครบหรือไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง",
  invalid_source: "ช่องทางการจองไม่ถูกต้อง",
  slot_not_found: "ไม่พบรอบเวลาที่เลือก",
  slot_closed: "รอบเวลานี้ปิดรับจองแล้ว",
  slot_full: "รอบเวลานี้เต็มแล้ว กรุณาเลือกรอบอื่น",
  duplicate_booking: "เบอร์นี้มีการจองในรอบนี้อยู่แล้ว ไม่สามารถจองซ้ำได้",
  server_error: "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง",
};

const STATUS_CODE: Record<CreateBookingError, number> = {
  invalid_input: 400,
  invalid_source: 400,
  slot_not_found: 404,
  slot_closed: 409,
  slot_full: 409,
  duplicate_booking: 409,
  server_error: 500,
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

// POST /api/bookings — central creation path for all channels.
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_input", message: MESSAGES.invalid_input },
      { status: 400 },
    );
  }

  // Honeypot: real users never fill this hidden field; bots do.
  if (String(body.company ?? "").trim() !== "") {
    return NextResponse.json(
      { error: "invalid_input", message: MESSAGES.invalid_input },
      { status: 400 },
    );
  }

  // Idempotency key (header preferred, body fallback) — must be a UUID.
  const idempotencyKey =
    req.headers.get("idempotency-key") ?? String(body.idempotencyKey ?? "");
  if (!UUID_RE.test(idempotencyKey)) {
    return NextResponse.json(
      { error: "invalid_input", message: "ต้องมี Idempotency-Key ที่ถูกต้อง" },
      { status: 400 },
    );
  }

  // Rate limit (cross-instance, DB-backed). Never silently disabled.
  const secret = process.env.BOOKING_RATE_LIMIT_SECRET;
  if (!secret) {
    console.error("BOOKING_RATE_LIMIT_SECRET is not configured");
    return NextResponse.json(
      { error: "server_error", message: "ระบบยังไม่พร้อมใช้งาน (config)" },
      { status: 500 },
    );
  }
  const bucket = crypto
    .createHmac("sha256", secret)
    .update(`bookings:${clientIp(req)}`)
    .digest("hex");
  const hits = await recordRateHit(bucket, RATE_WINDOW_SECONDS);
  if (hits < 0) {
    return NextResponse.json(
      { error: "server_error", message: MESSAGES.server_error },
      { status: 500 },
    );
  }
  if (hits > RATE_LIMIT) {
    return NextResponse.json(
      { error: "rate_limited", message: "คุณทำรายการบ่อยเกินไป กรุณาลองใหม่ภายหลัง" },
      { status: 429 },
    );
  }

  // Only whitelisted fields reach the core; status/queue/hold/capacity are
  // always set server-side by create_booking — never from the client.
  const result = await createSlotBooking(
    {
      slotId: String(body.slotId ?? ""),
      source: String(body.source ?? ""),
      nickname: String(body.nickname ?? ""),
      phone: String(body.phone ?? ""),
      consultationTopic: String(body.consultationTopic ?? ""),
      birthDateText: String(body.birthDateText ?? ""),
    },
    { idempotencyKey },
  );

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: MESSAGES[result.error] },
      { status: STATUS_CODE[result.error] },
    );
  }

  const b = result.booking;
  return NextResponse.json({
    // token = full booking UUID (122-bit entropy) — used by /booking/success
    // to look up booking data from the DB without trusting query-string params.
    token: b.id,
    // Short human-readable reference (first 8 hex chars, still non-PII).
    reference: b.id.slice(0, 8).toUpperCase(),
    queueNumber: b.queue_number,
    status: b.status,
    slotLabel: b.preferred_time,
    holdExpiresAt: b.hold_expires_at,
  });
}
