import { verifyLineSignature } from "@/lib/line";
import { replyToPostback, replyToTextMessage } from "@/lib/line-campaign";
import { hashLineUatPairingCode } from "@/lib/line-uat-pairing";
import { handleLineWebhookRequest } from "@/lib/line-webhook";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleLineWebhookRequest(req, {
    verifySignature: verifyLineSignature,
    async persistSelection({ lineUserId, campaign, segment, createdAt }) {
      const { error } = await supabaseAdmin().from("line_user_segments").upsert(
        { line_user_id: lineUserId, campaign, segment, created_at: createdAt },
        { onConflict: "line_user_id,campaign,segment", ignoreDuplicates: true },
      );
      if (error) throw new Error("line_segment_persistence_failed");
    },
    reply: replyToPostback,
    async completePairing({ code, lineUserId, pairedAt }) {
      const { data, error } = await supabaseAdmin()
        .from("line_uat_pairings")
        .update({ line_user_id: lineUserId, paired_at: pairedAt })
        .eq("code_hash", hashLineUatPairingCode(code))
        .gt("expires_at", pairedAt)
        .is("line_user_id", null)
        .select("id")
        .maybeSingle();
      if (error) throw new Error("line_uat_pairing_failed");
      return Boolean(data);
    },
    replyPairing(replyToken) {
      return replyToTextMessage(replyToken, "เชื่อมบัญชี LINE สำหรับทดสอบ UAT สำเร็จแล้วค่ะ กลับไปที่ Backoffice เพื่อส่งข้อความทดสอบได้เลย");
    },
  });
}
