import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { updateStatus } from "../../actions";
import { STATUSES, STATUS_LABEL, StatusBadge } from "../../status";

export const dynamic = "force-dynamic";

export default async function BookingDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;

  const db = supabaseAdmin();
  const { data: booking } = await db
    .from("bookings")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!booking) notFound();

  const { data: images } = await db
    .from("booking_images")
    .select("storage_path")
    .eq("booking_id", id);

  // Short-lived signed URLs for the private bucket (5 minutes).
  const signedUrls: string[] = [];
  for (const img of images ?? []) {
    const { data } = await db.storage
      .from("booking-faces")
      .createSignedUrl(img.storage_path, 300);
    if (data?.signedUrl) signedUrls.push(data.signedUrl);
  }

  return (
    <div className="max-w-2xl">
      <Link href="/admin" className="text-sm text-gray-500 hover:text-gray-900">
        ← กลับ
      </Link>

      <div className="mt-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">{booking.nickname}</h1>
        <StatusBadge status={booking.status} />
      </div>

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
        <form action={updateStatus} className="flex items-center gap-3">
          <input type="hidden" name="id" value={booking.id} />
          <select
            name="status"
            defaultValue={booking.status}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <button className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white">
            บันทึก
          </button>
        </form>
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
