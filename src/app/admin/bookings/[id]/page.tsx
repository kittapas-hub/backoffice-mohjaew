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
import { ConfirmPaymentButton } from "../../_components/ConfirmPaymentButton";

// Legacy/manual (non-slot) bookings can be set to these directly.
const LEGACY_STATUSES = ["pending", "contacted", "confirmed", "cancelled"] as const;
const UNSCHEDULED_LINE_STATUSES = ["pending", "contacted", "cancelled"] as const;
const TRANSITION_LABEL: Record<string, string> = {
  confirmed: "ยืนยัน",
  completed: "เสร็จสิ้น",
  cancelled: "ยกเลิก",
  expired: "หมดเวลา",
};

// Full Thai labels for every payment_order status so staff never see a raw
// enum. Covers the automatic-slip lifecycle (created/pending -> paid, or
// manual_review) plus expiry/failure.
const PAYMENT_STATUS_LABEL: Record<string, string> = {
  created: "⏳ รอชำระเงิน",
  pending: "⏳ รอชำระเงิน",
  paid: "✅ ชำระแล้ว (ตรวจสอบอัตโนมัติ)",
  manual_review: "⚠️ ต้องตรวจสอบด้วยตนเอง",
  expired: "⏰ หมดอายุ",
  failed: "❌ ไม่สำเร็จ",
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
  const [{ data: booking }, { data: images }, paymentOrders] = await Promise.all([
    db.from("bookings").select("*").eq("id", id).maybeSingle(),
    db.from("booking_images").select("storage_path").eq("booking_id", id),
    getPaymentOrdersForBooking(id),
  ]);
  if (!booking) notFound();

  // Short-lived signed URLs for the private bucket (5 minutes).
  const signedUrlResults = await Promise.all((images ?? []).map((img) => db.storage.from("booking-faces").createSignedUrl(img.storage_path, 300)));
  const signedUrls = signedUrlResults.flatMap(({ data }) => data?.signedUrl ? [data.signedUrl] : []);

  const latestOrder: PaymentOrder | undefined = paymentOrders[0];
  const isUnscheduledLine = booking.source === "line" && !booking.slot_id;

  // Payment-evidence state: is the verified slip image retained, or did
  // evidence storage fail (durable follow-up record)? Tolerant of the
  // evidence tables not yet existing in an environment — a query error just
  // leaves the indicator unknown rather than breaking the whole detail page.
  let evidenceKnown = false;
  let slipImageCount = 0;
  let evidenceFailureCount = 0;
  if (latestOrder) {
    const [imgRes, failRes] = await Promise.all([
      db
        .from("payment_slip_images")
        .select("id", { count: "exact", head: true })
        .eq("payment_order_id", latestOrder.id),
      db
        .from("payment_slip_evidence_failures")
        .select("id", { count: "exact", head: true })
        .eq("payment_order_id", latestOrder.id),
    ]);
    if (!imgRes.error && !failRes.error) {
      evidenceKnown = true;
      slipImageCount = imgRes.count ?? 0;
      evidenceFailureCount = failRes.count ?? 0;
    }
  }

  return (
    <div className="max-w-5xl">
      <Link href="/admin" className="text-sm text-gray-500 hover:text-gray-900">
        ← กลับ
      </Link>

      <div className="admin-page-header mt-4">
        <div><p className="admin-eyebrow">Booking #{booking.id.slice(0, 8).toUpperCase()}</p><h1 className="admin-title">{booking.nickname}</h1><p className="admin-description">รายละเอียดลูกค้า การชำระเงิน และสถานะคิว</p></div>
        <div className="text-right">
          <StatusBadge status={booking.status} />
          {isUnscheduledLine && (
            <div className="mt-1 text-xs text-amber-700">
              รอตรวจสอบ · ยังไม่เลือกเวลา
            </div>
          )}
        </div>
      </div>

      {confirmError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {confirmError}
        </div>
      )}

      <dl className="admin-card mt-6 grid grid-cols-1 gap-x-8 gap-y-5 p-6 sm:grid-cols-2 lg:grid-cols-3">
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
          <dl className="admin-card grid grid-cols-1 gap-x-6 gap-y-4 p-6 sm:grid-cols-2">
            <Field
              label="สถานะชำระเงิน"
              value={PAYMENT_STATUS_LABEL[latestOrder.status] ?? latestOrder.status}
            />
            {evidenceKnown && (
              <Field
                label="หลักฐานสลิป"
                value={
                  slipImageCount > 0
                    ? "✅ มีสลิปบันทึกในระบบ"
                    : evidenceFailureCount > 0
                      ? "⚠️ บันทึกสลิปไม่สำเร็จ — ต้องติดตาม"
                      : "— ไม่มีสลิปอัตโนมัติ"
                }
              />
            )}
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

      <section className="admin-card mt-6 p-6">
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

      <section className="admin-card mt-6 p-6">
        <h2 className="mb-2 font-semibold">เปลี่ยนสถานะ</h2>
        {booking.slot_id ? (
          // Slot booking: only valid transitions, via the state machine.
          <div className="flex flex-wrap gap-2">
            {(SLOT_TRANSITIONS[booking.status] ?? []).map((to) =>
              // pending_payment -> confirmed must go through the same
              // hardened confirmPayment() path as /admin/day, which
              // fast-fails on an expired hold before ever calling the RPC.
              // The generic transitionSlotBooking form below has no such
              // check and relies solely on the DB-level guard added in
              // 0008_reject_expired_hold_confirmation.sql, which is not yet
              // applied to production — so this specific transition must
              // never go through the generic form.
              booking.status === "pending_payment" && to === "confirmed" ? (
                <ConfirmPaymentButton
                  key={to}
                  bookingId={booking.id}
                  nickname={booking.nickname}
                  phone={booking.phone}
                  slotInfo={null}
                  refCode={booking.id.slice(0, 8).toUpperCase()}
                  redirectTo={`/admin/bookings/${booking.id}`}
                  verifiedClaimAvailable={latestOrder?.status === "manual_review"}
                />
              ) : (
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
              ),
            )}
            {(SLOT_TRANSITIONS[booking.status] ?? []).length === 0 && (
              <p className="text-sm text-gray-400">สถานะนี้สิ้นสุดแล้ว</p>
            )}
          </div>
        ) : (
          // Legacy/manual booking (no slot).
          <div>
            <p className="mb-2 text-xs text-amber-700">
              {isUnscheduledLine
                ? "คำขอจาก LINE นี้ยังไม่ใช่คิวที่จองจริง ต้องให้ลูกค้าเลือกรอบผ่านหน้าจองก่อน"
                : "รายการนี้เป็นการจองแบบเดิม (ไม่ผูกกับรอบเวลา)"}
            </p>
            <form action={updateStatus} className="flex items-center gap-3">
              <input type="hidden" name="id" value={booking.id} />
              <select
                name="status"
                defaultValue={booking.status}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                {(isUnscheduledLine
                  ? UNSCHEDULED_LINE_STATUSES
                  : LEGACY_STATUSES
                ).map((s) => (
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
      <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-gray-900">{value ?? "-"}</dd>
    </div>
  );
}
