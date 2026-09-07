"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatThaiDate } from "./success/ui";
import {
  BOOKING_WIZARD_STEPS,
  canContinueWizard,
  canSubmitBooking,
  getWizardStepStatus,
  invalidateSlotSelection,
  nextWizardStep,
  previousWizardStep,
  type BookingWizardState,
  type WizardStep,
} from "@/lib/booking-wizard";
import {
  compressFaceImage,
  FACE_SOURCE_MAX_BYTES,
  FACE_UPLOAD_MAX_BYTES,
} from "@/lib/client-image-compression";

const FACE_ACCEPT = "image/jpeg,image/png,image/webp";

type Slot = {
  id: string;
  label: string;
  startTime: string;
  endTime: string;
  remaining: number;
  capacity: number;
};

type BookingDetails = {
  nickname: string;
  phone: string;
  consultationTopic: string;
  birthDateText: string;
};

type BookingPaymentDisplay = {
  amountSatang: number | null;
  ready: boolean;
};

function todayISO() {
  return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
}

function formatAmount(amountSatang: number | null): string | null {
  if (amountSatang === null) return null;
  return (amountSatang / 100).toLocaleString("th-TH");
}

function validationMessage(step: WizardStep): string {
  switch (step) {
    case 1:
      return "กรุณาเลือกวันที่ต้องการจอง";
    case 2:
      return "กรุณาเลือกรอบเซสชัน";
    case 3:
      return "กรุณากรอกข้อมูลผู้จองให้ครบถ้วน";
    case 4:
      return "กรุณาแนบรูปหน้าก่อนตรวจสอบ";
    case 5:
      return "กรุณาตรวจสอบข้อมูลให้ครบถ้วน";
  }
}

function stepDescription(step: WizardStep): string {
  switch (step) {
    case 1:
      return "เลือกวันที่ต้องการจอง";
    case 2:
      return "รอบเซสชันเป็นเวลาโดยประมาณ ไม่ใช่เวลาโทรที่แน่นอน ทีมงานจะติดต่อตามลำดับคิว และการปรึกษาอาจใช้เวลานานกว่ารอบที่แสดง";
    case 3:
      return "ข้อมูลนี้ใช้สำหรับดำเนินการจองและให้ทีมงานติดต่อกลับ";
    case 4:
      return "กรุณาแนบรูปหน้าชัดเจน เพื่อประกอบการพิจารณาและการปรึกษา";
    case 5:
      return "ตรวจสอบรายละเอียดให้ถูกต้องก่อนยืนยันการจองคิว";
  }
}

