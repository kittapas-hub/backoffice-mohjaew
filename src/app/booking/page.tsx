import { isAllowedSource, paymentHoldMinutes } from "@/lib/slots";
import BookingForm from "./BookingForm";

export const dynamic = "force-dynamic";

// Source comes from the link the channel uses, e.g. /booking?source=line.
// Validated against the allowlist; anything else falls back to "website".
export default async function BookingPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const { source } = await searchParams;
  const validSource = isAllowedSource(source) ? source : "website";
  // Resolved server-side so the displayed minutes always match what
  // createSlotBooking sends to the create_booking RPC.
  const holdMinutes = paymentHoldMinutes(process.env.BOOKING_HOLD_MINUTES);

  return (
    <main className="booking-page">
      <div className="booking-shell">
        <header className="booking-hero">
          <p className="booking-eyebrow">Mohjaew Booking</p>
          <h1 className="booking-title">จองคิวปรึกษาหมอแจว</h1>
          <p className="booking-subtitle">
            เลือกวันและรอบเวลาที่สะดวก จากนั้นกรอกข้อมูลเพื่อถือคิวไว้ {holdMinutes} นาที
            ระหว่างรอการชำระเงิน
          </p>
        </header>
        <BookingForm source={validSource} holdMinutes={holdMinutes} />
      </div>
    </main>
  );
}
