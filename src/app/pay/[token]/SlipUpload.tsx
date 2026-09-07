"use client";

// Slip upload widget for /pay/[token]. Uses XMLHttpRequest (not fetch) so a
// real upload progress bar is possible. Shows: idle → uploading (progress) →
// verifying → confirmed / error. Retry stays available for temporary
// failures; permanent mismatches show the server's guidance message.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Phase = "idle" | "uploading" | "verifying" | "confirmed" | "error" | "terminal";

type ServerFail = { error?: string; message?: string; retryable?: boolean };

const MAX_BYTES = 4 * 1024 * 1024;

export function SlipUpload({ token }: { token: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [retryable, setRetryable] = useState(true);

  useEffect(() => {
    return () => xhrRef.current?.abort();
  }, []);

  function onPick() {
    inputRef.current?.click();
  }

  function onFile(file: File | null) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setPhase("error");
      setRetryable(true);
      setMessage("รูปต้องมีขนาดไม่เกิน 4 MB");
      return;
    }
    setPhase("uploading");
    setProgress(0);
    setMessage("");

    const form = new FormData();
    form.append("file", file);

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", `/api/pay/${encodeURIComponent(token)}/slip`);
    xhr.responseType = "json";
    // Provider verification is bounded server-side; do not leave a mobile
    // checkout stuck in a busy state if the connection disappears silently.
    xhr.timeout = 30_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        setProgress(pct);
        if (pct >= 100) setPhase("verifying");
      }
    };
    xhr.onerror = () => {
      xhrRef.current = null;
      setPhase("error");
      setRetryable(true);
      setMessage("การเชื่อมต่อขัดข้อง กรุณาลองใหม่อีกครั้ง");
    };
    xhr.ontimeout = () => {
      xhrRef.current = null;
      setPhase("error");
      setRetryable(true);
      setMessage("การตรวจสอบใช้เวลานานเกินไป กรุณาลองใหม่อีกครั้ง");
    };
    xhr.onload = () => {
      xhrRef.current = null;
      const body = (xhr.response ?? {}) as { status?: string } & ServerFail;
      if (xhr.status === 200 && body.status === "confirmed") {
        setPhase("confirmed");
        // Refresh the server component so the page shows the paid state.
        setTimeout(() => router.refresh(), 1200);
        return;
      }
      if (body.error === "manual_review" || body.error === "order_closed") {
        // These states are terminal for this checkout. In particular, never
        // invite a customer to re-upload after money was routed to review or
        // after the hold/order was closed.
        setPhase("terminal");
        setRetryable(false);
        setMessage(body.message ?? "รายการนี้ปิดแล้ว กรุณาติดต่อทีมงาน");
        router.refresh();
        return;
      }
      setPhase("error");
      setRetryable(Boolean(body.retryable));
      setMessage(body.message ?? "เกิดข้อผิดพลาด กรุณาลองใหม่");
    };
    xhr.send(form);
  }

  if (phase === "confirmed") {
    return (
      <div className="checkout-alert" data-tone="success">
        <div style={{ fontSize: 30 }}>✅</div>
        <p className="checkout-alert-title" style={{ marginTop: 4 }}>
          ยืนยันการชำระเงินสำเร็จ
        </p>
        <p className="checkout-alert-body">คิวของคุณได้รับการยืนยันแล้ว</p>
      </div>
    );
  }

  if (phase === "terminal") {
    return (
      <div className="checkout-alert" data-tone="warn" role="alert">
        <p className="checkout-alert-title">รายการนี้ไม่สามารถส่งสลิปเพิ่มได้</p>
        <p className="checkout-alert-body">{message}</p>
      </div>
    );
  }

  const busy = phase === "uploading" || phase === "verifying";

  return (
    <div className="checkout-card">
      <h2 className="checkout-card-title" style={{ marginBottom: 4 }}>
        อัปโหลดสลิปเพื่อยืนยันอัตโนมัติ
      </h2>
      <p className="checkout-note" style={{ marginTop: 0, marginBottom: 16 }}>
        รองรับไฟล์ JPG, PNG, WebP ขนาดไม่เกิน 4 MB — ใช้รูปสลิปต้นฉบับจากแอปธนาคาร
      </p>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          // Permit retrying with the same image after a failed attempt.
          e.currentTarget.value = "";
          onFile(file);
        }}
        disabled={busy}
      />

      {busy ? (
        <div aria-live="polite">
          {phase === "uploading" ? (
            <>
              <div className="checkout-progress-track">
                <div
                  className="checkout-progress-fill"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="checkout-progress-text">กำลังอัปโหลด… {progress}%</p>
            </>
          ) : (
            <p className="checkout-verifying">กำลังตรวจสอบสลิปกับธนาคาร…</p>
          )}
        </div>
      ) : (
        <>
          {phase === "error" && (
            <div
              className="checkout-alert"
              data-tone={retryable ? "warn" : "error"}
              style={{ marginBottom: 12, textAlign: "left" }}
              role="alert"
            >
              {message}
            </div>
          )}
          <button type="button" onClick={onPick} className="checkout-btn">
            {phase === "error" && retryable ? "ลองอัปโหลดอีกครั้ง" : "เลือกรูปสลิป"}
          </button>
        </>
      )}
    </div>
  );
}
