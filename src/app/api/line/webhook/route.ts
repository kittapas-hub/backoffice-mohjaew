import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { bookingStartKeywords, APP_URL } from "@/lib/env";
import {
  getMessageContent,
  getUserDisplayName,
  notifyTeamSafe,
  replyMessage,
  verifyLineSignature,
} from "@/lib/line";
import {
  buildLegacyLineBookingRecord,
  createLineBookingIdempotently,
  hasMatchingImageSignature,
  mergeFields,
  parseFields,
  type CollectedFields,
  type LineBookingSession,
} from "@/lib/booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// LINE supports two compatible paths:
// 1) the preferred slot/capacity flow via /booking?source=line, and
// 2) the existing labeled LINE form, which creates a non-slot `pending` inquiry.
// A LINE form must never invent a slot or enter the payment state machine.

const SESSION_TTL_HOURS = 24;
const FACE_BUCKET = "booking-faces";
const FACE_MAX_BYTES = 5 * 1024 * 1024;
const FACE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const CONFIRM_TEXT =
  "ได้รับข้อมูลการจองคิวเรียบร้อยแล้วค่ะ\nทีมงานจะติดต่อกลับเพื่อยืนยันวันและเวลานัดหมายค่ะ";

type LineEvent = {
  type: string;
  webhookEventId?: string;
  replyToken?: string;
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  message?: { id: string; type: string; text?: string };
};

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature");

  if (!verifyLineSignature(rawBody, signature)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let body: { events?: LineEvent[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new NextResponse("Bad JSON", { status: 400 });
  }

  let failed = false;
  for (const event of body.events ?? []) {
    try {
      await handleEvent(event);
    } catch (err) {
      failed = true;
      await releaseEventClaim(event.webhookEventId);
      logLineError("event_failed", event.webhookEventId, err);
    }
  }

  if (failed) {
    // Successful events in the same batch are already claimed and will no-op
    // when LINE retries. Failed claims were released above for safe recovery.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

function bookingLinkMessage(): string {
  const link = APP_URL ? `${APP_URL}/booking?source=line` : null;
  return link
    ? `สวัสดีค่ะ 🙏\nจองคิวปรึกษาหมอแจวได้ที่ลิงก์นี้เลยค่ะ\n${link}`
    : "ขออภัยค่ะ ระบบจองออนไลน์ยังไม่พร้อมใช้งาน กรุณาติดต่อทีมงานค่ะ";
}

async function handleEvent(event: LineEvent) {
  if (event.source?.type === "group" || event.source?.type === "room") {
    console.info("[line] non-user event ignored", {
      sourceType: event.source.type,
    });
  }

  if (event.type !== "message" || !event.message) return;
  if (event.source?.type !== "user" || !event.source.userId) return;

  // Claim every actionable message, not only the start keyword. LINE may retry
  // text/image events; the event id prevents duplicate session mutations.
  if (event.webhookEventId) {
    const { error } = await supabaseAdmin()
      .from("line_webhook_events")
      .insert({ id: event.webhookEventId });
    if (error && error.code === "23505") return;
    if (error) throw new Error(`line_event_claim_failed:${error.code ?? "unknown"}`);
  }

  if (event.message.type === "text") {
    await handleText(
      event.source.userId,
      event.message.text ?? "",
      event.replyToken,
    );
    return;
  }

  if (event.message.type === "image") {
    await handleImage(
      event.source.userId,
      event.message.id,
      event.replyToken,
    );
  }
}

type SessionRow = LineBookingSession & {
  collected: CollectedFields;
  created_at: string;
  updated_at: string;
};

async function getActiveSession(userId: string): Promise<SessionRow | null> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("booking_sessions")
    .select(
      "id, line_user_id, line_display_name, status, collected, created_at, updated_at",
    )
    .eq("line_user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`line_session_read_failed:${error.code ?? "unknown"}`);
  if (!data) return null;

  const session = data as SessionRow;
  const lastActivity = new Date(
    session.updated_at ?? session.created_at,
  ).getTime();
  if (Date.now() - lastActivity <= SESSION_TTL_HOURS * 3_600_000) {
    return session;
  }

  const { error: expireError } = await db
    .from("booking_sessions")
    .update({ status: "expired" })
    .eq("id", session.id)
    .eq("status", "active");
  if (expireError) {
    throw new Error(`line_session_expire_failed:${expireError.code ?? "unknown"}`);
  }
  return null;
}

async function handleText(
  userId: string,
  text: string,
  replyToken: string | undefined,
) {
  const trimmed = text.trim();
  const isTrigger = bookingStartKeywords().some((k) => trimmed === k);

  if (isTrigger) {
    const existing = await getActiveSession(userId);
    if (!existing) {
      const displayName = await getUserDisplayName(userId);
      const { error } = await supabaseAdmin().from("booking_sessions").insert({
        line_user_id: userId,
        line_display_name: displayName,
        status: "active",
        collected: {},
      });
      // A concurrent trigger may have created the same active session.
      if (error && error.code !== "23505") {
        throw new Error(`line_session_create_failed:${error.code ?? "unknown"}`);
      }
    }
    if (replyToken) await replyMessage(replyToken, bookingLinkMessage());
    return;
  }

  const session = await getActiveSession(userId);
  if (!session) return;

  const merged = mergeFields(session.collected ?? {}, parseFields(text));
  const { error } = await supabaseAdmin()
    .from("booking_sessions")
    .update({ collected: merged, updated_at: new Date().toISOString() })
    .eq("id", session.id)
    .eq("status", "active");
  if (error) throw new Error(`line_session_update_failed:${error.code ?? "unknown"}`);

  await maybeComplete(session.id, replyToken);
}

async function handleImage(
  userId: string,
  messageId: string,
  replyToken: string | undefined,
) {
  const session = await getActiveSession(userId);
  if (!session) return;

  const content = await getMessageContent(messageId);
  if (!content) throw new Error("line_image_download_failed");
  if (
    !FACE_TYPES.has(content.contentType) ||
    content.buffer.byteLength === 0 ||
    content.buffer.byteLength > FACE_MAX_BYTES ||
    !hasMatchingImageSignature(content.buffer, content.contentType)
  ) {
    throw new Error("line_image_invalid");
  }

  const ext =
    content.contentType === "image/png"
      ? "png"
      : content.contentType === "image/webp"
        ? "webp"
        : "jpg";
  const messageHash = crypto
    .createHash("sha256")
    .update(messageId)
    .digest("hex");
  const storagePath = `${session.id}/${messageHash}.${ext}`;
  const db = supabaseAdmin();
  const { error: uploadError } = await db.storage
    .from(FACE_BUCKET)
    .upload(storagePath, content.buffer, {
      contentType: content.contentType,
      upsert: false,
    });
  if (uploadError && uploadError.statusCode !== "409") {
    throw new Error(`line_image_store_failed:${uploadError.statusCode ?? "unknown"}`);
  }

  const { error: imageError } = await db.from("booking_images").upsert(
    { session_id: session.id, storage_path: storagePath },
    { onConflict: "storage_path", ignoreDuplicates: true },
  );
  if (imageError) {
    throw new Error(`line_image_record_failed:${imageError.code ?? "unknown"}`);
  }

  const { error: touchError } = await db
    .from("booking_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", session.id)
    .eq("status", "active");
  if (touchError) {
    throw new Error(`line_session_touch_failed:${touchError.code ?? "unknown"}`);
  }

  await maybeComplete(session.id, replyToken);
}

async function maybeComplete(
  sessionId: string,
  replyToken: string | undefined,
) {
  const db = supabaseAdmin();
  const { data: session, error: sessionError } = await db
    .from("booking_sessions")
    .select(
      "id, line_user_id, line_display_name, status, collected, created_at, updated_at",
    )
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) {
    throw new Error(`line_session_complete_read_failed:${sessionError.code ?? "unknown"}`);
  }
  if (!session) return;

  const { count, error: imageCountError } = await db
    .from("booking_images")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId);
  if (imageCountError) {
    throw new Error(`line_image_count_failed:${imageCountError.code ?? "unknown"}`);
  }

  const bookingRecord = buildLegacyLineBookingRecord(
    session as SessionRow,
    (session.collected ?? {}) as CollectedFields,
    (count ?? 0) > 0,
  );
  if (!bookingRecord) return;

  const bookingId = await createLineBookingIdempotently(
    async () => {
      const { data, error } = await db
        .from("bookings")
        .insert(bookingRecord)
        .select("id")
        .single();
      return {
        id: data?.id ?? null,
        errorCode: error?.code ?? null,
      };
    },
    async () => {
      const { data, error } = await db
        .from("bookings")
        .select("id")
        .eq("session_id", sessionId)
        .maybeSingle();
      if (error) {
        throw new Error(
          `line_booking_idempotency_read_failed:${error.code ?? "unknown"}`,
        );
      }
      return data?.id ?? null;
    },
  );

  // Keep the session active until all related rows are linked. If either write
  // fails, a retried event finds the same booking via unique(session_id) and
  // resumes without creating another booking.
  const { error: linkError } = await db
    .from("booking_images")
    .update({ booking_id: bookingId })
    .eq("session_id", sessionId);
  if (linkError) {
    throw new Error(`line_booking_image_link_failed:${linkError.code ?? "unknown"}`);
  }

  const { error: completeError } = await db
    .from("booking_sessions")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("status", "active");
  if (completeError) {
    throw new Error(`line_session_complete_failed:${completeError.code ?? "unknown"}`);
  }

  if (replyToken) await replyMessage(replyToken, CONFIRM_TEXT);
  await notifyTeamSafe(
    [
      "📥 คำขอจองคิวใหม่จาก LINE",
      `เลขอ้างอิง: ${bookingId.slice(0, 8).toUpperCase()}`,
      `ช่วงเวลาที่สะดวก: ${bookingRecord.preferred_time}`,
      "สถานะ: รอดำเนินการ",
    ].join("\n"),
  );
}

async function releaseEventClaim(eventId: string | undefined) {
  if (!eventId) return;
  const { error } = await supabaseAdmin()
    .from("line_webhook_events")
    .delete()
    .eq("id", eventId);
  if (error) logLineError("event_claim_release_failed", eventId, error);
}

function logLineError(
  stage: string,
  eventId: string | undefined,
  error: unknown,
) {
  const safe =
    error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: "UnknownError" };
  // Do not log user ids, message text, reply tokens, images, or credentials.
  console.error("[line-booking]", {
    stage,
    eventId: eventId ?? null,
    ...safe,
  });
}