export default function BookingForm({
  source,
  holdMinutes,
  payment,
}: {
  source: string;
  holdMinutes: number;
  payment: BookingPaymentDisplay;
}) {
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>(1);
  const [date, setDate] = useState(todayISO());
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotId, setSlotId] = useState("");
  const [form, setForm] = useState<BookingDetails>({
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
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const hasRenderedRef = useRef(false);

  useEffect(() => {
    let active = true;
    setLoadingSlots(true);
    setSlots([]);
    // A date change makes a previously selected server slot stale. Keep the
    // customer fields and prepared photo, but make the next upload/booking
    // attempt use a fresh idempotency key.
    setSlotId((currentSlotId) =>
      invalidateSlotSelection({ slotId: currentSlotId }).slotId,
    );
    idemKey.current = "";
    setUploadToken(null);
    setError(null);

    fetch(`/api/slots?date=${date}`)
      .then((r) => r.json())
      .then((d: { slots?: Slot[] }) => {
        if (active) setSlots(d.slots ?? []);
      })
      .catch(() => active && setSlots([]))
      .finally(() => active && setLoadingSlots(false));
    return () => {
      active = false;
    };
  }, [date]);

  useEffect(() => {
    if (hasRenderedRef.current) stepHeadingRef.current?.focus();
    hasRenderedRef.current = true;
  }, [step]);

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

  const selectedSlot = slots.find((slot) => slot.id === slotId) ?? null;
  const wizardState: BookingWizardState = {
    date,
    slotId,
    availableSlotIds: slots.map((slot) => slot.id),
    nickname: form.nickname,
    phone: form.phone,
    birthDateText: form.birthDateText,
    faceReady: Boolean(faceFile),
  };
  const readyToSubmit = canSubmitBooking(wizardState);
  const completedSteps = [1, 2, 3, 4].filter((item) =>
    getWizardStepStatus(item as WizardStep, step, wizardState) === "complete",
  ).length;
  const currentStep = BOOKING_WIZARD_STEPS[step - 1];
  const amount = formatAmount(payment.amountSatang);

  function advance() {
    if (!canContinueWizard(step, wizardState)) {
      setError(validationMessage(step));
      return;
    }
    setError(null);
    setStep(nextWizardStep(step, wizardState));
  }

  function goBack() {
    if (submitting) return;
    setError(null);
    setStep(previousWizardStep(step));
  }

  function goToStep(target: WizardStep) {
    const status = getWizardStepStatus(target, step, wizardState);
    if (target < step && status === "complete") {
      setError(null);
      setStep(target);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (step !== 5) {
      advance();
      return;
    }

    setError(null);
    if (!readyToSubmit) {
      setError(validationMessage(5));
      return;
    }
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
        token = ((await upRes.json()) as { uploadToken: string }).uploadToken;
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
            .then((d: { slots?: Slot[] }) => setSlots(d.slots ?? []))
            .catch(() => setSlots([]));
          setSlotId("");
          idemKey.current = "";
          setUploadToken(null);
          setStep(2);
        } else if (data.error === "face_token_expired" || data.error === "face_token_invalid") {
          // Upload intent invalid — user must pick and re-upload their photo.
          idemKey.current = "";
          setUploadToken(null);
          setFaceFile(null);
          setFacePreview(null);
          setFaceOriginalBytes(null);
          setStep(4);
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

  function updateForm<K extends keyof BookingDetails>(field: K, value: BookingDetails[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    setError(null);
  }

  function renderStep() {
    switch (step) {
      case 1:
        return (
          <section className="booking-step-content" aria-labelledby="booking-step-title">
            <div className="booking-date-card">
              <div className="booking-date-card-heading">
                <span className="booking-icon-tile" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <rect x="3.5" y="5.5" width="17" height="15" rx="2.5" />
                    <path d="M7.5 3.5v4M16.5 3.5v4M3.5 10h17" />
                  </svg>
                </span>
                <div>
                  <p className="booking-card-kicker">วันที่ต้องการจอง</p>
                  <p className="booking-card-supporting">เลือกวันและรอบเซสชันที่สะดวก</p>
                </div>
              </div>
              <label className="booking-field">
                <span className="booking-label">วันที่</span>
                <input
                  type="date"
                  value={date}
                  min={todayISO()}
                  onChange={(e) => setDate(e.target.value)}
                  className="booking-input booking-date-input"
                  aria-describedby="booking-date-help"
                />
              </label>
            </div>
            <p id="booking-date-help" className="booking-inline-note">
              รอบที่แสดงเป็นเวลาโดยประมาณของการปรึกษา ไม่ใช่เวลาโทรที่แน่นอน
            </p>
          </section>
        );

      case 2:
        return (
          <section className="booking-step-content" aria-labelledby="booking-step-title">
            {loadingSlots ? (
              <p className="booking-alert booking-alert-muted" role="status">
                กำลังโหลดรอบที่ว่าง...
              </p>
            ) : slots.length === 0 ? (
              <p className="booking-alert booking-alert-muted" role="status">
                วันนี้ยังไม่มีรอบเซสชันที่เปิดรับจอง กรุณาเลือกวันอื่น
              </p>
            ) : (
              <div className="booking-slot-grid" aria-label="รอบเซสชันที่เปิดรับจอง">
                {slots.map((slot) => {
                  const selected = slotId === slot.id;
                  return (
                    <button
                      type="button"
                      key={slot.id}
                      aria-pressed={selected}
                      disabled={slot.remaining <= 0}
                      onClick={() => {
                        setSlotId(slot.id);
                        idemKey.current = ""; // new slot = new booking attempt
                        setUploadToken(null); // upload token is bound to the idempotency key
                        setError(null);
                      }}
                      className="booking-slot"
                      data-selected={selected ? "true" : undefined}
                    >
                      <span className="booking-slot-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" focusable="false">
                          <circle cx="12" cy="12" r="8.5" />
                          <path d="M12 7.5V12l3 2" />
                        </svg>
                      </span>
                      <span className="booking-slot-copy">
                        <span className="booking-slot-label">{slot.label}</span>
                        <span className="booking-slot-meta">เหลือ {slot.remaining} คิว</span>
                      </span>
                      <span className="booking-slot-indicator" aria-hidden="true">
                        {selected ? "✓" : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <p className="booking-inline-note">
              รอบเซสชันเป็นเวลาโดยประมาณ ไม่ใช่เวลาโทรที่แน่นอน ทีมงานจะติดต่อตามลำดับคิว
              และการปรึกษาอาจใช้เวลานานกว่ารอบที่แสดง
            </p>
          </section>
        );

      case 3:
        return (
          <section className="booking-step-content" aria-labelledby="booking-step-title">
            <div className="booking-form-grid">
              <label className="booking-field">
                <span className="booking-label">ชื่อเล่น</span>
                <input
                  required
                  name="nickname"
                  autoComplete="nickname"
                  value={form.nickname}
                  onChange={(e) => updateForm("nickname", e.target.value)}
                  className="booking-input"
                />
              </label>
              <label className="booking-field">
                <span className="booking-label">เบอร์โทรศัพท์</span>
                <input
                  required
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={form.phone}
                  onChange={(e) => updateForm("phone", e.target.value)}
                  className="booking-input"
                />
              </label>
              <label className="booking-field">
                <span className="booking-label">วัน/เดือน/ปีเกิด</span>
                <input
                  required
                  name="birthDateText"
                  value={form.birthDateText}
                  onChange={(e) => updateForm("birthDateText", e.target.value)}
                  placeholder="เช่น 1 มกราคม 2540"
                  className="booking-input"
                />
              </label>
              <label className="booking-field booking-field-wide">
                <span className="booking-label">หัวข้อที่ต้องการปรึกษาพิเศษ</span>
                <span className="booking-help">(ระบุหรือไม่ก็ได้)</span>
                <textarea
                  name="consultationTopic"
                  rows={4}
                  value={form.consultationTopic}
                  onChange={(e) => updateForm("consultationTopic", e.target.value)}
                  placeholder="ถ้ามีเรื่องที่อยากให้เน้นเป็นพิเศษ พิมพ์ไว้ตรงนี้ได้"
                  className="booking-textarea"
                />
              </label>
            </div>
          </section>
        );

      case 4:
        return (
          <section className="booking-step-content" aria-labelledby="booking-step-title">
            <p className="booking-alert booking-alert-muted booking-face-intro">
              กรุณาแนบรูปหน้าชัดเจน เพื่อประกอบการพิจารณาและการปรึกษา
              รูปจะถูกส่งให้ทีมงานที่เกี่ยวข้องเพื่อดำเนินการจองและเตรียมข้อมูลปรึกษา
            </p>
            <label className="booking-upload-field">
              <span className="booking-label">
                รูปหน้าตรง <span className="booking-required">*</span>
              </span>
              <input
                type="file"
                accept={FACE_ACCEPT}
                onChange={onFaceChange}
                disabled={faceProcessing}
                className="booking-file-input"
              />
              <span
                className="booking-dropzone"
                data-has-file={faceFile ? "true" : undefined}
              >
                {facePreview ? (
                  <span className="booking-preview-wrap">
                    {/* Browser blob URL from the compressed face file; it is not a remote asset. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={facePreview}
                      alt="ตัวอย่างรูปหน้า"
                      width={240}
                      height={240}
                      className="booking-dropzone-preview"
                    />
                    <span className="booking-dropzone-action">แตะหรือคลิกเพื่อเลือกรูปใหม่</span>
                  </span>
                ) : faceProcessing ? (
                  <span className="booking-dropzone-processing" aria-live="polite">
                    กำลังปรับขนาดรูป...
                  </span>
                ) : (
                  <span className="booking-dropzone-empty">
                    <span className="booking-upload-mark" aria-hidden="true">+</span>
                    <span>แตะหรือคลิกเพื่อเลือกรูป</span>
                    <small>ระบบบีบอัตโนมัติ (ต้นฉบับสูงสุด 20 MB)</small>
                  </span>
                )}
              </span>
            </label>
            {faceFile && (
              <p className="booking-dropzone-meta" aria-live="polite">
                {faceFile.name} ({(faceFile.size / 1024).toFixed(0)} KB)
                {faceOriginalBytes && faceOriginalBytes > faceFile.size + 64 * 1024
                  ? ` · ลดจาก ${(faceOriginalBytes / 1024 / 1024).toFixed(1)} MB อัตโนมัติ`
                  : ""}
              </p>
            )}

            <div className="booking-review-card">
              <div className="booking-review-heading">
                <h3>ตรวจสอบข้อมูล</h3>
                <span>{readyToSubmit ? "ข้อมูลครบถ้วน" : "ยังมีข้อมูลที่ต้องกรอก"}</span>
              </div>
              <dl className="booking-review-list">
                <ReviewRow label="วันที่" value={formatThaiDate(date)} />
                <ReviewRow label="รอบเซสชัน" value={selectedSlot?.label ?? "-"} />
                <ReviewRow label="ชื่อเล่น" value={form.nickname || "-"} />
                <ReviewRow label="เบอร์โทรศัพท์" value={form.phone || "-"} />
                <ReviewRow label="วัน/เดือน/ปีเกิด" value={form.birthDateText || "-"} />
                <ReviewRow label="หัวข้อที่ต้องการปรึกษาพิเศษ" value={form.consultationTopic || "-"} />
              </dl>
            </div>
          </section>
        );

      case 5:
        return (
          <section className="booking-step-content" aria-labelledby="booking-step-title">
            <div className="booking-confirmation-card">
              <span className="booking-confirmation-mark" aria-hidden="true">✓</span>
              <div>
                <h3>ยืนยันรายละเอียดการจอง</h3>
                <p>ตรวจสอบข้อมูลอีกครั้งก่อนกดยืนยันการจองคิว</p>
              </div>
            </div>
            <div className="booking-final-review">
              <dl className="booking-review-list">
                <ReviewRow label="วันที่" value={formatThaiDate(date)} />
                <ReviewRow label="รอบเซสชัน" value={selectedSlot?.label ?? "-"} />
                <ReviewRow label="ชื่อเล่น" value={form.nickname || "-"} />
                <ReviewRow label="เบอร์โทรศัพท์" value={form.phone || "-"} />
                <ReviewRow label="วัน/เดือน/ปีเกิด" value={form.birthDateText || "-"} />
                <ReviewRow label="หัวข้อที่ต้องการปรึกษาพิเศษ" value={form.consultationTopic || "-"} />
                <ReviewRow label="รูปหน้าตรง" value={faceFile ? "แนบแล้ว" : "ยังไม่ได้แนบ"} />
              </dl>
            </div>
            <div className="booking-payment-handoff">
              <div className="booking-payment-line">
                <span>ยอดที่ต้องชำระ</span>
                <strong>{amount ? `${amount} บาท` : "แจ้งภายหลัง"}</strong>
              </div>
              <p>
                {payment.ready
                  ? "หลังยืนยันการจอง ระบบจะแสดงรายละเอียดการชำระเงิน"
                  : "ทีมงานจะติดต่อเพื่อแจ้งรายละเอียดการชำระเงิน"}
              </p>
            </div>
            <p className="booking-note booking-note-left">
              เมื่อจองแล้วระบบจะถือคิวให้ {holdMinutes} นาที เพื่อรอการชำระเงิน
            </p>
          </section>
        );
    }
  }

  return (
    <div className="booking-layout">
      <div className="booking-workspace">
        <nav className="booking-stepper" aria-label="ขั้นตอนการจอง">
          <ol className="booking-stepper-list">
            {BOOKING_WIZARD_STEPS.map((item, index) => {
              const itemStep = item.number as WizardStep;
              const status = getWizardStepStatus(itemStep, step, wizardState);
              const navigable = itemStep < step && status === "complete";
              return (
                <li
                  key={item.label}
                  className="booking-stepper-item"
                  data-state={status}
                >
                  <button
                    type="button"
                    onClick={() => goToStep(itemStep)}
                    disabled={itemStep > step || (!navigable && itemStep < step)}
                    aria-current={status === "current" ? "step" : undefined}
                    aria-label={`ขั้นตอนที่ ${item.number} ${item.label}`}
                  >
                    <span className="booking-stepper-dot" aria-hidden="true">
                      {status === "complete" ? "✓" : item.number}
                    </span>
                    <span className="booking-stepper-label">{item.label}</span>
                  </button>
                  {index < BOOKING_WIZARD_STEPS.length - 1 && (
                    <span className="booking-stepper-line" aria-hidden="true" />
                  )}
                </li>
              );
            })}
          </ol>
          <p className="booking-stepper-progress">ขั้นตอนที่ {step} จาก {BOOKING_WIZARD_STEPS.length}</p>
        </nav>

        <form
          onSubmit={onSubmit}
          className="booking-panel"
          aria-describedby="booking-step-description"
        >
          <div className="booking-panel-heading">
            <p className="booking-panel-kicker">ขั้นตอนที่ {step} จาก {BOOKING_WIZARD_STEPS.length}</p>
            <h2 id="booking-step-title" ref={stepHeadingRef} tabIndex={-1}>
              {currentStep.label}
            </h2>
            <p id="booking-step-description" className="booking-panel-description">
              {stepDescription(step)}
            </p>
          </div>

          <div className="booking-panel-body">{renderStep()}</div>

          {/* Honeypot — visually hidden, off the tab order, ignored by humans. */}
          <input
            type="text"
            name="company"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            className="booking-honeypot"
          />

          {error && (
            <p className="booking-alert booking-alert-error booking-form-error" role="alert">
              {error}
            </p>
          )}

          <div className="booking-actions">
            {step > 1 ? (
              <button
                type="button"
                onClick={goBack}
                disabled={submitting}
                className="booking-back"
              >
                ย้อนกลับ
              </button>
            ) : (
              <span className="booking-action-spacer" aria-hidden="true" />
            )}
            {step < 5 ? (
              <button
                type="button"
                onClick={advance}
                disabled={!canContinueWizard(step, wizardState) || loadingSlots && step === 2}
                className="booking-submit booking-continue"
              >
                ดำเนินการต่อ
              </button>
            ) : (
              <button
                type="submit"
                disabled={submitting || faceProcessing || !readyToSubmit}
                className="booking-submit"
              >
                {faceProcessing ? "กำลังปรับรูป..." : submitting ? "กำลังจอง..." : "ยืนยันการจองคิว"}
              </button>
            )}
          </div>
        </form>
      </div>

      <aside className="booking-summary" aria-label="สรุปการจอง">
        <div className="booking-summary-desktop">
          <BookingSummaryCard
            date={date}
            selectedSlot={selectedSlot}
            amount={amount}
            paymentReady={payment.ready}
            readyToSubmit={readyToSubmit}
            completedSteps={completedSteps}
            holdMinutes={holdMinutes}
            currentStep={step}
          />
        </div>
        <details className="booking-summary-mobile">
          <summary>
            <span>สรุปการจอง</span>
            <span className="booking-summary-preview">
              {selectedSlot?.label ?? "ยังไม่ได้เลือกรอบ"}
            </span>
          </summary>
          <BookingSummaryCard
            date={date}
            selectedSlot={selectedSlot}
            amount={amount}
            paymentReady={payment.ready}
            readyToSubmit={readyToSubmit}
            completedSteps={completedSteps}
            holdMinutes={holdMinutes}
            currentStep={step}
          />
        </details>
      </aside>
    </div>
  );
}

function BookingSummaryCard({
  date,
  selectedSlot,
  amount,
  paymentReady,
  readyToSubmit,
  completedSteps,
  holdMinutes,
  currentStep,
}: {
  date: string;
  selectedSlot: Slot | null;
  amount: string | null;
  paymentReady: boolean;
  readyToSubmit: boolean;
  completedSteps: number;
  holdMinutes: number;
  currentStep: WizardStep;
}) {
  return (
    <div className="booking-summary-card">
      <div className="booking-summary-heading">
        <div>
          <p className="booking-panel-kicker">รายละเอียด</p>
          <h2>สรุปการจอง</h2>
        </div>
        <span className="booking-summary-step">{currentStep}/5</span>
      </div>
      <dl className="booking-summary-list">
        <ReviewRow label="วันที่" value={formatThaiDate(date)} />
        <ReviewRow label="รอบเซสชัน" value={selectedSlot?.label ?? "-"} />
      </dl>
      <div className="booking-summary-total">
        <span>ยอดที่ต้องชำระ</span>
        <strong>{amount ? `${amount} บาท` : "แจ้งภายหลัง"}</strong>
      </div>
      <div className="booking-summary-status" data-ready={readyToSubmit ? "true" : undefined}>
        <span className="booking-summary-status-dot" aria-hidden="true" />
        <div>
          <strong>{readyToSubmit ? "พร้อมยืนยันการจอง" : `ดำเนินการแล้ว ${completedSteps} จาก 4 ขั้นตอน`}</strong>
          <span>
            {paymentReady
              ? "รายละเอียดการชำระเงินจะแสดงหลังยืนยัน"
              : "ทีมงานจะติดต่อเพื่อแจ้งรายละเอียดการชำระเงิน"}
          </span>
        </div>
      </div>
      <p className="booking-summary-note">
        เมื่อจองแล้วระบบจะถือคิวให้ {holdMinutes} นาที เพื่อรอการชำระเงิน
      </p>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="booking-review-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
