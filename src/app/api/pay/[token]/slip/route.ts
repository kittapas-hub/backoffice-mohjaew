// POST /api/pay/[token]/slip — PromptPay slip upload + automatic verification.
//
// Trust model: the client supplies ONLY the checkout token (URL) and the
// image file. Amount, receiver, booking, and timestamps all come from the
// database and the verification provider, server-side. The slip image is
// forwarded to the provider and never logged.
//
// The confirmation itself is one atomic DB RPC (confirm_slip_payment) —
// see supabase/migrations/0011_slip_verification.sql.
//
// Payment-slip evidence storage (0013_payment_slip_notification_image.sql):
// once the image passes local validation, EasySlip provider verification,
// and slip policy checks — i.e. right before this route calls
// confirmSlipPayment — the original image is stored in the private
// 'payment-slips' bucket and recorded in public.payment_slip_images. Images
// that fail validation or provider verification are never stored.
import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { recordRateHit } from "@/lib/booking-core";
import { clientIp } from "@/lib/client-ip";
import { slipVerificationConfig } from "@/lib/env";
import { validateSlipImage } from "@/lib/image-meta";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { easySlipProvider } from "@/lib/payments/slip/easyslip";
import { evaluateSlipPolicy, receiverMatches } from "@/lib/payments/slip/policy";
import {
  fileFitsBeforeBuffering,
  validateUploadContentLength,
} from "@/lib/payments/slip/upload-guard";
import {
  confirmSlipPayment,
  countSlipAttempts,
  recordSlipRejection,
  redactTxRef,
  type SlipRejectionOutcome,
} from "@/lib/payments/slip/confirm";
import type { SlipVerificationProvider } from "@/lib/payments/slip/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SLIP_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const RATE_LIMIT = 10; // uploads / window / hashed IP
const RATE_WINDOW_SECONDS = 15 * 60;
const MAX_ATTEMPTS_PER_ORDER = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every customer-facing message is fixed text — no provider internals, no
// stack traces, no database identifiers.
const CONTACT_TEAM = "กรุณาติดต่อทีมงานทาง LINE พร้อมสลิปของคุณ";

type Fail = { error: string; message: string; retryable?: boolean };

function fail(status: number, body: Fail) {
  return NextResponse.json(body, { status });
}

function buildProvider(): SlipVerificationProvider | null {
  const cfg = slipVerificationConfig();
  if (!cfg.enabled || cfg.provider !== "easyslip_v2" || !cfg.easySlipApiKey) return null;
  return easySlipProvider({ apiKey: cfg.easySlipApiKey });
}

// Best-effort payment-slip evidence storage. Never throws, never blocks
// confirmation: a storage or network hiccup must not stop a real payment
// from being confirmed — it just means no slip image gets attached to the
// team notification. Every storage/DB call is wrapped so a thrown exception
// (not just a returned {error}) can never escape and crash the caller.
// Concurrent/repeated uploads for the same order are safe: the path is
// deterministic and upload() upserts, so re-verification attempts on the
// same still-open order simply overwrite with the latest image.
async function storeSlipEvidence(
  db: ReturnType<typeof supabaseAdmin>,
  orderId: string,
  bookingId: string,
  image: Buffer,
  mimeType: "image/jpeg" | "image/png" | "image/webp",
): Promise<void> {
  const path = `${bookingId}/${orderId}.${SLIP_EXT[mimeType]}`;
  try {
    const { error: uploadErr } = await db.storage
      .from("payment-slips")
      .upload(path, image, { contentType: mimeType, upsert: true });
    if (uploadErr) {
      console.error("[slip] evidence upload failed", { orderId });
      await recordEvidenceFailure(db, orderId, bookingId, "upload");
      return;
    }
  } catch {
    console.error("[slip] evidence upload threw", { orderId });
    await recordEvidenceFailure(db, orderId, bookingId, "upload");
    return;
  }

  try {
    const { error: insertErr } = await db.from("payment_slip_images").insert({
      payment_order_id: orderId,
      booking_id: bookingId,
      storage_path: path,
      mime_type: mimeType,
    });
    if (insertErr) {
      await cleanupUnreferencedUpload(db, orderId, path);
      console.error("[slip] evidence record failed", { orderId });
      await recordEvidenceFailure(db, orderId, bookingId, "record");
    }
  } catch {
    await cleanupUnreferencedUpload(db, orderId, path);
    console.error("[slip] evidence record threw", { orderId });
    await recordEvidenceFailure(db, orderId, bookingId, "record");
  }
}

