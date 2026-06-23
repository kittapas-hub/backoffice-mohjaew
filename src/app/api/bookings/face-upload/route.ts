import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { recordRateHit } from "@/lib/booking-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 15 * 60;

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(req: NextRequest) {
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
    .select("id")
    .eq("idempotency_key", idempotencyKey)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ uploadToken: existing.id });
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
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "too_large", message: "รูปต้องมีขนาดไม่เกิน 5 MB" },
      { status: 400 },
    );
  }

  // 7. Generate uploadToken (= DB primary key) and server-controlled path.
  //    Client never sees the storage path — only the opaque uploadToken UUID.
  const uploadToken = crypto.randomUUID();
  const storagePath = `faces/${uploadToken}.${EXT[file.type]}`;

  // 8. Insert intent row first; storage upload is the second step.
  const { error: insertErr } = await db.from("booking_face_uploads").insert({
    id: uploadToken,
    idempotency_key: idempotencyKey,
    storage_path: storagePath,
    mime_type: file.type,
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

  // 9. Upload file to the private storage bucket.
  const buffer = Buffer.from(await file.arrayBuffer());
  const { error: storageErr } = await db.storage
    .from("booking-faces")
    .upload(storagePath, buffer, { contentType: file.type, upsert: false });

  if (storageErr) {
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
