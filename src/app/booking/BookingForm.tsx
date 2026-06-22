"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Slot = {
  id: string;
  label: string;
  startTime: string;
  endTime: string;
  remaining: number;
  capacity: number;
};

function todayISO() {
  return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
}

export default function BookingForm({ source }: { source: string }) {
  const router = useRouter();
  const [date, setDate] = useState(todayISO());
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotId, setSlotId] = useState("");
  const [form, setForm] = useState({
    nickname: "",
    phone: "",
    consultationTopic: "",
    birthDateText: "",
  });
  // Honeypot — kept empty by real users; hidden from view.
  const [company, setCompany] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable idempotency key for one logical booking attempt; reset on success
  // or when the chosen slot changes so each booking gets its own key while
  // double-clicks / retries reuse it.
  const idemKey = useRef("");

  useEffect(() => {
    let active = true;
    setLoadingSlots(true);
    setSlotId("");
    fetch(`/api/slots?date=${date}`)
      .then((r) => r.json())
      .then((d) => {
        if (active) setSlots(d.slots ?? []);
      })
      .catch(() => active && setSlots([]))
      .finally(() => active && setLoadingSlots(false));
    return () => {
      active = false;
    };
  }, [date]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!slotId) {
      setError("กรุณาเลือกรอบเวลา");
      return;
    }
    setSubmitting(true);
    if (!idemKey.current) idemKey.current = crypto.randomUUID();
    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idemKey.current,
      },
      body: JSON.stringify({ slotId, source, company, ...form }),
    });
    const data = await res.json();
    setSubmitting(false);

    if (!res.ok) {
      setError(data.message ?? "เกิดข้อผิดพลาด กรุณาลองใหม่");
      // Slot may have just filled — refresh availability and start a new key.
      if (data.error === "slot_full" || data.error === "slot_closed") {
        fetch(`/api/slots?date=${date}`)
          .then((r) => r.json())
          .then((d) => setSlots(d.slots ?? []));
        setSlotId("");
        idemKey.current = "";
      }
      return;
    }

    idemKey.current = ""; // next booking gets a fresh key

    // Only non-PII values in the query string.
    const q = new URLSearchParams({
      ref: data.reference,
      q: String(data.queueNumber),
      date,
      slot: data.slotLabel,
    });
    router.push(`/booking/success?${q.toString()}`);
  }

  const input =
    "w-full rounded-lg border border-gray-300 px-4 py-2.5 text-base outline-none focus:border-rose-500";

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div>
        <label className="mb-1 block text-sm font-medium">เลือกวัน</label>
        <input
          type="date"
          value={date}
          min={todayISO()}
          onChange={(e) => setDate(e.target.value)}
          className={input}
        />
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium">เลือกรอบเวลา</label>
        {loadingSlots ? (
          <p className="text-sm text-gray-400">กำลังโหลดรอบที่ว่าง...</p>
        ) : slots.length === 0 ? (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            วันนี้ยังไม่มีรอบที่เปิดรับจอง กรุณาเลือกวันอื่น
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {slots.map((s) => (
              <button
                type="button"
                key={s.id}
                onClick={() => {
                  setSlotId(s.id);
                  idemKey.current = ""; // new slot = new booking attempt
                }}
                className={`flex items-center justify-between rounded-lg border px-4 py-3 text-left ${
                  slotId === s.id
                    ? "border-rose-600 bg-rose-50"
                    : "border-gray-300 bg-white"
                }`}
              >
                <span className="font-medium">{s.label}</span>
                <span className="text-sm text-gray-500">
                  เหลือ {s.remaining} คิว
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm font-medium">ชื่อเล่น</label>
          <input
            required
            value={form.nickname}
            onChange={(e) => setForm({ ...form, nickname: e.target.value })}
            className={input}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">เบอร์โทรศัพท์</label>
          <input
            required
            type="tel"
            inputMode="tel"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className={input}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">
            วัน/เดือน/ปีเกิด
          </label>
          <input
            required
            value={form.birthDateText}
            onChange={(e) => setForm({ ...form, birthDateText: e.target.value })}
            placeholder="เช่น 1 มกราคม 2540"
            className={input}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">
            หัวข้อที่ต้องการปรึกษา
          </label>
          <textarea
            required
            rows={3}
            value={form.consultationTopic}
            onChange={(e) =>
              setForm({ ...form, consultationTopic: e.target.value })
            }
            className={input}
          />
        </div>
      </div>

      {/* Honeypot — visually hidden, off the tab order, ignored by humans. */}
      <input
        type="text"
        name="company"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
        className="absolute left-[-9999px] h-0 w-0 opacity-0"
      />

      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>
      )}

      <button
        type="submit"
        disabled={submitting || !slotId}
        className="w-full rounded-lg bg-rose-600 px-4 py-3 text-base font-semibold text-white disabled:opacity-50"
      >
        {submitting ? "กำลังจอง..." : "ยืนยันการจองคิว"}
      </button>
      <p className="text-center text-xs text-gray-400">
        เมื่อจองแล้วระบบจะถือคิวให้ 60 นาที เพื่อรอการชำระเงิน
      </p>
    </form>
  );
}
