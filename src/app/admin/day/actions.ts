"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";

// Slot-booking status changes live in transitionSlotBooking (../actions). These
// actions only manage the slots themselves (seed / capacity / open-close).

// Default bookable units are hourly slots. The UI can still present them as a
// day schedule, but capacity is tracked per hour so past time blocks disappear
// naturally instead of keeping a large 3-hour round open.
const DEFAULT_HOURLY_SLOTS = Array.from({ length: 12 }, (_, i) => {
  const startHour = 9 + i;
  const endHour = startHour + 1;
  const start = `${String(startHour).padStart(2, "0")}:00`;
  const end = `${String(endHour).padStart(2, "0")}:00`;
  return {
    start_time: start,
    end_time: end,
    label: `${start}–${end}`,
  };
});

function refresh(date: string) {
  revalidatePath("/admin/day");
  revalidatePath(`/admin/day?date=${date}`);
}

export async function seedDaySlots(formData: FormData) {
  await requireAdmin();
  const date = String(formData.get("date") ?? "");
  if (!date) return;

  const db = supabaseAdmin();
  // Idempotent: unique(booking_date,start,end) means re-seeding is a no-op.
  await db.from("booking_slots").upsert(
    DEFAULT_HOURLY_SLOTS.map((r) => ({ ...r, booking_date: date, capacity: 1 })),
    { onConflict: "booking_date,start_time,end_time", ignoreDuplicates: true },
  );
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
