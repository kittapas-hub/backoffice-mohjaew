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
    .select("slot_id")
    .eq("id", id)
    .maybeSingle();

  if (bk?.slot_id) {
    // Refuse to bypass the slot state machine.
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
