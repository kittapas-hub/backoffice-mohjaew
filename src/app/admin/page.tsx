import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { STATUSES, STATUS_LABEL, StatusBadge } from "./status";
import { TRANSITION_ERROR_TH, type TransitionErrorCode } from "@/lib/confirm-error";
import { ConfirmPaymentButton } from "./_components/ConfirmPaymentButton";
import { SearchForm } from "./_components/SearchForm";
import { sanitizeSearch } from "./search-helpers";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;

type BookingRow = {
  id: string;
  nickname: string;
  phone: string;
  consultation_topic: string;
  status: string;
  created_at: string;
  hold_expires_at: string | null;
  slot_id: string | null;
  source: string | null;
  booking_slots: { booking_date: string; label: string }[] | null;
};

export default async function AdminHome({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; error?: string; success?: string; q?: string; page?: string }>;
}) {
  await requireAdmin();
  const { status, error: errorParam, success: successParam, q: rawQ, page: rawPage } = await searchParams;
  const filter =
    status && STATUSES.includes(status as (typeof STATUSES)[number]) ? status : null;
  const confirmError =
    errorParam && errorParam in TRANSITION_ERROR_TH
      ? TRANSITION_ERROR_TH[errorParam as TransitionErrorCode]
      : null;
  const q = rawQ ? sanitizeSearch(rawQ) : "";
  const requestedPage = Number.parseInt(rawPage ?? "1", 10);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const from = (page - 1) * PAGE_SIZE;

  const db = supabaseAdmin();
  let query = db
    .from("bookings")
    .select(
      "id, nickname, phone, consultation_topic, status, created_at, hold_expires_at, slot_id, source, booking_slots(booking_date, label)",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);
  if (filter) query = query.eq("status", filter);
  if (q) {
    // id prefix match covers reference search: reference = id.slice(0,8).toUpperCase()
    query = query.or(
      `nickname.ilike.%${q}%,phone.ilike.%${q}%,id.ilike.${q}%`,
    );
  }
  const { data, error: listError, count } = await query;
  if (listError) {
    console.error("[admin-bookings] list query failed", {
      dbCode: listError.code ?? null,
      filtered: Boolean(filter),
      searched: Boolean(q),
    });
  }
  const bookings = (data ?? []) as unknown as BookingRow[];
  const bookingIds = bookings.map((booking) => booking.id);
  const { data: reviewRows, error: reviewError } = bookingIds.length
    ? await db
        .from("payment_orders")
        .select("booking_id")
        .in("booking_id", bookingIds)
        .eq("status", "manual_review")
    : { data: [] as { booking_id: string }[], error: null };
  const manualReviewBookings = new Set(
    (reviewRows ?? []).map((row) => row.booking_id as string),
  );
  // If payment state cannot be loaded, hide inline overrides and require the
  // authenticated detail page rather than risk bypassing a review claim.
  const paymentStateKnown = !reviewError;
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstRow = bookings.length ? from + 1 : 0;
  const lastRow = Math.min(from + bookings.length, total);

  // Build URL helpers for filter chips that preserve the current search query.
  const qParam = q ? `&q=${encodeURIComponent(q)}` : "";
  const clearSearchHref = filter ? `/admin?status=${filter}` : "/admin";
  const pageHref = (target: number) => {
    const params = new URLSearchParams();
    if (filter) params.set("status", filter);
    if (q) params.set("q", q);
    params.set("page", String(target));
    return `/admin?${params.toString()}`;
  };

  return (
    <div>
      <div className="admin-page-header">
        <div><p className="admin-eyebrow">Booking operations</p><h1 className="admin-title">รายการจองคิว</h1><p className="admin-description">ค้นหา ตรวจสอบ และจัดการสถานะการจองล่าสุดได้ในที่เดียว</p></div>
        <div className="flex items-center gap-4">
          <Link
            href="/admin/day"
            className="text-sm font-medium text-rose-600 hover:underline"
          >
            ตารางคิวรายวัน
          </Link>
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

      <section className="admin-card mb-5 p-4 sm:p-5" aria-label="ค้นหาและกรองรายการจอง">
        <SearchForm
          defaultValue={q}
          status={filter}
          clearHref={clearSearchHref}
        />
      <div className="mt-4 flex flex-wrap gap-2">
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
      </section>

      <div className="admin-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#eee5e2] px-5 py-4"><div><h2 className="font-bold text-gray-900">ผลการค้นหา</h2><p className="mt-0.5 text-xs text-gray-500">แสดง {firstRow}–{lastRow} จาก {total.toLocaleString("th-TH")} รายการ</p></div><span className="rounded-full bg-rose-50 px-3 py-1 text-xs font-bold text-rose-700">หน้า {page} / {totalPages}</span></div>
        <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[920px] text-sm">
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
              <tr key={b.id} className="border-t border-gray-100 transition-colors hover:bg-rose-50/40 focus-within:bg-rose-50/40">
                <td className="px-4 py-3">
                  <span className="font-mono text-xs tracking-wide text-gray-700">
                    {b.id.slice(0, 8).toUpperCase()}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <Link
                    href={`/admin/bookings/${b.id}`}
                    className="admin-focus font-semibold text-gray-900 hover:text-rose-700"
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
                      className="admin-focus rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                    >
                      ดูรายละเอียด
                    </Link>
                    {b.status === "pending_payment" && b.slot_id &&
                      paymentStateKnown && manualReviewBookings.has(b.id) ? (
                      <Link
                        href={`/admin/bookings/${b.id}`}
                        className="text-xs font-semibold text-amber-700 hover:underline"
                      >
                        ตรวจสอบการชำระ
                      </Link>
                    ) : b.status === "pending_payment" && b.slot_id &&
                      paymentStateKnown && b.hold_expires_at &&
                      new Date(b.hold_expires_at).getTime() > Date.now() ? (
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
                        verifiedClaimAvailable={false}
                      />
                    ) : null}
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
        </table></div>
        <div className="divide-y divide-[#eee5e2] md:hidden">{bookings.map((b) => <article key={b.id} className="p-4">
          <div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs font-bold tracking-wide text-rose-700">#{b.id.slice(0,8).toUpperCase()}</p><Link href={`/admin/bookings/${b.id}`} className="admin-focus mt-1 block text-base font-bold text-gray-900">{b.nickname}</Link></div><StatusBadge status={b.status} /></div>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-gray-500">โทร</dt><dd>{b.phone}</dd></div><div><dt className="text-xs text-gray-500">วันที่สร้าง</dt><dd>{new Date(b.created_at).toLocaleString("th-TH")}</dd></div><div className="col-span-2"><dt className="text-xs text-gray-500">หัวข้อ</dt><dd>{b.consultation_topic}</dd></div></dl>
          {b.source === "line" && !b.slot_id ? <p className="mt-3 text-xs text-amber-700">รอตรวจสอบ · ยังไม่เลือกเวลา</p> : null}
          <div className="mt-4 flex flex-wrap items-center gap-2"><Link href={`/admin/bookings/${b.id}`} className="admin-focus rounded-lg border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700">ดูรายละเอียด</Link>{b.status === "pending_payment" && b.slot_id && paymentStateKnown && manualReviewBookings.has(b.id) ? <span className="text-xs font-semibold text-amber-700">ต้องตรวจสอบการชำระ</span> : b.status === "pending_payment" && b.slot_id && paymentStateKnown && b.hold_expires_at && new Date(b.hold_expires_at).getTime() > Date.now() ? <ConfirmPaymentButton bookingId={b.id} nickname={b.nickname} phone={b.phone} slotInfo={b.booking_slots?.[0] ? `${b.booking_slots[0].booking_date} ${b.booking_slots[0].label}` : null} refCode={b.id.slice(0,8).toUpperCase()} redirectTo="/admin" verifiedClaimAvailable={false} /> : null}</div>
        </article>)}{bookings.length === 0 ? <p className="p-8 text-center text-sm text-gray-500">{q ? `ไม่พบรายการที่ตรงกับ “${q}”` : "ยังไม่มีรายการ"}</p> : null}</div>
        <div className="flex items-center justify-between border-t border-[#eee5e2] px-4 py-4 sm:px-5"><p className="text-xs text-gray-500">50 รายการต่อหน้า</p><div className="flex gap-2">{page > 1 ? <Link href={pageHref(page - 1)} className="admin-focus rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold hover:bg-gray-50">ก่อนหน้า</Link> : <span className="rounded-lg border border-gray-100 px-3 py-2 text-sm text-gray-300">ก่อนหน้า</span>}{page < totalPages ? <Link href={pageHref(page + 1)} className="admin-focus rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-800">ถัดไป</Link> : <span className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-400">ถัดไป</span>}</div></div>
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
      className={`admin-focus rounded-full border px-3 py-1.5 text-sm font-medium ${
        active
          ? "border-gray-900 bg-gray-900 text-white"
          : "border-gray-300 bg-white text-gray-600 hover:border-gray-400"
      }`}
    >
      {label}
    </Link>
  );
}
