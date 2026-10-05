import { supabaseAdmin } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import {
  buildChatMessages, chatScope, chatUserAllowed, chatbotConfig, chatbotEnabled,
  parseChatEvent, dispatchChatJobs, sendChatDelivery,
  type ChatHistoryRow, type ChatDelivery,
} from "./line-chat.ts";

type Job = ChatDelivery & {
  id: string; conversation_id: string; user_text: string; lease_token: string; status: string;
};
function db() { return supabaseAdmin(); }
async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(name, args);
  if (error) throw new Error("chat_database_unavailable");
  return data as T;
}
export async function enqueueChatEvent(raw: unknown) {
  if (!chatbotEnabled()) return null;
  const event = parseChatEvent(raw);
  if (!event || !chatUserAllowed(event.userId)) return null;
  if (!chatbotConfig()) throw new Error("chat_not_configured");
  return rpc<string | null>("line_chat_enqueue", {
    p_scope: chatScope(), p_user: event.userId, p_event: event.eventId,
    p_text: event.text, p_token: event.replyToken, p_timestamp: event.timestamp,
  });
}
export async function prepareChatJob(id: string) {
  if (!chatbotEnabled()) return { generate: false };
  const job = await rpc<Job | null>("line_chat_claim", { p_id: id, p_scope: chatScope() });
  if (!job) return { generate: false };
  const { data: conversation, error: conversationError } = await db().from("line_chat_conversations")
    .select("user_id").eq("id", job.conversation_id).eq("scope", chatScope()).single();
  if (conversationError || !conversation) throw new Error("chat_database_unavailable");
  if (!chatUserAllowed(conversation.user_id)) {
    await rpc("line_chat_set_mode", { p_id: job.conversation_id, p_scope: chatScope(), p_mode: "human" });
    return { generate: false };
  }
  const { data: history, error } = await db().from("line_chat_jobs")
    .select("user_text,reply_text,status,created_at,id").eq("conversation_id", job.conversation_id)
    .eq("status", "sent").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(6);
  if (error) throw new Error("chat_database_unavailable");
  return { generate: true, jobId: job.id, leaseToken: job.lease_token,
    messages: buildChatMessages((history ?? []).reverse() as ChatHistoryRow[], job.user_text) };
}
export async function deliverChatJob(id: string) {
  if (!chatbotEnabled()) return;
  const job = await rpc<Job | null>("line_chat_reserve_delivery", { p_id: id, p_scope: chatScope() });
  if (!job) return;
  if (!chatUserAllowed(job.user_id)) {
    await rpc("line_chat_delivery_receipt", { p_id: id, p_scope: chatScope(), p_lease: job.lease_token, p_outcome: "failed" });
    return;
  }
  const outcome = await sendChatDelivery(job, serverEnv.lineAccessToken);
  await rpc("line_chat_delivery_receipt", {
    p_id: id, p_scope: chatScope(), p_lease: job.lease_token, p_outcome: outcome,
  });
  // Explicit invalid-token rejection means nothing was sent. Reserve a separate push attempt.
  if (outcome === "expired_reply") await deliverChatJob(id);
}
export async function completeChatJob(id: string, lease: string, reply: string | null) {
  if (!chatbotEnabled()) return false;
  const accepted = await rpc<boolean>("line_chat_complete", {
    p_id: id, p_scope: chatScope(), p_lease: lease, p_reply: reply, p_error: reply === null,
  });
  if (accepted) await deliverChatJob(id);
  return accepted;
}
export async function recoverChatJobs() {
  if (!chatbotEnabled()) return { enabled: false, attempted: 0 };
  if (!chatbotConfig()) throw new Error("chat_not_configured");
  await rpc("line_chat_recover", { p_scope: chatScope() });
  const { data, error } = await db().from("line_chat_jobs")
    .select("id,status,line_chat_conversations!inner(scope)")
    .eq("line_chat_conversations.scope", chatScope()).in("status", ["pending", "ready"])
    .lte("next_attempt_at", new Date().toISOString()).order("created_at").limit(20);
  if (error) throw new Error("chat_database_unavailable");
  const rows = data ?? [];
  // Keep a recovery request bounded; remaining ready deliveries stay durable.
  const ready = rows.filter(row => row.status === "ready").slice(0, 2);
  await Promise.all(ready.map(row => deliverChatJob(row.id)));
  const ids = rows.filter(row => row.status === "pending").map(row => row.id);
  const dispatched = ids.length ? await dispatchChatJobs(ids) : true;
  return { enabled: true, attempted: ids.length + ready.length, dispatched };
}
export async function setChatMode(id: string, mode: "bot" | "human") {
  return rpc<boolean>("line_chat_set_mode", { p_id: id, p_scope: chatScope(), p_mode: mode });
}
