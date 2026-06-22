import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { bookingStartKeywords, APP_URL } from "@/lib/env";
import { verifyLineSignature, replyMessage } from "@/lib/line";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// IMPORTANT: this webhook does NOT create bookings. Every real booking must go
// through the central slot + capacity path (create_booking RPC) via /booking.
// When a customer starts a booking on LINE we reply with the central link
// (/booking?source=line). The webhook only handles messaging here; group-id
// logging stays for obtaining LINE_BOOKING_NOTIFY_GROUP_ID.

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

  for (const event of body.events ?? []) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error("Event handling error", err);
      // Always 200 so LINE doesn't retry-storm; we logged it.
    }
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
  // Diagnostic for obtaining LINE_BOOKING_NOTIFY_GROUP_ID. Logged to the server
  // console only (Vercel/local logs) — never replied or exposed publicly.
  if (event.source?.type === "group" && event.source.groupId) {
    console.log("[line] groupId (for LINE_BOOKING_NOTIFY_GROUP_ID):", event.source.groupId);
  } else if (event.source?.type === "room" && event.source.roomId) {
    console.log("[line] roomId:", event.source.roomId);
  }

  if (event.type !== "message" || event.message?.type !== "text") return;
  // Only one-to-one chats drive the booking link reply.
  if (event.source?.type !== "user" || !event.source.userId) return;

  const trimmed = (event.message.text ?? "").trim();
  const isTrigger = bookingStartKeywords().some((k) => trimmed === k);
  if (!isTrigger) return; // stay silent for unrelated messages

  // Idempotency: a retried trigger event must not send a duplicate reply.
  if (event.webhookEventId) {
    const { error } = await supabaseAdmin()
      .from("line_webhook_events")
      .insert({ id: event.webhookEventId });
    if (error && error.code === "23505") return;
  }

  if (event.replyToken) {
    await replyMessage(event.replyToken, bookingLinkMessage());
  }
}
