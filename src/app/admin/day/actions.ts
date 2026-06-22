"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";

// Slot-booking status changes live in transitionSlotBooking (../actions). These
// actions only manage the slots themselves (seed / capacity / open-close).

// Default rounds seeded for a day if none exist yet.
const DEFAULT_ROUNDS = [
  { start_time: "09:00", end_time: "12:00", label: "รอบเช้า 09:00–12:00" },
  { start_time: "12:00", end_time: "15:00", label: "รอบบ่าย 12:00–15:00" },
  { start_time: "15:00", end_time: "18:00", label: "รอบบ่าย 15:00–18:00" },
  { start_time: "18:00", end_time: "21:00", label: "รอบเย็น 18:00–21:00" },
];

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
    DEFAULT_ROUNDS.map((r) => ({ ...r, booking_date: date, capacity: 3 })),
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
