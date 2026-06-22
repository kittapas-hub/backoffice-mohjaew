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

    // Pass only the booking token (full UUID). The success page fetches
    // all display data from the DB — no booking details travel via URL.
    router.push(`/booking/success?token=${encodeURIComponent(data.token)}`);
  }

  return (
    <form onSubmit={onSubmit} className="booking-panel">
      <section className="booking-section">
        <h2 className="booking-section-title">
          <span className="booking-step">1</span>
          เลือกวันนัด
        </h2>
        <label className="booking-field">
          <span className="booking-label">วันที่ต้องการจอง</span>
          <input
            type="date"
            value={date}
            min={todayISO()}
            onChange={(e) => setDate(e.target.value)}
            className="booking-input"
          />
        </label>
      </section>

      <section className="booking-section">
        <h2 className="booking-section-title">
          <span className="booking-step">2</span>
          เลือกรอบเวลา
        </h2>
        {loadingSlots ? (
          <p className="booking-alert booking-alert-muted">กำลังโหลดรอบที่ว่าง...</p>
        ) : slots.length === 0 ? (
          <p className="booking-alert booking-alert-muted">
            วันนี้ยังไม่มีรอบที่เปิดรับจอง กรุณาเลือกวันอื่น
          </p>
        ) : (
          <div className="booking-slots">
            {slots.map((s) => (
              <button
                type="button"
                key={s.id}
                onClick={() => {
                  setSlotId(s.id);
                  idemKey.current = ""; // new slot = new booking attempt
                }}
                className={`booking-slot ${
                  slotId === s.id ? "booking-slot-selected" : ""
                }`}
              >
                <span className="booking-slot-label">{s.label}</span>
                <span className="booking-slot-meta">เหลือ {s.remaining} คิว</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="booking-section">
        <h2 className="booking-section-title">
          <span className="booking-step">3</span>
          ข้อมูลผู้จอง
        </h2>
        <div className="booking-form-grid">
          <label className="booking-field">
            <span className="booking-label">ชื่อเล่น</span>
            <input
              required
              value={form.nickname}
              onChange={(e) => setForm({ ...form, nickname: e.target.value })}
              className="booking-input"
            />
          </label>
          <label className="booking-field">
            <span className="booking-label">เบอร์โทรศัพท์</span>
            <input
              required
              type="tel"
              inputMode="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="booking-input"
            />
          </label>
          <label className="booking-field">
            <span className="booking-label">วัน/เดือน/ปีเกิด</span>
            <input
              required
              value={form.birthDateText}
              onChange={(e) => setForm({ ...form, birthDateText: e.target.value })}
              placeholder="เช่น 1 มกราคม 2540"
              className="booking-input"
            />
          </label>
          <label className="booking-field">
            <span className="booking-label">หัวข้อที่ต้องการปรึกษา</span>
            <textarea
              required
              rows={3}
              value={form.consultationTopic}
              onChange={(e) =>
                setForm({ ...form, consultationTopic: e.target.value })
              }
              className="booking-textarea"
            />
          </label>
        </div>
      </section>

      {/* Honeypot — visually hidden, off the tab order, ignored by humans. */}
      <input
        type="text"
        name="company"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
        className="booking-hidden-field"
      />

      <section className="booking-section">
        {error && <p className="booking-alert booking-alert-error">{error}</p>}

        <button type="submit" disabled={submitting || !slotId} className="booking-submit">
          {submitting ? "กำลังจอง..." : "ยืนยันการจองคิว"}
        </button>
        <p className="booking-note">
          เมื่อจองแล้วระบบจะถือคิวให้ 60 นาที เพื่อรอการชำระเงิน
        </p>
      </section>
    </form>
  );
}
