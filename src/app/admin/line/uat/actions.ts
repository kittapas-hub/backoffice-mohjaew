"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import {
  generateLineUatPairingCode,
  hashLineUatPairingCode,
  LINE_UAT_PAIRING_TTL_MS,
} from "@/lib/line-uat-pairing";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type PairingState = { kind: "idle" | "success" | "error"; code: string | null; message: string };

export async function createUatPairingCode(_state: PairingState): Promise<PairingState> {
  void _state;
  const user = await requireAdmin();
  const code = generateLineUatPairingCode();
  const { error } = await supabaseAdmin().from("line_uat_pairings").insert({
    code_hash: hashLineUatPairingCode(code),
    expires_at: new Date(Date.now() + LINE_UAT_PAIRING_TTL_MS).toISOString(),
    created_by: user.email ?? null,
  });
  if (error) return { kind: "error", code: null, message: "ยังสร้างรหัสไม่ได้ กรุณาตรวจว่าใช้ migration 0016 แล้ว" };
  revalidatePath("/admin/line/uat");
  return { kind: "success", code, message: "รหัสนี้ใช้ได้ 10 นาที และจะแสดงเฉพาะครั้งนี้" };
}