// Only removes the just-uploaded object when no payment_slip_images row for
// this order exists at all — i.e. this really was the first attempt and
// nothing references the path yet. The path is deterministic and reused
// across repeated attempts on the same order, so if an EARLIER attempt
// already succeeded, that row still references this exact path even though
// this attempt's upsert just overwrote its bytes — deleting the object in
// that case would break a still-valid evidence record. Never throws.
async function cleanupUnreferencedUpload(
  db: ReturnType<typeof supabaseAdmin>,
  orderId: string,
  path: string,
): Promise<void> {
  try {
    const { count } = await db
      .from("payment_slip_images")
      .select("id", { count: "exact", head: true })
      .eq("payment_order_id", orderId);
    if (count && count > 0) return;
    await db.storage.from("payment-slips").remove([path]);
  } catch {
    // Best-effort only — see this file's storeSlipEvidence header and
    // 0013's migration header for the documented residual failure mode.
  }
}

// Durable, queryable record of a failed evidence write (see
// public.payment_slip_evidence_failures, 0013). Best-effort: if even this
// insert fails, there is nothing further to do — the console.error call
// beside every call site remains the last resort.
async function recordEvidenceFailure(
  db: ReturnType<typeof supabaseAdmin>,
  orderId: string,
  bookingId: string,
  stage: "upload" | "record",
): Promise<void> {
  try {
    await db.from("payment_slip_evidence_failures").insert({
      payment_order_id: orderId,
      booking_id: bookingId,
      stage,
    });
  } catch {
    // Nothing further to do — best-effort.
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!UUID_RE.test(token)) {
    return fail(404, { error: "order_not_found", message: "ไม่พบรายการชำระเงิน" });
  }

  // Server configuration — fail closed, never silently skip verification.
  const cfg = slipVerificationConfig();
  const rateSecret = process.env.BOOKING_RATE_LIMIT_SECRET;
  if (!cfg.enabled || cfg.provider !== "easyslip_v2" || !cfg.easySlipApiKey || !cfg.receiverProfile || cfg.receiverAccounts.length === 0 ||
      cfg.receiverNames.length === 0 || !rateSecret) {
    console.error("[slip] verification not configured (key/receiver/rate-limit)");
    return fail(503, {
      error: "not_configured",
      message: `ระบบตรวจสลิปอัตโนมัติยังไม่พร้อมใช้งาน ${CONTACT_TEAM}`,
    });
  }

  // Reject absent, ambiguous, or known-oversized bodies before multipart
  // parsing. The file has a tighter 4 MiB limit below; this request allowance
  // only covers multipart framing. Vercel currently documents a 4.5 MB
  // function request limit, but this guard also protects self-hosted runtime.
  const lengthDecision = validateUploadContentLength(req.headers.get("content-length"));
  if (!lengthDecision.ok) {
    if (lengthDecision.reason === "too_large") {
      return fail(413, { error: "request_too_large", message: "รูปต้องมีขนาดไม่เกิน 4 MB" });
    }
    return fail(lengthDecision.reason === "missing" ? 411 : 400, {
      error: "invalid_content_length",
      message: "คำขอไม่ถูกต้อง",
    });
  }

  // Cross-instance rate limit by hashed IP (no raw IP stored). This is before
  // formData(), buffer allocation, database order lookup, and provider calls.
  const ipHmac = crypto
    .createHmac("sha256", rateSecret)
    .update(`slip-upload:${clientIp(req)}`)
    .digest("hex");
  const hits = await recordRateHit(ipHmac, RATE_WINDOW_SECONDS);
  if (hits < 0) {
    return fail(500, { error: "server_error", message: "เกิดข้อผิดพลาด กรุณาลองใหม่", retryable: true });
  }
  if (hits > RATE_LIMIT) {
    return fail(429, {
      error: "rate_limited",
      message: "คุณอัปโหลดบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่",
      retryable: true,
    });
  }

  // Parse form only after the cheap whole-request and rate-limit gates.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, { error: "invalid_request", message: "คำขอไม่ถูกต้อง" });
  }
  if (String(form.get("company") ?? "").trim() !== "") {
    return fail(400, { error: "invalid_input", message: "ข้อมูลไม่ถูกต้อง" });
  }

  // Validate the file: presence, size, REAL signature and dimensions.
  const file = form.get("file");
  if (!(file instanceof File)) {
    return fail(400, { error: "missing_file", message: "กรุณาเลือกรูปสลิป" });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return fail(400, { error: "invalid_type", message: "รองรับเฉพาะ JPG, PNG, WebP" });
  }
  // File.size is metadata already parsed by FormData; reject before allocating
  // the second in-memory copy created by arrayBuffer(). Byte validation below
  // remains authoritative for actual type and dimensions.
  if (!fileFitsBeforeBuffering(file.size)) {
    return fail(413, { error: "invalid_image", message: "รูปต้องมีขนาดไม่เกิน 4 MB" });
  }
  const image = Buffer.from(await file.arrayBuffer());
  const imgCheck = validateSlipImage(image);
  if (!imgCheck.ok) {
    const message =
      imgCheck.error === "too_large"
        ? "รูปต้องมีขนาดไม่เกิน 4 MB"
        : "ไฟล์ไม่ใช่รูปภาพที่ถูกต้อง กรุณาเลือกรูปสลิปใหม่";
    return fail(400, { error: "invalid_image", message });
  }

  // Resolve order + booking SERVER-SIDE from the token. Nothing about the
  // payment is taken from the request beyond the token and the image.
  const db = supabaseAdmin();
  const { data: order } = await db
    .from("payment_orders")
    .select("id, booking_id, status, amount_satang, expires_at, created_at")
    .eq("checkout_token", token)
    .maybeSingle();
  if (!order) {
    return fail(404, { error: "order_not_found", message: "ไม่พบรายการชำระเงิน" });
  }
  if (order.status === "paid") {
    return NextResponse.json({ status: "confirmed" }); // idempotent UX
  }
  if (order.status === "manual_review") {
    return fail(409, {
      error: "manual_review",
      message: `รายการนี้อยู่ระหว่างการตรวจสอบโดยทีมงาน ${CONTACT_TEAM}`,
    });
  }
  if (order.status !== "created" && order.status !== "pending") {
    return fail(409, { error: "order_closed", message: "รายการนี้ปิดแล้ว กรุณาจองคิวใหม่" });
  }

  // Do not pre-reject an expired hold here. A provider-verified upload after
  // expiry must reach the locked RPC so the real transaction is claimed and
  // safely routed to manual review rather than remaining replayable.

  // Per-order attempt ceiling (abuse control / provider quota protection).
  const attempts = await countSlipAttempts(order.id);
  if (attempts < 0) {
    return fail(500, { error: "server_error", message: "เกิดข้อผิดพลาด กรุณาลองใหม่", retryable: true });
  }
  if (attempts >= MAX_ATTEMPTS_PER_ORDER) {
    return fail(429, {
      error: "attempts_exceeded",
      message: `ตรวจสอบอัตโนมัติไม่สำเร็จหลายครั้ง ${CONTACT_TEAM}`,
    });
  }

  // Verify with the provider (server-to-server; key never leaves the server).
  const provider = buildProvider();
  if (!provider) {
    return fail(503, { error: "not_configured", message: `ระบบตรวจสลิปอัตโนมัติยังไม่พร้อมใช้งาน ${CONTACT_TEAM}` });
  }
  const verified = await provider.verify({ image, mimeType: imgCheck.meta.type });

  if (!verified.ok) {
    const audit: Record<string, SlipRejectionOutcome> = {
      unreadable_image: "invalid_image",
      slip_not_found: "provider_unverified",
      malformed_response: "provider_error",
      provider_timeout: "provider_error",
      provider_rate_limited: "provider_error",
      provider_auth_error: "provider_error",
      provider_error: "provider_error",
    };
    await recordSlipRejection({
      paymentOrderId: order.id,
      bookingId: order.booking_id,
      provider: provider.name,
      outcome: audit[verified.reason] ?? "provider_error",
    });
    console.warn("[slip] verification failed", {
      orderId: order.id,
      reason: verified.reason,
    });
    if (verified.retryable) {
      return fail(503, {
        error: "verify_unavailable",
        message: "ระบบตรวจสลิปไม่ตอบสนองชั่วคราว กรุณาลองใหม่อีกครั้งในอีกสักครู่",
        retryable: true,
      });
    }
    return fail(422, {
      error: "verify_failed",
      message:
        verified.reason === "slip_not_found"
          ? `ไม่พบรายการโอนตามสลิปนี้ กรุณาตรวจสอบว่าเป็นสลิปล่าสุด หรือ${CONTACT_TEAM}`
          : `อ่านสลิปไม่สำเร็จ กรุณาใช้รูปสลิปต้นฉบับจากแอปธนาคาร หรือ${CONTACT_TEAM}`,
    });
  }

  // Trusted policy checks. Provider duplicates fail here; the independent
  // local (provider, normalized_tx_ref) uniqueness check remains in the RPC.
  const decision = evaluateSlipPolicy(verified.slip);
  if (!decision.ok) {
    await recordSlipRejection({
      paymentOrderId: order.id,
      bookingId: order.booking_id,
      provider: provider.name,
      outcome: decision.code,
      slip: verified.slip,
    });
    const redactedTxRef = redactTxRef(verified.slip.providerTransactionReference);
    console.warn("[slip] policy rejected", {
      orderId: order.id,
      code: decision.code,
      txRef: redactedTxRef,
    });
    const messages: Record<string, string> = {
      tx_ref_missing: `อ่านเลขอ้างอิงธุรกรรมจากสลิปไม่ได้ กรุณาใช้สลิปต้นฉบับ หรือ${CONTACT_TEAM}`,
      receiver_mismatch: `บัญชีผู้รับในสลิปไม่ตรงกับบัญชีร้าน กรุณาตรวจสอบว่าโอนถูกบัญชี หรือ${CONTACT_TEAM}`,
      timestamp_out_of_window: `เวลาโอนในสลิปอยู่นอกช่วงเวลาชำระของคิวนี้ ${CONTACT_TEAM}`,
    };
    if (decision.code === "duplicate_tx") {
      return fail(409, {
        error: "duplicate_tx",
        message: `สลิปนี้ถูกใช้ยืนยันรายการอื่นไปแล้ว ${CONTACT_TEAM}`,
      });
    }
    return fail(422, { error: decision.code, message: messages[decision.code] });
  }

  // The provider must have read a positive amount; the equality check against
  // the trusted order amount happens INSIDE the atomic RPC (race-free).
  if (!verified.slip.amountSatang || verified.slip.amountSatang <= 0) {
    await recordSlipRejection({
      paymentOrderId: order.id,
      bookingId: order.booking_id,
      provider: provider.name,
      outcome: "provider_unverified",
      slip: verified.slip,
    });
    return fail(422, {
      error: "verify_failed",
      message: `อ่านยอดโอนจากสลิปไม่ได้ กรุณาใช้สลิปต้นฉบับ หรือ${CONTACT_TEAM}`,
    });
  }

  // Retain the validated original as payment evidence — only now, once local
  // validation, provider verification, and policy checks have all passed.
  await storeSlipEvidence(db, order.id, order.booking_id, image, imgCheck.meta.type);

  // One atomic, idempotent confirmation.
  const confirmed = await confirmSlipPayment({
    paymentOrderId: order.id,
    slip: verified.slip,
    receiverProfile: receiverMatches(verified.slip.receiver, {
      accounts: cfg.receiverAccounts,
      names: cfg.receiverNames,
    }) ? cfg.receiverProfile : null,
  });

  switch (confirmed.result) {
    case "ok":
    case "already_paid":
      return NextResponse.json({ status: "confirmed" });
    case "rejected":
      if (confirmed.reason === "duplicate_tx") {
        return fail(409, {
          error: "duplicate_tx",
          message: `สลิปนี้ถูกใช้ยืนยันรายการอื่นไปแล้ว ${CONTACT_TEAM}`,
        });
      }
      if (confirmed.reason === "amount_mismatch") {
        return fail(422, {
          error: "amount_mismatch",
          message: `ยอดโอนไม่ตรงกับยอดที่ต้องชำระ ${CONTACT_TEAM}`,
        });
      }
      return fail(409, { error: "order_closed", message: "รายการนี้ปิดแล้ว กรุณาจองคิวใหม่" });
    case "manual_review":
      return fail(409, {
        error: "manual_review",
        message: `ระบบได้รับสลิปแล้ว แต่ต้องให้ทีมงานตรวจสอบเพิ่มเติม ${CONTACT_TEAM}`,
      });
    default:
      return fail(500, { error: "server_error", message: "เกิดข้อผิดพลาด กรุณาลองใหม่", retryable: true });
  }
}
