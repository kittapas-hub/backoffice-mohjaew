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
} from "@/lib/line-campaign";
import { resolveLineUatTarget } from "@/lib/line-uat-pairing";
import { liveBroadcastDisposition, runLiveBroadcast, type LiveBroadcastOutcome } from "@/lib/line-live-broadcast";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type SendState = {
  kind: "idle" | "success" | "error";
  message: string;
  liveDisposition?: "new_allowed" | "retry_same" | "locked";
};
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
  const target = await resolveLineUatTarget(process.env.LINE_UAT_USER_ID, async () => {
    const { data, error } = await supabaseAdmin()
      .from("line_uat_pairings")
      .select("line_user_id")
      .not("paired_at", "is", null)
      .order("paired_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return error ? null : data?.line_user_id;
  });
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!target || !token) {
    await audit({ mode: "uat", messageText, status: "failed", targetCount: 0, createdBy: user.email }).catch(() => false);
    return { kind: "error", message: "ยังส่งทดสอบไม่ได้ กรุณาเชื่อมบัญชี LINE สำหรับ UAT ที่หน้า /admin/line/uat" };
  }
  const result = await sendLineUatPush(target, campaignMessages(messageText), { accessToken: token, retryKey: crypto.randomUUID() });
  const audited = await audit({ mode: "uat", messageText, status: result.ok ? "success" : "failed", targetCount: 1, lineStatus: result.ok ? 200 : result.status, createdBy: user.email }).catch(() => false);
  revalidatePath("/admin/line");
  if (!result.ok) return { kind: "error", message: "ส่งทดสอบไม่สำเร็จ กรุณาตรวจการตั้งค่าแล้วลองใหม่" };
  return audited
    ? { kind: "success", message: "ส่งข้อความทดสอบสำเร็จ และบันทึกประวัติแล้ว" }
    : { kind: "error", message: "ส่งข้อความทดสอบแล้ว แต่บันทึกประวัติไม่ได้ กรุณาตรวจสอบก่อนส่งซ้ำ" };
}

export async function sendLive(_state: SendState, formData: FormData): Promise<SendState> {
  const user = await requireAdmin();
  const messageText = String(formData.get("messageText") ?? "").trim();
  const requestKey = String(formData.get("requestKey") ?? "");
  if (!isLiveBroadcastEnabled() || String(formData.get("confirmation") ?? "") !== "BROADCAST") return { kind: "error", message: "Live broadcast ถูกปิด หรือคำยืนยันไม่ถูกต้อง" };
  if (!messageText || messageText.length > 5000) return { kind: "error", message: "ข้อความไม่ถูกต้อง" };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)) return { kind: "error", message: "รหัสคำขอไม่ถูกต้อง กรุณาโหลดหน้าใหม่" };
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { kind: "error", message: "ยังไม่ได้ตั้งค่า LINE" };

  const db = supabaseAdmin();
  const outcome = await runLiveBroadcast({
    async claim() {
      const { error } = await db.from("line_campaign_runs").insert({
        campaign: SEPTEMBER_WAITING_CAMPAIGN, mode: "live", message_text: messageText,
        quick_reply_enabled: true, status: "pending", target_count: null,
        line_status: null, created_by: user.email, request_key: requestKey,
      });
      if (!error) return "claimed";
      return error.code === "23505" ? "duplicate" : "error";
    },
    send: () => sendLineBroadcast(campaignMessages(messageText), { accessToken: token, retryKey: requestKey }),
    async finalize(status, lineStatus) {
      const { data, error } = await db.from("line_campaign_runs")
        .update({ status, line_status: lineStatus ?? null })
        .eq("request_key", requestKey).eq("mode", "live").eq("status", "pending")
        .select("id").maybeSingle();
      return !error && Boolean(data);
    },
  });
  revalidatePath("/admin/line");
  return liveOutcomeState(outcome);
}

function liveOutcomeState(outcome: LiveBroadcastOutcome): SendState {
  const liveDisposition = liveBroadcastDisposition(outcome);
  if (outcome === "success") return { kind: "success", liveDisposition, message: "ส่ง Live broadcast สำเร็จ และบันทึก Audit แล้ว" };
  if (outcome === "duplicate") return { kind: "error", liveDisposition, message: "คำขอนี้ถูกส่งไปแล้วหรือกำลังดำเนินการ ห้ามส่งซ้ำ กรุณาตรวจสอบประวัติ" };
  if (outcome === "claim_failed") return { kind: "error", liveDisposition, message: "เริ่มบันทึก Audit ไม่สำเร็จ จึงยังไม่ได้ส่ง LINE ลองใหม่ได้ด้วยรหัสคำขอเดิม" };
  if (outcome === "line_unknown") return { kind: "error", liveDisposition, message: "ไม่ทราบผลการส่งจาก LINE ห้ามส่งซ้ำ กรุณาตรวจสอบ LINE และ Audit ก่อน" };
  if (outcome === "audit_failed") return { kind: "error", liveDisposition, message: "อาจส่ง LINE สำเร็จแล้ว แต่บันทึก Audit ไม่สำเร็จ ห้ามส่งซ้ำ กรุณาตรวจสอบและติดต่อผู้ดูแลระบบ" };
  return { kind: "error", liveDisposition, message: "ส่ง Live broadcast ไม่สำเร็จ และบันทึก Audit แล้ว หากต้องการส่ง Broadcast ใหม่ให้เริ่มรายการใหม่" };
}

export async function draftWithAi(_state: AiState, formData: FormData): Promise<AiState> {
  await requireAdmin();
  const result = await generateCampaignDrafts({ objective: String(formData.get("objective") ?? ""), audience: String(formData.get("audience") ?? ""), notes: String(formData.get("notes") ?? "") });
  if (!result.ok) return { kind: "error", drafts: [], message: result.error === "not_configured" ? "AI Assistant ยังไม่ได้ตั้งค่า" : result.error === "invalid_input" ? "กรุณากรอกเป้าหมายและกลุ่มเป้าหมาย" : "สร้างข้อความไม่ได้ในขณะนี้" };
  return { kind: "success", drafts: result.drafts, message: "ได้ร่างข้อความ 3 แบบแล้ว เลือกเพื่อนำไปแก้ไขใน Composer" };
}
