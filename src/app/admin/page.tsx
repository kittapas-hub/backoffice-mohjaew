import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { signOut } from "./actions";
import { STATUSES, STATUS_LABEL, StatusBadge } from "./status";
import { TRANSITION_ERROR_TH, type TransitionErrorCode } from "@/lib/confirm-error";
import { ConfirmPaymentButton } from "./_components/ConfirmPaymentButton";
import { SearchForm } from "./_components/SearchForm";
import { sanitizeSearch } from "./search-helpers";

export const dynamic = "force-dynamic";

type BookingRow = {
  id: string;
  nickname: string;
  phone: string;
  consultation_topic: string;
  status: string;
  created_at: string;
  slot_id: string | null;
  source: string | null;
  booking_slots: { booking_date: string; label: string }[] | null;
};

export default async function AdminHome({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; error?: string; success?: string; q?: string }>;
}) {
  await requireAdmin();
  const { status, error: errorParam, success: successParam, q: rawQ } = await searchParams;
  const filter =
    status && STATUSES.includes(status as (typeof STATUSES)[number]) ? status : null;
  const confirmError =
    errorParam && errorParam in TRANSITION_ERROR_TH
      ? TRANSITION_ERROR_TH[errorParam as TransitionErrorCode]
      : null;
  const q = rawQ ? sanitizeSearch(rawQ) : "";

  const db = supabaseAdmin();
  let query = db
    .from("bookings")
    .select(
      "id, nickname, phone, consultation_topic, status, created_at, slot_id, source, booking_slots(booking_date, label)",
    )
    .order("created_at", { ascending: false });
  if (filter) query = query.eq("status", filter);
  if (q) {
    // id prefix match covers reference search: reference = id.slice(0,8).toUpperCase()
    query = query.or(
      `nickname.ilike.%${q}%,phone.ilike.%${q}%,id.ilike.${q}%`,
    );
  }
  const { data, error: listError } = await query;
  if (listError) {
    console.error("[admin-bookings] list query failed", {
      dbCode: listError.code ?? null,
      filtered: Boolean(filter),
      searched: Boolean(q),
    });
  }
  const bookings = (data ?? []) as unknown as BookingRow[];

  // Build URL helpers for filter chips that preserve the current search query.
  const qParam = q ? `&q=${encodeURIComponent(q)}` : "";
  const clearSearchHref = filter ? `/admin?status=${filter}` : "/admin";

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">รายการจองคิว</h1>
        <div className="flex items-center gap-4">
          <Link
            href="/admin/day"
            className="text-sm font-medium text-rose-600 hover:underline"
          >
            ตารางคิวรายวัน
          </Link>
          <form action={signOut}>
            <button className="text-sm text-gray-500 hover:text-gray-900">
              ออกจากระบบ
            </button>
          </form>
        </div>
      </div>

      {confirmError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {confirmError}
        </div>
      )}
      {successParam === "payment_confirmed" && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          ✅ ยืนยันชำระเงินและล็อกคิวเรียบร้อย
        </div>
      )}

      <div className="mb-4">
        <SearchForm
          defaultValue={q}
          status={filter}
          clearHref={clearSearchHref}
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <FilterChip label="ทั้งหมด" href={`/admin${q ? `?q=${encodeURIComponent(q)}` : ""}`} active={!filter} />
        {STATUSES.map((s) => (
          <FilterChip
            key={s}
            label={STATUS_LABEL[s]}
            href={`/admin?status=${s}${qParam}`}
            active={filter === s}
          />
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th className="px-4 py-3 font-medium">เลขอ้างอิง</th>
              <th className="px-4 py-3">ชื่อเล่น</th>
              <th className="px-4 py-3">โทร</th>
              <th className="px-4 py-3">หัวข้อ</th>
              <th className="px-4 py-3">สถานะ</th>
              <th className="px-4 py-3">วันที่</th>
              <th className="px-4 py-3">การดำเนินการ</th>
            </tr>
          </thead>
          <tbody>
            {bookings.map((b) => (
              <tr key={b.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3">
                  <span className="font-mono text-xs tracking-wide text-gray-700">
                    {b.id.slice(0, 8).toUpperCase()}
                  </span>
                </td>
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
                  {b.source === "line" && !b.slot_id && (
                    <div className="mt-1 text-xs text-amber-700">
                      รอตรวจสอบ · ยังไม่เลือกเวลา
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-500">
                  {new Date(b.created_at).toLocaleString("th-TH")}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/admin/bookings/${b.id}`}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      ดูรายละเอียด
                    </Link>
                    {b.status === "pending_payment" && b.slot_id && (
                      <ConfirmPaymentButton
                        bookingId={b.id}
                        nickname={b.nickname}
                        phone={b.phone}
                        slotInfo={
                          b.booking_slots?.[0]
                            ? `${b.booking_slots[0].booking_date} ${b.booking_slots[0].label}`
                            : null
                        }
                        refCode={b.id.slice(0, 8).toUpperCase()}
                        redirectTo="/admin"
                      />
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {bookings.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                  {q
                    ? `ไม่พบรายการที่ตรงกับ "${q}"`
                    : "ยังไม่มีรายการ"}
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
