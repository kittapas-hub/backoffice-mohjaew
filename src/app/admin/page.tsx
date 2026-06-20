import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { signOut } from "./actions";
import { STATUSES, STATUS_LABEL, StatusBadge } from "./status";

export const dynamic = "force-dynamic";

export default async function AdminHome({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireAdmin();
  const { status } = await searchParams;
  const filter =
    status && STATUSES.includes(status as (typeof STATUSES)[number]) ? status : null;

  const db = supabaseAdmin();
  let query = db
    .from("bookings")
    .select("id, nickname, phone, consultation_topic, status, created_at")
    .order("created_at", { ascending: false });
  if (filter) query = query.eq("status", filter);
  const { data: bookings } = await query;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">รายการจองคิว</h1>
        <form action={signOut}>
          <button className="text-sm text-gray-500 hover:text-gray-900">
            ออกจากระบบ
          </button>
        </form>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <FilterChip label="ทั้งหมด" href="/admin" active={!filter} />
        {STATUSES.map((s) => (
          <FilterChip
            key={s}
            label={STATUS_LABEL[s]}
            href={`/admin?status=${s}`}
            active={filter === s}
          />
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th className="px-4 py-3">ชื่อเล่น</th>
              <th className="px-4 py-3">โทร</th>
              <th className="px-4 py-3">หัวข้อ</th>
              <th className="px-4 py-3">สถานะ</th>
              <th className="px-4 py-3">วันที่</th>
            </tr>
          </thead>
          <tbody>
            {(bookings ?? []).map((b) => (
              <tr key={b.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3">
                  <Link
                    href={`/admin/bookings/${b.id}`}
                    className="font-medium text-blue-700 hover:underline"
                  >
                    {b.nickname}
                  </Link>
                </td>
                <td className="px-4 py-3">{b.phone}</td>
                <td className="px-4 py-3">{b.consultation_topic}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={b.status} />
                </td>
                <td className="px-4 py-3 text-gray-500">
                  {new Date(b.created_at).toLocaleString("th-TH")}
                </td>
              </tr>
            ))}
            {(!bookings || bookings.length === 0) && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  ยังไม่มีรายการ
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FilterChip({
  label,
  href,
  active,
}: {
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-sm ${
        active
          ? "border-gray-900 bg-gray-900 text-white"
          : "border-gray-300 bg-white text-gray-600 hover:border-gray-400"
      }`}
    >
      {label}
    </Link>
  );
}
