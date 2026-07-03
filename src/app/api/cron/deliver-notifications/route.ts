import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { pushMessage } from "@/lib/line";
import { runDeliveryWorker, DEFAULT_BATCH, TIME_BUDGET_MS } from "@/lib/notifications/delivery-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Delivers only recipient_type = 'team', event_type = 'payment_received' rows
// from the outbox (0007_team_notification_outbox.sql). Auth mirrors
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
  const groupId = process.env.LINE_BOOKING_NOTIFY_GROUP_ID;
  if (!token || !groupId) {
    return NextResponse.json(
      {
        error: "line_not_configured",
        message: "LINE_CHANNEL_ACCESS_TOKEN or LINE_BOOKING_NOTIFY_GROUP_ID is not configured",
      },
      { status: 503 },
    );
  }

  const result = await runDeliveryWorker({
    db: supabaseAdmin(),
    sendPush: pushMessage,
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
