import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { serverEnv, bookingStartKeywords } from "@/lib/env";
import {
  verifyLineSignature,
  replyMessage,
  pushMessage,
  getUserDisplayName,
  getMessageContent,
} from "@/lib/line";
import {
  parseFields,
  mergeFields,
  hasAllRequired,
  type CollectedFields,
} from "@/lib/booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "booking-faces";

// An active session older than this (by last activity) is treated as abandoned
// and expired, so unrelated future messages never reuse it.
const SESSION_TTL_HOURS = 24;

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

  const events = body.events ?? [];
  // Process sequentially; volume is low and each event mutates shared session state.
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error("Event handling error", err);
      // Always 200 so LINE doesn't retry-storm; we logged it.
    }
  }

  return NextResponse.json({ ok: true });
}

async function handleEvent(event: LineEvent) {
  // Diagnostic for obtaining LINE_BOOKING_NOTIFY_GROUP_ID: when the OA is in a
  // group/room, LINE includes its id here. Logged to the server console only
  // (Vercel/local logs) — never replied or exposed publicly. See README.
  if (event.source?.type === "group" && event.source.groupId) {
    console.log("[line] groupId (for LINE_BOOKING_NOTIFY_GROUP_ID):", event.source.groupId);
  } else if (event.source?.type === "room" && event.source.roomId) {
    console.log("[line] roomId:", event.source.roomId);
  }

  if (event.type !== "message" || !event.message) return;
  // Only one-to-one chats drive bookings.
  if (event.source?.type !== "user" || !event.source.userId) return;

  const db = supabaseAdmin();

  // Idempotency: skip events we've already processed.
  if (event.webhookEventId) {
    const { error } = await db
      .from("line_webhook_events")
      .insert({ id: event.webhookEventId });
    // Duplicate primary key => already handled.
    if (error && error.code === "23505") return;
  }

  const userId = event.source.userId;

  if (event.message.type === "text") {
    await handleText(userId, event.message.text ?? "", event.replyToken);
  } else if (event.message.type === "image") {
    await handleImage(userId, event.message.id, event.replyToken);
  }
}

type SessionRow = {
  id: string;
  line_display_name: string | null;
  collected: CollectedFields;
  created_at: string;
  updated_at: string;
};

async function getActiveSession(userId: string): Promise<SessionRow | null> {
  const db = supabaseAdmin();
  const { data } = await db
    .from("booking_sessions")
    .select("*")
    .eq("line_user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;

  const lastActivity = new Date(data.updated_at ?? data.created_at).getTime();
  if (Date.now() - lastActivity > SESSION_TTL_HOURS * 3_600_000) {
    // Expire the stale session so it isn't reused by unrelated future messages.
    await db
      .from("booking_sessions")
      .update({ status: "expired" })
      .eq("id", data.id);
    return null;
  }
  return data as SessionRow;
}

async function handleText(
  userId: string,
  text: string,
  replyToken: string | undefined,
) {
  const db = supabaseAdmin();
  const trimmed = text.trim();
  const isTrigger = bookingStartKeywords().some((k) => trimmed === k);

  if (isTrigger) {
    // Start a session only if none is active. Do NOT send the form (OA already does).
    const existing = await getActiveSession(userId);
    if (existing) return;
    const displayName = await getUserDisplayName(userId);
    await db.from("booking_sessions").insert({
      line_user_id: userId,
      line_display_name: displayName,
      status: "active",
      collected: {},
    });
    return;
  }

  const session = await getActiveSession(userId);
  if (!session) return; // Not in a booking flow; stay silent.

  const merged = mergeFields(session.collected ?? {}, parseFields(text));
  await db
    .from("booking_sessions")
    .update({ collected: merged, updated_at: new Date().toISOString() })
    .eq("id", session.id);

  await maybeComplete(session.id, replyToken);
}

async function handleImage(
  userId: string,
  messageId: string,
  replyToken: string | undefined,
) {
  const db = supabaseAdmin();
  const session = await getActiveSession(userId);
  if (!session) return;

  const content = await getMessageContent(messageId);
  if (!content) return;

  const ext = content.contentType.includes("png") ? "png" : "jpg";
  const path = `${session.id}/${messageId}.${ext}`;

  const { error: upErr } = await db.storage
    .from(BUCKET)
    .upload(path, content.buffer, {
      contentType: content.contentType,
      upsert: true,
    });
  if (upErr) {
    console.error("Storage upload failed", upErr);
    return;
  }

  // Idempotent: a retried image event maps to the same storage_path.
  await db.from("booking_images").upsert(
    { session_id: session.id, storage_path: path },
    { onConflict: "storage_path", ignoreDuplicates: true },
  );

  // Image activity counts as activity — keep the session from expiring.
  await db
    .from("booking_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", session.id);

  await maybeComplete(session.id, replyToken);
}

// Create the booking once all required text fields and >=1 image exist.
async function maybeComplete(sessionId: string, replyToken: string | undefined) {
  const db = supabaseAdmin();

  const { data: session } = await db
    .from("booking_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session || session.status !== "active") return;

  const fields = (session.collected ?? {}) as CollectedFields;
  if (!hasAllRequired(fields)) return;

  const { count } = await db
    .from("booking_images")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId);
  if (!count || count < 1) return;

  // Create exactly one booking, then flip the session to completed. The status
  // guard above plus the unique(session_id) constraint on bookings keep this
  // idempotent: a concurrent duplicate event hits 23505 and is dropped below.
  const { data: booking, error: bErr } = await db
    .from("bookings")
    .insert({
      session_id: sessionId,
      line_user_id: session.line_user_id,
      line_display_name: session.line_display_name,
      nickname: fields.nickname,
      birth_date_text: fields.birthDateText,
      consultation_topic: fields.consultationTopic,
      phone: fields.phone,
      preferred_time: fields.preferredTime,
      status: "pending",
    })
    .select()
    .single();
  if (bErr || !booking) {
    console.error("Booking insert failed", bErr);
    return;
  }

  await db
    .from("booking_sessions")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", sessionId);

  await db
    .from("booking_images")
    .update({ booking_id: booking.id })
    .eq("session_id", sessionId);

  // Customer confirmation.
  if (replyToken) await replyMessage(replyToken, CONFIRM_TEXT);

  // Internal group notification — no image exposed.
  const notify = [
    "📥 คำขอจองคิวใหม่",
    "",
    `ชื่อเล่น: ${fields.nickname}`,
    `ชื่อ LINE: ${session.line_display_name ?? "-"}`,
    `โทร: ${fields.phone}`,
    `วันเกิด: ${fields.birthDateText}`,
    `หัวข้อ: ${fields.consultationTopic}`,
    `สะดวก: ${fields.preferredTime}`,
    "รูปหน้าตรง: รับแล้ว",
    "สถานะ: รอทีมติดต่อ",
  ].join("\n");
  await pushMessage(serverEnv.notifyGroupId, notify);
}
