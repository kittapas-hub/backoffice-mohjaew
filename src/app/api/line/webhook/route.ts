import { verifyLineSignature } from "@/lib/line";
import { replyToPostback } from "@/lib/line-campaign";
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
  });
}
