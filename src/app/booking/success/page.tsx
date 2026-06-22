import Link from "next/link";

export const dynamic = "force-dynamic";

// Shows the reference + queue + slot. Only non-PII values arrive via query.
export default async function BookingSuccess({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string; q?: string; date?: string; slot?: string }>;
}) {
  const { ref, q, date, slot } = await searchParams;

  return (
    <main className="mx-auto min-h-screen max-w-md px-5 py-12">
      <div className="rounded-2xl border border-rose-100 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-rose-100 text-3xl">
          ✓
        </div>
        <h1 className="text-xl font-bold text-rose-700">จองคิวสำเร็จ</h1>
        <p className="mt-1 text-sm text-gray-500">
          กรุณาชำระเงินภายใน 60 นาที เพื่อยืนยันคิว
        </p>

        <dl className="mt-6 space-y-3 text-left">
          <Row label="เลขอ้างอิง" value={ref ?? "-"} strong />
          <Row label="วันที่" value={date ?? "-"} />
          <Row label="รอบเวลา" value={slot ?? "-"} />
          <Row label="ลำดับคิวในรอบ" value={q ?? "-"} />
          <Row label="สถานะ" value="รอชำระเงิน" />
        </dl>

        <p className="mt-6 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
          ทีมงานจะติดต่อกลับเพื่อยืนยันการนัดหมาย หากไม่ชำระภายในเวลาที่กำหนด
          คิวจะถูกยกเลิกอัตโนมัติและคืนที่ว่างให้รอบนั้น
        </p>

        <Link
          href="/booking"
          className="mt-6 inline-block text-sm text-rose-600 hover:underline"
        >
          จองคิวเพิ่ม
        </Link>
      </div>
    </main>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-gray-100 pb-2">
      <dt className="text-sm text-gray-500">{label}</dt>
      <dd className={strong ? "text-lg font-bold tracking-wide" : "text-sm"}>
        {value}
      </dd>
    </div>
  );
}
