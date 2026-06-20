"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";

const STATUSES = ["pending", "contacted", "confirmed", "cancelled"] as const;

export async function updateStatus(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !STATUSES.includes(status as (typeof STATUSES)[number])) return;

  const db = supabaseAdmin();
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
