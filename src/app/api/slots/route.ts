import { NextResponse } from "next/server";
import { getAvailableSlots } from "@/lib/booking-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/slots?date=YYYY-MM-DD — open slots for the date with seats left.
export async function GET(req: Request) {
  const date = new URL(req.url).searchParams.get("date") ?? "";
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
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
