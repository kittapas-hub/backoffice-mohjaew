import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { recordRateHit } from "@/lib/booking-core";
import { clientIp } from "@/lib/client-ip";
import { sniffImage } from "@/lib/image-meta";
import {
  faceFileFitsBeforeBuffering,
  faceImageDimensionsFit,
  validateFaceUploadContentLength,
} from "@/lib/face-upload-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 15 * 60;

export async function POST(req: NextRequest) {
  // Reject malformed/oversized requests before multipart parsing allocates memory.
  const lengthDecision = validateFaceUploadContentLength(req.headers.get("content-length"));
  if (!lengthDecision.ok) {
    const status = lengthDecision.reason === "too_large" ? 413 : 400;
    return NextResponse.json(
      { error: lengthDecision.reason === "too_large" ? "too_large" : "invalid_request" },
      { status },
    );
  }

  // 1. Parse multipart form.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // 2. Honeypot: real users never fill this hidden field; bots do.
  if (String(form.get("company") ?? "").trim() !== "") {
    return NextResponse.json(
      { error: "invalid_input", message: "ข้อมูลไม่ถูกต้อง" },
      { status: 400 },
    );
  }

  // 3. Idempotency-Key — must be a valid UUID (same key ties upload to booking).
  const idempotencyKey = req.headers.get("idempotency-key") ?? "";
  if (!UUID_RE.test(idempotencyKey)) {
    return NextResponse.json(
      { error: "invalid_input", message: "ต้องมี Idempotency-Key ที่ถูกต้อง" },
      { status: 400 },
    );
  }

  const db = supabaseAdmin();

  // 4. Idempotency: return the existing pending upload for this key WITHOUT
  //    incrementing the rate limit. Retrying a lost network response with the
  //    same key is free — only genuinely new upload attempts are counted.
  const { data: existing } = await db
    .from("booking_face_uploads")
    .select("id, storage_path")
    .eq("idempotency_key", idempotencyKey)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (existing) {
    // The intent row is inserted before storage upload. A concurrent retry
    // must not claim an intent whose object is still being uploaded (or whose
    // first upload failed), otherwise create_booking could link a missing
    // object. Listing metadata avoids downloading the image just to verify
    // readiness; an uncertain check is retryable and does not consume a new
    // upload attempt.
    const pathParts = String(existing.storage_path).split("/");
    const fileName = pathParts[pathParts.length - 1] ?? "";
    const { data: objects, error: listErr } = await db.storage
      .from("booking-faces")
      .list("faces", { limit: 10, search: fileName });
    const objectReady =
      !listErr && objects?.some((object) => object.name === fileName);
    if (objectReady) return NextResponse.json({ uploadToken: existing.id });
    return NextResponse.json(
      { error: "upload_in_progress", message: "กำลังเตรียมรูป กรุณาลองใหม่อีกครั้ง" },
      { status: 409 },
    );
  }

  // 5. Rate limit: 5 new uploads / 15 min per hashed IP. Only reached when no
  //    existing pending upload was found, so idempotent retries never count.
  const secret = process.env.BOOKING_RATE_LIMIT_SECRET;
  if (!secret) {
    console.error("[face-upload] BOOKING_RATE_LIMIT_SECRET not configured");
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  const ipHmac = crypto
    .createHmac("sha256", secret)
    .update(`face-upload:${clientIp(req)}`)
    .digest("hex");
  const hits = await recordRateHit(ipHmac, RATE_WINDOW_SECONDS);
  if (hits < 0) {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  if (hits > RATE_LIMIT) {
    return NextResponse.json(
      { error: "rate_limited", message: "คุณอัปโหลดรูปบ่อยเกินไป กรุณาลองใหม่ภายหลัง" },
      { status: 429 },
    );
  }

  // 6. Validate file type and size.
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "missing_file", message: "กรุณาเลือกไฟล์รูปภาพ" },
      { status: 400 },
    );
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: "invalid_type", message: "รองรับเฉพาะ JPG, PNG, WebP" },
      { status: 400 },
    );
  }
  if (!faceFileFitsBeforeBuffering(file.size)) {
    return NextResponse.json(
      { error: "too_large", message: "รูปต้องมีขนาดไม่เกิน 4 MB" },
      { status: 400 },
    );
  }

  // 7. Sniff the real image type before trusting client metadata.
  const buffer = Buffer.from(await file.arrayBuffer());
  const meta = sniffImage(buffer);
  if (!meta || !ALLOWED_TYPES.has(meta.type)) {
    return NextResponse.json(
      { error: "invalid_type", message: "รองรับเฉพาะ JPG, PNG, WebP" },
      { status: 400 },
    );
  }
  if (!faceImageDimensionsFit(meta.width, meta.height)) {
    return NextResponse.json(
      { error: "invalid_dimensions", message: "รูปมีขนาดไม่เหมาะสม กรุณาเลือกรูปอื่น" },
      { status: 400 },
    );
  }

  // 8. Generate uploadToken (= DB primary key) and server-controlled path.
  //    Client never sees the storage path - only the opaque uploadToken UUID.
  const uploadToken = crypto.randomUUID();
  const storagePath = `faces/${uploadToken}.${EXT[meta.type]}`;

  // 9. Insert intent row first; storage upload is the second step.
  const { error: insertErr } = await db.from("booking_face_uploads").insert({
    id: uploadToken,
    idempotency_key: idempotencyKey,
    storage_path: storagePath,
    mime_type: meta.type,
    size_bytes: file.size,
    ip_hash: ipHmac, // HMAC, not raw IP
  });

  if (insertErr) {
    // Concurrent request with same key may have just won the insert race; re-check.
    if (insertErr.code === "23505") {
      const { data: raceWinner } = await db
        .from("booking_face_uploads")
        .select("id")
        .eq("idempotency_key", idempotencyKey)
        .eq("status", "pending")
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
      if (raceWinner) return NextResponse.json({ uploadToken: raceWinner.id });
    }
    console.error("[face-upload] DB insert failed", insertErr);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  // 10. Upload file to the private storage bucket.
  const { error: storageErr } = await db.storage
    .from("booking-faces")
    .upload(storagePath, buffer, { contentType: meta.type, upsert: false });

  if (storageErr) {
    // Remove a possible partial object before freeing the intent row. If the
    // DB delete also fails, the cleanup cron can still use the intent lease.
    await db.storage.from("booking-faces").remove([storagePath]);
    // Rollback the intent row so the idempotency key slot is freed.
    await db.from("booking_face_uploads").delete().eq("id", uploadToken);
    console.error("[face-upload] storage upload failed", storageErr);
    return NextResponse.json(
      { error: "upload_failed", message: "อัปโหลดรูปหน้าไม่สำเร็จ กรุณาลองใหม่" },
      { status: 500 },
    );
  }

  // Return only the opaque token — no path, no signed URL.
  return NextResponse.json({ uploadToken });
}
