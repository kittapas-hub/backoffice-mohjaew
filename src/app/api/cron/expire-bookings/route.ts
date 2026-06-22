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

  // Orphan face-upload cleanup ------------------------------------------------
  // Mark expired pending intents as 'cleaning' atomically. The FOR UPDATE lock
  // inside create_booking's face claim serializes against this UPDATE, so a row
  // being claimed right now will have status='claimed' and be skipped by the
  // WHERE status='pending' predicate.
  const now = new Date().toISOString();
  await db
    .from("booking_face_uploads")
    .update({ status: "cleaning" })
    .eq("status", "pending")
    .lt("expires_at", now);

  // Process all rows in 'cleaning' (includes failures from prior cron runs).
  const { data: toDelete } = await db
    .from("booking_face_uploads")
    .select("id, storage_path")
    .eq("status", "cleaning");

  let cleanedFaces = 0;
  for (const row of toDelete ?? []) {
    const { error: storageErr } = await db.storage
      .from("booking-faces")
      .remove([row.storage_path]);
    if (storageErr) {
      // Leave as 'cleaning' so the next cron run retries the storage delete.
      console.error("[cron] face storage delete failed, will retry", row.storage_path, storageErr);
      continue;
    }
    await db.from("booking_face_uploads").update({ status: "deleted" }).eq("id", row.id);
    cleanedFaces++;
  }

  return NextResponse.json({ expired: data ?? 0, cleanedFaces });
}
