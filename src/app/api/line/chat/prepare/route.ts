import { authorizedChatCallback, validUuid } from "@/lib/line-chat";
import { prepareChatJob } from "@/lib/line-chat-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  if (!authorizedChatCallback(req.headers.get("authorization"))) return Response.json({ error: "unauthorized" }, { status: 401 });
  let body: { jobId?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  if (!body || !validUuid(body.jobId)) return Response.json({ error: "invalid_job" }, { status: 400 });
  try { return Response.json(await prepareChatJob(body.jobId)); }
  catch { return Response.json({ error: "chat_unavailable" }, { status: 503 }); }
}
