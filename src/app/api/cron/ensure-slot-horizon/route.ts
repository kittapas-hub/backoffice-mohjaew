import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ensureSlotHorizon } from "@/lib/slot-seeding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ensures customers always see at least 30 selectable calendar days on
// /booking by seeding a 31-date buffer (Bangkok today .. today+30) with
// default hourly slots — one day beyond the 30-day guarantee so the horizon
// never shrinks below 30 between Bangkok local midnight and this cron's next
// 04:10 Bangkok run. Seed-only: creates no booking records, never overwrites
// an existing slot's capacity/is_open/label, never deletes anything.
// ALWAYS requires CRON_SECRET via `Authorization: Bearer <CRON_SECRET>`.
// If CRON_SECRET is not configured, the endpoint is disabled (503) — it is
// never public, even though the operation itself is idempotent.
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

  try {
    const { startDate, endDate, createdCount } = await ensureSlotHorizon(supabaseAdmin());
    return NextResponse.json({ ok: true, startDate, endDate, createdCount });
  } catch (error) {
    console.error("ensureSlotHorizon failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
