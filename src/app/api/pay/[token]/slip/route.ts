// POST /api/pay/[token]/slip — PromptPay slip upload + automatic verification.
//
// Trust model: the client supplies ONLY the checkout token (URL) and the
// image file. Amount, receiver, booking, and timestamps all come from the
// database and the verification provider, server-side. The slip image is
// forwarded to the provider and NEVER stored or logged.
//
// The confirmation itself is one atomic DB RPC (confirm_slip_payment) —
// see supabase/migrations/0011_slip_verification.sql.
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

  // Parse form + honeypot.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, { error: "invalid_request", message: "คำขอไม่ถูกต้อง" });
  }
  if (String(form.get("company") ?? "").trim() !== "") {
    return fail(400, { error: "invalid_input", message: "ข้อมูลไม่ถูกต้อง" });
  }

  // Cross-instance rate limit by hashed IP (no raw IP stored).
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

  // Validate the file: presence, size, REAL signature and dimensions.
  const file = form.get("file");
  if (!(file instanceof File)) {
    return fail(400, { error: "missing_file", message: "กรุณาเลือกรูปสลิป" });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return fail(400, { error: "invalid_type", message: "รองรับเฉพาะ JPG, PNG, WebP" });
  }
  const image = Buffer.from(await file.arrayBuffer());
  const imgCheck = validateSlipImage(image);
  if (!imgCheck.ok) {
    const message =
      imgCheck.error === "too_large"
        ? "รูปต้องมีขนาดไม่เกิน 5 MB"
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

  // Trusted policy checks (amount + duplicate checks live inside the RPC).
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
