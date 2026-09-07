"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  compressFaceImage,
  FACE_SOURCE_MAX_BYTES,
  FACE_UPLOAD_MAX_BYTES,
} from "@/lib/client-image-compression";

const FACE_ACCEPT = "image/jpeg,image/png,image/webp";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export default function BookingForm({
  source,
  holdMinutes,
}: {
  source: string;
  holdMinutes: number;
}) {
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
  const [faceFile, setFaceFile] = useState<File | null>(null);
  const [facePreview, setFacePreview] = useState<string | null>(null);
  const [faceOriginalBytes, setFaceOriginalBytes] = useState<number | null>(null);
  const [faceProcessing, setFaceProcessing] = useState(false);
  // Opaque upload token returned by the face-upload endpoint (not a storage path).
  // Stored in state so double-clicks and network retries reuse it without re-uploading.
  const [uploadToken, setUploadToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable idempotency key for one logical booking attempt; reset on success
  // or when the chosen slot/photo changes so each attempt gets its own key while
  // double-clicks / retries reuse it. Same key ties the face upload to the booking.
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

  async function onFaceChange(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0] ?? null;
    // Allow the same file to be selected again after a failed compression or
    // upload. The File object is already captured in local state below.
    input.value = "";
    if (!file) return;
    if (file.size > FACE_SOURCE_MAX_BYTES) {
      setError("รูปต้นฉบับต้องมีขนาดไม่เกิน 20 MB");
      return;
    }

    setFaceProcessing(true);
    setError(null);
    try {
      const prepared = await compressFaceImage(file);
      if (prepared.size > FACE_UPLOAD_MAX_BYTES) {
        throw new Error("compressed_too_large");
      }

      // New photo invalidates the previous upload token and idempotency key
      // so the next submit does a fresh upload tied to a new key.
      idemKey.current = "";
      setUploadToken(null);
      setFaceOriginalBytes(file.size);
      setFaceFile(prepared);
      setFacePreview(URL.createObjectURL(prepared));
    } catch (err) {
      setFaceFile(null);
      setFacePreview(null);
      setFaceOriginalBytes(null);
      setError(
        err instanceof Error && err.message === "unsupported_type"
          ? "รองรับเฉพาะ JPG, PNG และ WebP"
          : "ปรับขนาดรูปไม่สำเร็จ กรุณาเลือกรูปอื่น",
      );
    } finally {
      setFaceProcessing(false);
    }
  }

  useEffect(() => {
    return () => {
      if (facePreview) URL.revokeObjectURL(facePreview);
    };
  }, [facePreview]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!slotId) {
      setError("กรุณาเลือกรอบเซสชัน");
      return;
    }
    if (!faceFile) {
      setError("กรุณาแนบรูปหน้าก่อนยืนยันการจอง");
      return;
    }
    setSubmitting(true);
    if (!idemKey.current) idemKey.current = crypto.randomUUID();

    // Upload face only if we don't already have a token for this attempt.
    // Reusing uploadToken makes double-clicks and network retries idempotent.
    let token = uploadToken;
    if (!token) {
      try {
        const fd = new FormData();
        fd.append("file", faceFile);
        fd.append("company", company); // honeypot field
        const upRes = await fetch("/api/bookings/face-upload", {
          method: "POST",
          headers: { "Idempotency-Key": idemKey.current },
          body: fd,
        });
        if (!upRes.ok) {
          const upData = await upRes.json();
          if (upData.error === "rate_limited") {
            setError("คุณอัปโหลดรูปบ่อยเกินไป กรุณาลองใหม่ภายหลัง");
          } else {
            setError(upData.message ?? "อัปโหลดรูปหน้าไม่สำเร็จ กรุณาลองใหม่");
          }
          setSubmitting(false);
          return;
        }
        const uploadBody: unknown = await upRes.json();
        const uploadCandidate =
          uploadBody && typeof uploadBody === "object"
            ? (uploadBody as { uploadToken?: unknown }).uploadToken
            : null;
        if (typeof uploadCandidate !== "string" || !UUID_RE.test(uploadCandidate)) {
          throw new Error("upload_token_invalid");
        }
        token = uploadCandidate;
        setUploadToken(token);
      } catch {
        setError("อัปโหลดรูปหน้าไม่สำเร็จ กรุณาลองใหม่");
        setSubmitting(false);
        return;
      }
    }

    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idemKey.current,
        },
        body: JSON.stringify({ slotId, source, company, faceUploadToken: token, ...form }),
      });
      const parsed: unknown = await res.json();
      const data =
        parsed && typeof parsed === "object"
          ? (parsed as { error?: string; message?: string; token?: string })
          : {};
      setSubmitting(false);

      if (!res.ok) {
        setError(data.message ?? "เกิดข้อผิดพลาด กรุณาลองใหม่");
        if (data.error === "slot_full" || data.error === "slot_closed") {
          // Slot changed — new slot pick will reset key and token.
          fetch(`/api/slots?date=${date}`)
            .then((r) => r.json())
            .then((d) => setSlots(d.slots ?? []))
            .catch(() => setSlots([]));
          setSlotId("");
          idemKey.current = "";
          setUploadToken(null);
        } else if (data.error === "face_token_expired" || data.error === "face_token_invalid") {
          // Upload intent invalid — user must pick and re-upload their photo.
          idemKey.current = "";
          setUploadToken(null);
          setFaceFile(null);
          setFacePreview(null);
        }
        return;
      }

      if (!data.token) {
        setError("ระบบสร้างการจองไม่สำเร็จ กรุณาลองใหม่");
        return;
      }

      // Success: clear attempt state so next booking starts fresh.
      idemKey.current = "";
      setUploadToken(null);

      // Pass only the booking token (full UUID). The success page fetches
      // all display data from the DB — no booking details travel via URL.
      router.push(`/booking/success?token=${encodeURIComponent(data.token)}`);
    } catch {
      // Keep idemKey/uploadToken intact: a retry must converge on the same
      // booking instead of creating a second hold or uploading another face.
      setSubmitting(false);
      setError("ส่งข้อมูลการจองไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่");
    }
  }

  // Compact progress: reflects how much of the single-page flow is done. It is
  // decorative (each section already has a numbered heading), so it is hidden
  // from assistive tech to avoid duplicate step announcements.
  const steps = [
    { label: "วันที่", done: Boolean(date) },
    { label: "รอบ", done: Boolean(slotId) },
    {
      label: "ข้อมูล",
      done: Boolean(form.nickname && form.phone && form.birthDateText),
    },
    { label: "รูปหน้า", done: Boolean(faceFile) },
  ];
  const activeIndex = steps.findIndex((s) => !s.done);

  return (
    <>
      <div className="booking-progress" aria-hidden="true">
        {steps.map((s, i) => (
          <Fragment key={s.label}>
            {i > 0 && <span className="booking-progress-bar" />}
            <div
              className="booking-progress-step"
              data-state={
                s.done ? "done" : i === activeIndex ? "active" : undefined
              }
            >
              <span className="booking-progress-dot">{s.done ? "✓" : i + 1}</span>
              <span className="booking-progress-label">{s.label}</span>
            </div>
          </Fragment>
        ))}
      </div>

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
          เลือกรอบเซสชัน
        </h2>
        {loadingSlots ? (
          <p className="booking-alert booking-alert-muted">กำลังโหลดรอบที่ว่าง...</p>
        ) : slots.length === 0 ? (
          <p className="booking-alert booking-alert-muted">
            วันนี้ยังไม่มีรอบเซสชันที่เปิดรับจอง กรุณาเลือกวันอื่น
          </p>
        ) : (
          <div className="booking-slots">
            {slots.map((s) => (
              <button
                type="button"
                key={s.id}
                aria-pressed={slotId === s.id}
                onClick={() => {
                  setSlotId(s.id);
                  idemKey.current = ""; // new slot = new booking attempt
                  setUploadToken(null); // upload token is bound to the idempotency key
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
        <p className="booking-help" style={{ marginTop: 10 }}>
          รอบเซสชันเป็นเวลาโดยประมาณ ไม่ใช่เวลาโทรที่แน่นอน ทีมงานจะติดต่อตามลำดับคิว
          และการปรึกษาอาจใช้เวลานานกว่ารอบที่แสดง
        </p>
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
            <span className="booking-label">หัวข้อที่ต้องการปรึกษาพิเศษ</span>
            <span className="booking-help">(ระบุหรือไม่ก็ได้)</span>
            <textarea
              rows={3}
              value={form.consultationTopic}
              onChange={(e) =>
                setForm({ ...form, consultationTopic: e.target.value })
              }
              placeholder="ถ้ามีเรื่องที่อยากให้เน้นเป็นพิเศษ พิมพ์ไว้ตรงนี้ได้"
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
        <h2 className="booking-section-title">
          <span className="booking-step">4</span>
          รูปหน้าตรง
        </h2>
        <p className="booking-alert booking-alert-muted" style={{ marginBottom: 14 }}>
          กรุณาแนบรูปหน้าชัดเจน เพื่อประกอบการพิจารณาและการปรึกษา
          รูปจะถูกส่งให้ทีมงานที่เกี่ยวข้องเพื่อดำเนินการจองและเตรียมข้อมูลปรึกษา
        </p>
        <label className="booking-field" style={{ cursor: "pointer" }}>
          <span className="booking-label">
            รูปหน้าตรง <span className="booking-required">*</span>
          </span>
          <input
            type="file"
            accept={FACE_ACCEPT}
            onChange={onFaceChange}
            disabled={faceProcessing}
            className="booking-hidden-field"
          />
          <div className="booking-dropzone" data-has-file={faceFile ? "true" : undefined}>
            {facePreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={facePreview}
                alt="ตัวอย่างรูปหน้า"
                className="booking-dropzone-preview"
              />
            ) : faceProcessing ? (
              "กำลังปรับขนาดรูป..."
            ) : (
              "แตะหรือคลิกเพื่อเลือกรูป · ระบบบีบอัตโนมัติ (ต้นฉบับสูงสุด 20 MB)"
            )}
          </div>
        </label>
        {faceFile && (
          <p className="booking-dropzone-meta">
            {faceFile.name} ({(faceFile.size / 1024).toFixed(0)} KB)
            {faceOriginalBytes && faceOriginalBytes > faceFile.size + 64 * 1024
              ? ` · ลดจาก ${(faceOriginalBytes / 1024 / 1024).toFixed(1)} MB อัตโนมัติ`
              : ""}
          </p>
        )}
      </section>

      <section className="booking-section">
        {error && <p className="booking-alert booking-alert-error" role="alert">{error}</p>}

        <button
          type="submit"
          disabled={submitting || faceProcessing || !slotId || !faceFile}
          className="booking-submit"
        >
          {faceProcessing ? "กำลังปรับรูป..." : submitting ? "กำลังจอง..." : "ยืนยันการจองคิว"}
        </button>
        <p className="booking-note">
          เมื่อจองแล้วระบบจะถือคิวให้ {holdMinutes} นาที เพื่อรอการชำระเงิน
        </p>
      </section>
      </form>
    </>
  );
}
