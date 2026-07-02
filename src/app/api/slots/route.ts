import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getAvailableSlots, recordRateHit } from "@/lib/booking-core";
import { clientIp } from "@/lib/client-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Rate limit: 30 requests / 5 min per hashed IP. Generous for a human
// browsing dates on /booking; blocks scripted hammering of a public endpoint
// that hits the database on every call.
const RATE_LIMIT = 30;
const RATE_WINDOW_SECONDS = 5 * 60;

// GET /api/slots?date=YYYY-MM-DD — open slots for the date with seats left.
export async function GET(req: Request) {
  const date = new URL(req.url).searchParams.get("date") ?? "";
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }

  // Same fail-closed rate-limit pattern as POST /api/bookings.
  const secret = process.env.BOOKING_RATE_LIMIT_SECRET;
  if (!secret) {
    console.error("[slots] BOOKING_RATE_LIMIT_SECRET is not configured");
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  const bucket = crypto
    .createHmac("sha256", secret)
    .update(`slots:${clientIp(req)}`)
    .digest("hex");
  const hits = await recordRateHit(bucket, RATE_WINDOW_SECONDS);
  if (hits < 0) {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  if (hits > RATE_LIMIT) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const slots = await getAvailableSlots(date);
  return NextResponse.json({
    slots: slots.map((s) => ({
      id: s.id,
      label: s.label,
      startTime: s.start_time,
      endTime: s.end_time,
      remaining: s.remaining,
      capacity: s.capacity,
    })),
  });
}
