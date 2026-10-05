import { timingSafeEqual } from "node:crypto";
import { recoverChatJobs } from "@/lib/line-chat-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "not_configured" }, { status: 503 });
  const expected = Buffer.from("Bearer " + secret);
  const actual = Buffer.from(req.headers.get("authorization") ?? "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try { return Response.json(await recoverChatJobs()); }
  catch { return Response.json({ error: "chat_unavailable" }, { status: 503 }); }
}
