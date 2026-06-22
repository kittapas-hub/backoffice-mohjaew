import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { countOccupied, SLOT_TRANSITIONS, type BookingLike } from "@/lib/slots";
import { TRANSITION_ERROR_TH, type TransitionErrorCode } from "@/lib/confirm-error";
import { StatusBadge } from "../status";
import { transitionSlotBooking } from "../actions";
import { seedDaySlots, updateSlotCapacity, toggleSlot } from "./actions";

// Thai labels + button styling for each transition target.
const TRANSITION_UI: Record<string, { label: string; primary?: boolean }> = {
  confirmed: { label: "ยืนยัน", primary: true },
  completed: { label: "เสร็จสิ้น", primary: true },
  cancelled: { label: "ยกเลิก" },
  expired: { label: "หมดเวลา" },
};

export const dynamic = "force-dynamic";

function todayISO() {
  return new Date().toLocaleDateString("en-CA");
}

type Slot = {
  id: string;
  label: string;
  start_time: string;
  capacity: number;
  is_open: boolean;
};

type Booking = BookingLike & {
  id: string;
  slot_id: string;
  nickname: string;
  phone: string;
  consultation_topic: string;
  source: string | null;
};

export default async function DayView({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; error?: string }>;
}) {
  await requireAdmin();
  const { date: dateParam, error: errorParam } = await searchParams;
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : todayISO();
  const confirmError =
    errorParam && errorParam in TRANSITION_ERROR_TH
      ? TRANSITION_ERROR_TH[errorParam as TransitionErrorCode]
      : null;

  const db = supabaseAdmin();
  // Clear lapsed holds so counts shown to admin are accurate.
  await db.rpc("expire_pending_bookings");

  const { data: slots } = await db
    .from("booking_slots")
    .select("id, label, start_time, capacity, is_open")
    .eq("booking_date", date)
    .order("start_time");

  const slotIds = (slots ?? []).map((s) => s.id);
  const { data: bookings } = slotIds.length
    ? await db
        .from("bookings")
        .select("id, slot_id, nickname, phone, consultation_topic, source, status, hold_expires_at, queue_number")
        .in("slot_id", slotIds)
        .order("queue_number")
    : { data: [] as Booking[] };

  const bookingIds = (bookings ?? []).map((b) => b.id);
  const { data: faceRows } = bookingIds.length
    ? await db.from("booking_images").select("booking_id").in("booking_id", bookingIds)
    : { data: null };
  const faceSet = new Set((faceRows ?? []).map((r) => r.booking_id as string));

  const bySlot = new Map<string, Booking[]>();
  for (const b of (bookings ?? []) as Booking[]) {
    const list = bySlot.get(b.slot_id) ?? [];
    list.push(b);
    bySlot.set(b.slot_id, list);
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">ตารางคิวรายวัน</h1>
        <div className="flex flex-wrap items-center gap-3">
          {slots && slots.length > 0 && (
            <form action={seedDaySlots}>
              <input type="hidden" name="date" value={date} />
              <button className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50">
                เติมรอบรายชั่วโมง
              </button>
            </form>
          )}
          <Link href="/admin" className="text-sm text-gray-500 hover:text-gray-900">
            ← รายการจองทั้งหมด
          </Link>
        </div>
      </div>

      {confirmError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {confirmError}
        </div>
      )}

      <form method="get" className="mb-6 flex items-center gap-2">
        <input
          type="date"
          name="date"
          defaultValue={date}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <button className="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white">
          ดู
        </button>
      </form>

      {(!slots || slots.length === 0) && (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center">
          <p className="mb-3 text-sm text-gray-500">ยังไม่มีรอบเวลาสำหรับวันนี้</p>
          <form action={seedDaySlots}>
            <input type="hidden" name="date" value={date} />
            <button className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white">
              สร้างรอบรายชั่วโมง (09:00–21:00)
            </button>
          </form>
        </div>
      )}

      <div className="space-y-5">
        {(slots as Slot[] | null)?.map((slot) => {
          const list = bySlot.get(slot.id) ?? [];
          const occupied = countOccupied(list);
          return (
            <section
              key={slot.id}
              className="overflow-hidden rounded-lg border border-gray-200 bg-white"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 bg-gray-50 px-4 py-3">
                <div>
                  <div className="font-semibold">{slot.label}</div>
                  <div className="text-sm text-gray-500">
                    จองแล้ว {occupied} / {slot.capacity} คิว
                    {!slot.is_open && (
                      <span className="ml-2 text-red-600">(ปิดรับจอง)</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <form action={updateSlotCapacity} className="flex items-center gap-1">
                    <input type="hidden" name="slotId" value={slot.id} />
                    <input type="hidden" name="date" value={date} />
                    <input
                      type="number"
                      name="capacity"
                      min={0}
                      defaultValue={slot.capacity}
                      className="w-16 rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                    <button className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100">
                      แก้ capacity
                    </button>
                  </form>
                  <form action={toggleSlot}>
                    <input type="hidden" name="slotId" value={slot.id} />
                    <input type="hidden" name="date" value={date} />
                    <input type="hidden" name="isOpen" value={String(!slot.is_open)} />
                    <button className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100">
                      {slot.is_open ? "ปิดรอบ" : "เปิดรอบ"}
                    </button>
                  </form>
                </div>
              </div>

              {list.length === 0 ? (
                <p className="px-4 py-4 text-sm text-gray-400">ยังไม่มีผู้จอง</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-left text-gray-500">
                    <tr>
                      <th className="px-4 py-2">คิว</th>
                      <th className="px-4 py-2">ชื่อ</th>
                      <th className="px-4 py-2">โทร</th>
                      <th className="px-4 py-2">หัวข้อ</th>
                      <th className="px-4 py-2">ช่องทาง</th>
                      <th className="px-4 py-2">สถานะ</th>
                      <th className="px-4 py-2">รูป</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((b) => (
                      <tr key={b.id} className="border-t border-gray-100">
                        <td className="px-4 py-2">{b.queue_number ?? "-"}</td>
                        <td className="px-4 py-2 font-medium">{b.nickname}</td>
                        <td className="px-4 py-2">{b.phone}</td>
                        <td className="px-4 py-2">{b.consultation_topic}</td>
                        <td className="px-4 py-2">{b.source ?? "-"}</td>
                        <td className="px-4 py-2">
                          <StatusBadge status={b.status} />
                        </td>
                        <td className="px-4 py-2 text-center" title={faceSet.has(b.id) ? "มีรูปหน้า" : "ไม่มีรูป"}>
                          {faceSet.has(b.id) ? "📷" : ""}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex gap-1">
                            {(SLOT_TRANSITIONS[b.status] ?? [])
                              .filter((t) => t !== "expired")
                              .map((to) => (
                                <form key={to} action={transitionSlotBooking}>
                                  <input type="hidden" name="bookingId" value={b.id} />
                                  <input type="hidden" name="to" value={to} />
                                  <input
                                    type="hidden"
                                    name="redirectTo"
                                    value={`/admin/day?date=${date}`}
                                  />
                                  <button
                                    className={
                                      TRANSITION_UI[to]?.primary
                                        ? "rounded bg-green-600 px-2 py-1 text-xs text-white"
                                        : "rounded border border-gray-300 px-2 py-1 text-xs"
                                    }
                                  >
                                    {TRANSITION_UI[to]?.label ?? to}
                                  </button>
                                </form>
                              ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
