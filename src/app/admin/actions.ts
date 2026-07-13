"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { mapTransitionError } from "@/lib/confirm-error";

// Legacy statuses an admin may set on a NON-slot (legacy/manual) booking only.
const LEGACY_STATUSES = ["pending", "contacted", "confirmed", "cancelled"] as const;

// Every slot-booking state change goes through this — never a direct table
// update. The DB function locks booking + slot and validates the transition.
export async function transitionSlotBooking(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("bookingId") ?? "");
  const to = String(formData.get("to") ?? "");
  const redirectTo = String(formData.get("redirectTo") ?? "/admin");
  if (!id || !to) return;

  const db = supabaseAdmin();
  const { error } = await db.rpc("transition_slot_booking", {
    p_booking_id: id,
    p_to: to,
  });

  revalidatePath("/admin");
  revalidatePath("/admin/day");
  revalidatePath(`/admin/bookings/${id}`);

  if (error) {
    console.error("transition_slot_booking failed", error.message);
    const sep = redirectTo.includes("?") ? "&" : "?";
    redirect(`${redirectTo}${sep}error=${mapTransitionError(error.message)}`);
  }
  redirect(redirectTo);
}

// Hardened action for manual payment confirmation only.
// Target status is hardcoded server-side — the client never supplies it.
// Rejects if the booking is not currently pending_payment, or if its hold
// has already lapsed (fast-fail before the RPC, which enforces both rules
// atomically with a row lock using the DB's own clock — see hold_expired in
// transition_slot_booking, 0008_reject_expired_hold_confirmation.sql). This
// fast-fail check is a UX shortcut only; the RPC is the real invariant and
// is never bypassed even if this check is skewed by clock drift.
// Current contract: only an existing, provider-verified manual_review claim
// can be approved here; the older hold-check description above applies to the
// separately named confirmBookingOverride action below.
export async function confirmPayment(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("bookingId") ?? "");
  const redirectTo = String(formData.get("redirectTo") ?? "/admin");
  if (!id) return;

  const { error } = await supabaseAdmin().rpc("approve_manual_review_payment", {
    p_booking_id: id,
  });

  revalidatePath("/admin");
  revalidatePath("/admin/day");
  revalidatePath(`/admin/bookings/${id}`);

  const sep = redirectTo.includes("?") ? "&" : "?";
  if (error) {
    console.error("approve_manual_review_payment failed", { code: error.code });
    redirect(`${redirectTo}${sep}error=invalid_transition`);
  }
  redirect(`${redirectTo}${sep}success=payment_confirmed`);
}

// Explicit operational override: changes booking state only and records no
// verified transaction or paid payment order.
export async function confirmBookingOverride(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("bookingId") ?? "");
  const redirectTo = String(formData.get("redirectTo") ?? "/admin");
  if (!id) return;

  const db = supabaseAdmin();

  const { data: booking } = await db
    .from("bookings")
    .select("status, slot_id, hold_expires_at")
    .eq("id", id)
    .maybeSingle();

  if (booking?.status !== "pending_payment" || !booking.slot_id) {
    const sep = redirectTo.includes("?") ? "&" : "?";
    redirect(`${redirectTo}${sep}error=invalid_transition`);
  }
  if (
    !booking.hold_expires_at ||
    new Date(booking.hold_expires_at).getTime() <= Date.now()
  ) {
    const sep = redirectTo.includes("?") ? "&" : "?";
    redirect(`${redirectTo}${sep}error=hold_expired`);
  }

  const { error } = await db.rpc("transition_slot_booking", {
    p_booking_id: id,
    p_to: "confirmed", // never from client
  });

  revalidatePath("/admin");
  revalidatePath("/admin/day");
  revalidatePath(`/admin/bookings/${id}`);

  if (error) {
    console.error("confirmBookingOverride failed", error.message);
    const sep = redirectTo.includes("?") ? "&" : "?";
    redirect(`${redirectTo}${sep}error=${mapTransitionError(error.message)}`);
  }
  const sep = redirectTo.includes("?") ? "&" : "?";
  redirect(`${redirectTo}${sep}success=booking_override_confirmed`);
}

// Status change for LEGACY/manual bookings only (slot_id is null). Slot
// bookings must use transitionSlotBooking and are rejected here defensively.
export async function updateStatus(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !LEGACY_STATUSES.includes(status as (typeof LEGACY_STATUSES)[number])) {
    return;
  }

  const db = supabaseAdmin();
  const { data: bk } = await db
    .from("bookings")
    .select("slot_id, source")
    .eq("id", id)
    .maybeSingle();

  if (bk?.slot_id) {
    // Refuse to bypass the slot state machine.
    redirect(`/admin/bookings/${id}?error=invalid_transition`);
  }
  if (bk?.source === "line" && status === "confirmed") {
    // A LINE inquiry has no reserved slot. It must not be labelled confirmed
    // until a real slot booking has been created through the capacity-safe flow.
    redirect(`/admin/bookings/${id}?error=invalid_transition`);
  }

  await db
    .from("bookings")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);

  revalidatePath("/admin");
  revalidatePath(`/admin/bookings/${id}`);
}

export async function signOut() {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect("/admin/login");
}
