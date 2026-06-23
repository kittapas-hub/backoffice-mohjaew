import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { updateStatus, transitionSlotBooking } from "../../actions";
import { STATUS_LABEL, StatusBadge } from "../../status";
import { SLOT_TRANSITIONS } from "@/lib/slots";
import { TRANSITION_ERROR_TH, type TransitionErrorCode } from "@/lib/confirm-error";
import { getPaymentOrdersForBooking } from "@/lib/payments/payment-orders";
import type { PaymentOrder } from "@/lib/payments/types";

// Legacy/manual (non-slot) bookings can be set to these directly.
const LEGACY_STATUSES = ["pending", "contacted", "confirmed", "cancelled"] as const;
const TRANSITION_LABEL: Record<string, string> = {
  confirmed: "ยืนยัน",
  completed: "เสร็จสิ้น",
  cancelled: "ยกเลิก",
  expired: "หมดเวลา",
};

export const dynamic = "force-dynamic";

export default async function BookingDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { error: errorParam } = await searchParams;
  const confirmError =
    errorParam && errorParam in TRANSITION_ERROR_TH
      ? TRANSITION_ERROR_TH[errorParam as TransitionErrorCode]
      : null;

  const db = supabaseAdmin();
  const { data: booking } = await db
    .from("bookings")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!booking) notFound();

  const [{ data: images }, paymentOrders] = await Promise.all([
    db.from("booking_images").select("storage_path").eq("booking_id", id),
    getPaymentOrdersForBooking(id),
  ]);

  // Short-lived signed URLs for the private bucket (5 minutes).
  const signedUrls: string[] = [];
  for (const img of images ?? []) {
    const { data } = await db.storage
      .from("booking-faces")
      .createSignedUrl(img.storage_path, 300);
    if (data?.signedUrl) signedUrls.push(data.signedUrl);
  }

  const latestOrder: PaymentOrder | undefined = paymentOrders[0];

  return (
    <div className="max-w-2xl">
      <Link href="/admin" className="text-sm text-gray-500 hover:text-gray-900">
        ← กลับ
      </Link>

      <div className="mt-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">{booking.nickname}</h1>
        <StatusBadge status={booking.status} />
      </div>

      {confirmError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {confirmError}
        </div>
      )}

      <dl className="mt-6 grid grid-cols-1 gap-x-6 gap-y-4 rounded-lg border border-gray-200 bg-white p-6 sm:grid-cols-2">
        <Field label="ชื่อเล่น" value={booking.nickname} />
        <Field label="ชื่อ LINE" value={booking.line_display_name} />
        <Field label="เบอร์โทร" value={booking.phone} />
        <Field label="วันเกิด" value={booking.birth_date_text} />
        <Field label="หัวข้อที่ปรึกษา" value={booking.consultation_topic} />
        <Field label="ช่วงเวลาที่สะดวก" value={booking.preferred_time} />
        <Field
          label="สร้างเมื่อ"
          value={new Date(booking.created_at).toLocaleString("th-TH")}
        />
      </dl>

      {latestOrder && (
        <section className="mt-6">
          <h2 className="mb-2 font-semibold">ข้อมูลการชำระเงิน</h2>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 rounded-lg border border-gray-200 bg-white p-6 sm:grid-cols-2">
            <Field
              label="สถานะชำระเงิน"
              value={
                latestOrder.status === "manual_review"
                  ? "⚠️ ต้องตรวจสอบด้วยตนเอง"
                  : latestOrder.status === "paid"
                    ? "✅ ชำระแล้ว"
                    : latestOrder.status
              }
            />
            <Field
              label="จำนวนเงิน"
              value={`${(latestOrder.amount_satang / 100).toLocaleString("th-TH")} บาท`}
            />
            <Field label="ช่องทางชำระ" value={latestOrder.provider} />
            <Field
              label="สร้างออเดอร์"
              value={new Date(latestOrder.created_at).toLocaleString("th-TH")}
            />
            <Field
              label="หมดอายุ"
              value={new Date(latestOrder.expires_at).toLocaleString("th-TH")}
            />
            {latestOrder.paid_at && (
              <Field
                label="ชำระเมื่อ"
                value={new Date(latestOrder.paid_at).toLocaleString("th-TH")}
              />
            )}
            {latestOrder.amount_received_satang != null && (
              <Field
                label="รับจริง"
                value={`${(latestOrder.amount_received_satang / 100).toLocaleString("th-TH")} บาท`}
              />
            )}
          </dl>
          {latestOrder.status === "manual_review" && (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              ⚠️ ออเดอร์นี้ต้องได้รับการตรวจสอบด้วยตนเอง (ยอดไม่ตรง หรือจองหมดอายุก่อนรับเงิน)
            </p>
          )}
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-2 font-semibold">รูปหน้าตรง</h2>
        {signedUrls.length === 0 ? (
          <p className="text-sm text-gray-400">ไม่มีรูป</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {signedUrls.map((url) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={url}
                src={url}
                alt="รูปหน้าตรง"
                className="h-48 w-48 rounded-lg border border-gray-200 object-cover"
              />
            ))}
          </div>
        )}
      </section>

      <section className="mt-6">
        <h2 className="mb-2 font-semibold">เปลี่ยนสถานะ</h2>
        {booking.slot_id ? (
          // Slot booking: only valid transitions, via the state machine.
          <div className="flex flex-wrap gap-2">
            {(SLOT_TRANSITIONS[booking.status] ?? []).map((to) => (
              <form key={to} action={transitionSlotBooking}>
                <input type="hidden" name="bookingId" value={booking.id} />
                <input type="hidden" name="to" value={to} />
                <input
                  type="hidden"
                  name="redirectTo"
                  value={`/admin/bookings/${booking.id}`}
                />
                <button className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50">
                  {TRANSITION_LABEL[to] ?? to}
                </button>
              </form>
            ))}
            {(SLOT_TRANSITIONS[booking.status] ?? []).length === 0 && (
              <p className="text-sm text-gray-400">สถานะนี้สิ้นสุดแล้ว</p>
            )}
          </div>
        ) : (
          // Legacy/manual booking (no slot).
          <div>
            <p className="mb-2 text-xs text-amber-700">
              รายการนี้เป็นการจองแบบเดิม (ไม่ผูกกับรอบเวลา)
            </p>
            <form action={updateStatus} className="flex items-center gap-3">
              <input type="hidden" name="id" value={booking.id} />
              <select
                name="status"
                defaultValue={booking.status}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                {LEGACY_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
              <button className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white">
                บันทึก
              </button>
            </form>
          </div>
        )}
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm">{value ?? "-"}</dd>
    </div>
  );
}
