import { NextResponse } from "next/server";
import { getBookingByToken } from "@/lib/booking-core";

export const dynamic = "force-dynamic";

// Minimal polling endpoint for the booking success page's pending_payment
// live refresh. Takes only the existing opaque success token (the same one
// /booking/success already uses) — there is no raw-booking-id lookup path;
// getBookingByToken validates the token's UUID shape and selects only
// non-PII columns. Returns only the fields the page needs to detect a
// status change and re-render.
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  const booking = await getBookingByToken(token);
  if (!booking) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ status: booking.status, reference: booking.reference });
}
