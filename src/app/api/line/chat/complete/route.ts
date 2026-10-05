import { authorizedChatCallback, validUuid } from "@/lib/line-chat";
import { completeChatJob } from "@/lib/line-chat-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  if (!authorizedChatCallback(req.headers.get("authorization"))) return Response.json({ error: "unauthorized" }, { status: 401 });
  let body: { jobId?: unknown; leaseToken?: unknown; reply?: unknown; failed?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  if (!body || !validUuid(body.jobId) || !validUuid(body.leaseToken)) return Response.json({ error: "invalid_job" }, { status: 400 });
  const reply = body.failed === true ? null : typeof body.reply === "string" ? body.reply.trim() : undefined;
  if (reply === undefined || (reply !== null && (!reply || reply.length > 5000))) return Response.json({ error: "invalid_reply" }, { status: 400 });
  try { return Response.json({ ok: true, accepted: await completeChatJob(body.jobId, body.leaseToken, reply) }); }
  catch { return Response.json({ error: "chat_unavailable" }, { status: 503 }); }
}
