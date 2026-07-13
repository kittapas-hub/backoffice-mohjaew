import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { expireDuePaymentOrders } from "@/lib/payments/payment-transitions";

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

  // Payment orders past expiry (Phase 1 slip flow creates real orders now).
  // Never expires a booked/confirmed booking — see expire_due_payment_orders.
  // Non-fatal: booking expiry above already ran.
  const orders = await expireDuePaymentOrders();
  const expiredOrders = orders.ok ? orders.expired : 0;

  // Orphan face-upload cleanup ------------------------------------------------
  // claim_expired_face_uploads_for_cleanup uses FOR UPDATE SKIP LOCKED to
  // atomically assign a cleanup_token lease to each row. Two concurrent cron
  // runs cannot claim the same row; one will simply get fewer (or zero) rows.
  const { data: claimed, error: claimErr } = await db.rpc(
    "claim_expired_face_uploads_for_cleanup",
    { p_batch_size: 25 },
  );
  if (claimErr) {
    console.error("[cron] claim_expired_face_uploads_for_cleanup failed", claimErr);
    // Return partial success rather than 500 — bookings expiry already ran.
    return NextResponse.json({ expired: data ?? 0, expiredOrders, cleanedFaces: 0, claimError: true });
  }

  type ClaimedRow = { id: string; storage_path: string; cleanup_token: string };
  let cleanedFaces = 0;

  for (const row of (claimed ?? []) as ClaimedRow[]) {
    const { error: storageErr } = await db.storage
      .from("booking-faces")
      .remove([row.storage_path]);

    // Treat "object not found" as success: it was already deleted.
    const alreadyGone =
      !storageErr ||
      storageErr.message?.toLowerCase().includes("not found") ||
      (storageErr as { statusCode?: string | number }).statusCode === 404 ||
      (storageErr as { statusCode?: string | number }).statusCode === "404";

    if (alreadyGone) {
      // Token-verified mark-deleted: only succeeds if this run still owns the lease.
      // If Cron B re-claimed the row (new token), this call is a safe no-op.
      const { error: markErr } = await db.rpc("complete_face_upload_cleanup", {
        p_id: row.id,
        p_cleanup_token: row.cleanup_token,
      });
      if (markErr) {
        console.error("[cron] complete_face_upload_cleanup failed", row.id, markErr);
      } else {
        cleanedFaces++;
      }
    } else {
      // Real storage failure — record error on our own lease row and let the
      // lease expire so the next cron run retries with a fresh token.
      console.error("[cron] face storage delete failed, will retry", row.storage_path, storageErr);
      await db
        .from("booking_face_uploads")
        .update({ cleanup_last_error: String(storageErr!.message).slice(0, 500) })
        .eq("id", row.id)
        .eq("cleanup_token", row.cleanup_token) // guard: only touch our own lease
        .eq("status", "cleaning");
    }
  }

  return NextResponse.json({ expired: data ?? 0, expiredOrders, cleanedFaces });
}
