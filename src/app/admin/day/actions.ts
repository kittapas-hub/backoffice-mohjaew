"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { seedSlotsForDate } from "@/lib/slot-seeding";

// Slot-booking status changes live in transitionSlotBooking (../actions). These
// actions only manage the slots themselves (seed / capacity / open-close).

function refresh(date: string) {
  revalidatePath("/admin/day");
  revalidatePath(`/admin/day?date=${date}`);
}

export async function seedDaySlots(formData: FormData) {
  await requireAdmin();
  const date = String(formData.get("date") ?? "");
  if (!date) return;

  await seedSlotsForDate(supabaseAdmin(), date);
  refresh(date);
}

export async function updateSlotCapacity(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("slotId") ?? "");
  const date = String(formData.get("date") ?? "");
  const capacity = Number(formData.get("capacity"));
  if (!id || !Number.isInteger(capacity) || capacity < 0) return;

  const db = supabaseAdmin();
  await db
    .from("booking_slots")
    .update({ capacity, updated_at: new Date().toISOString() })
    .eq("id", id);
  refresh(date);
}

export async function toggleSlot(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("slotId") ?? "");
  const date = String(formData.get("date") ?? "");
  const isOpen = String(formData.get("isOpen")) === "true";
  if (!id) return;

  const db = supabaseAdmin();
  await db
    .from("booking_slots")
    .update({ is_open: isOpen, updated_at: new Date().toISOString() })
    .eq("id", id);
  refresh(date);
}
