"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { generateCampaignDrafts, type CampaignDraft } from "@/lib/line-ai";
import {
  buildSeptemberWaitingQuickReply,
  isLiveBroadcastEnabled,
  sendLineBroadcast,
  sendLineUatPush,
  SEPTEMBER_WAITING_CAMPAIGN,
  validateLineUserId,
} from "@/lib/line-campaign";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type SendState = { kind: "idle" | "success" | "error"; message: string };
export type AiState = { kind: "idle" | "success" | "error"; message: string; drafts: CampaignDraft[] };

function campaignMessages(text: string) {
  const quickReply = buildSeptemberWaitingQuickReply();
  return [{ ...quickReply, text }];
}

async function audit(input: {
  mode: "uat" | "live";
  messageText: string;
  status: "success" | "failed";
  targetCount: number | null;
  lineStatus?: number;
  createdBy?: string;
}) {
  const { error } = await supabaseAdmin().from("line_campaign_runs").insert({
    campaign: SEPTEMBER_WAITING_CAMPAIGN,
    mode: input.mode,
    message_text: input.messageText,
    quick_reply_enabled: true,
    status: input.status,
    target_count: input.targetCount,
    line_status: input.lineStatus ?? null,
    created_by: input.createdBy ?? null,
  });
  return !error;
}

export async function sendUat(_state: SendState, formData: FormData): Promise<SendState> {
  const user = await requireAdmin();
  const messageText = String(formData.get("messageText") ?? "").trim();
  if (!messageText || messageText.length > 5000) {
    await audit({ mode: "uat", messageText, status: "failed", targetCount: 0, createdBy: user.email }).catch(() => false);
    return { kind: "error", message: "กรุณาใส่ข้อความไม่เกิน 5,000 ตัวอักษร" };
  }
  const target = validateLineUserId(process.env.LINE_UAT_USER_ID);
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!target || !token) {
    await audit({ mode: "uat", messageText, status: "failed", targetCount: 0, createdBy: user.email }).catch(() => false);
    return { kind: "error", message: "ยังส่งทดสอบไม่ได้ กรุณาตั้งค่า LINE สำหรับ UAT ให้ถูกต้อง" };
  }
  const result = await sendLineUatPush(target, campaignMessages(messageText), { accessToken: token, retryKey: crypto.randomUUID() });
  const audited = await audit({ mode: "uat", messageText, status: result.ok ? "success" : "failed", targetCount: 1, lineStatus: result.ok ? 200 : result.status, createdBy: user.email }).catch(() => false);
  revalidatePath("/admin/line");
  if (!result.ok) return { kind: "error", message: "ส่งทดสอบไม่สำเร็จ กรุณาตรวจการตั้งค่าแล้วลองใหม่" };
  return { kind: "success", message: audited ? "ส่งข้อความทดสอบสำเร็จ และบันทึกประวัติแล้ว" : "ส่งข้อความทดสอบสำเร็จ แต่บันทึกประวัติไม่ได้" };
}

export async function sendLive(_state: SendState, formData: FormData): Promise<SendState> {
  const user = await requireAdmin();
  const messageText = String(formData.get("messageText") ?? "").trim();
  if (!isLiveBroadcastEnabled() || String(formData.get("confirmation") ?? "") !== "BROADCAST") return { kind: "error", message: "Live broadcast ถูกปิด หรือคำยืนยันไม่ถูกต้อง" };
  if (!messageText || messageText.length > 5000) return { kind: "error", message: "ข้อความไม่ถูกต้อง" };
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { kind: "error", message: "ยังไม่ได้ตั้งค่า LINE" };
  const result = await sendLineBroadcast(campaignMessages(messageText), { accessToken: token, retryKey: crypto.randomUUID() });
  await audit({ mode: "live", messageText, status: result.ok ? "success" : "failed", targetCount: null, lineStatus: result.ok ? 200 : result.status, createdBy: user.email }).catch(() => false);
  revalidatePath("/admin/line");
  return result.ok ? { kind: "success", message: "ส่ง Live broadcast สำเร็จ" } : { kind: "error", message: "ส่ง Live broadcast ไม่สำเร็จ" };
}

export async function draftWithAi(_state: AiState, formData: FormData): Promise<AiState> {
  await requireAdmin();
  const result = await generateCampaignDrafts({ objective: String(formData.get("objective") ?? ""), audience: String(formData.get("audience") ?? ""), notes: String(formData.get("notes") ?? "") });
  if (!result.ok) return { kind: "error", drafts: [], message: result.error === "not_configured" ? "AI Assistant ยังไม่ได้ตั้งค่า" : result.error === "invalid_input" ? "กรุณากรอกเป้าหมายและกลุ่มเป้าหมาย" : "สร้างข้อความไม่ได้ในขณะนี้" };
  return { kind: "success", drafts: result.drafts, message: "ได้ร่างข้อความ 3 แบบแล้ว เลือกเพื่อนำไปแก้ไขใน Composer" };
}
