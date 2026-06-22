import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Expires pending_payment bookings past their hold and frees their seats.
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

  const db = supabaseAdmin();
  const { data, error } = await db.rpc("expire_pending_bookings");
  if (error) {
    console.error("expire_pending_bookings failed", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  return NextResponse.json({ expired: data ?? 0 });
}
