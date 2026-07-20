import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { pushMessage, pushImageMessage, validateLineGroupId } from "@/lib/line";
import { runDeliveryWorker, DEFAULT_BATCH, TIME_BUDGET_MS } from "@/lib/notifications/delivery-worker";
import { APP_URL } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Short-lived: the URL is minted right before sending and is never persisted
// or logged. 5 minutes matches the admin-view signed URL TTL elsewhere.
const FACE_URL_TTL_SECONDS = 300;

async function signFaceUrl(storagePath: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin()
      .storage.from("booking-faces")
      .createSignedUrl(storagePath, FACE_URL_TTL_SECONDS);
    return data?.signedUrl ?? null;
  } catch {
    return null;
  }
}

// Delivers only recipient_type = 'team' rows (payment_received,
// slip_manual_review, booking_confirmed) from the outbox
// (0007_team_notification_outbox.sql, 0011_slip_verification.sql,
// 0012_booking_confirmed_notification.sql). Auth mirrors
// /api/cron/expire-bookings exactly: missing CRON_SECRET => 503 (never
// public), wrong/missing bearer token => 401.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "cron_disabled", message: "CRON_SECRET is not configured" },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // Kill switch: OFF unless explicitly the literal string "true". No row is
  // claimed while disabled.
  if (process.env.OUTBOX_DELIVERY_ENABLED !== "true") {
    return NextResponse.json({ ok: true, enabled: false, processed: 0, sent: 0, retried: 0, dead: 0 });
  }

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  // Fails closed on blank/whitespace/malformed values (including a userId
  // "U…" or roomId "R…" mistakenly pasted in place of a groupId "C…") before
  // any row is ever claimed — there is no fallback recipient.
  const groupId = validateLineGroupId(process.env.LINE_BOOKING_GROUP_ID);
  if (!token || !groupId) {
    return NextResponse.json(
      {
        error: "line_not_configured",
        message: "LINE_CHANNEL_ACCESS_TOKEN is missing or LINE_BOOKING_GROUP_ID is missing/invalid",
      },
      { status: 503 },
    );
  }

  const result = await runDeliveryWorker({
    db: supabaseAdmin(),
    sendPush: pushMessage,
    sendImage: pushImageMessage,
    signFaceUrl,
    appUrl: APP_URL || undefined,
    groupId,
    now: () => Date.now(),
    batch: DEFAULT_BATCH,
    timeBudgetMs: TIME_BUDGET_MS,
  });

  // Never surface a claim/completion RPC failure as a 200 — the caller must
  // be able to tell delivery genuinely ran from "it silently failed".
  if (!result.ok) {
    return NextResponse.json({ error: "worker_failed" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    enabled: true,
    processed: result.processed,
    sent: result.sent,
    retried: result.retried,
    dead: result.dead,
  });
}
