import crypto from "node:crypto";
import { serverEnv } from "@/lib/env";

const API = "https://api.line.me/v2/bot";
const DATA_API = "https://api-data.line.me/v2/bot";

// Verify x-line-signature against the RAW request body (HMAC-SHA256, base64).
export function verifyLineSignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", serverEnv.lineChannelSecret)
    .update(rawBody)
    .digest("base64");
  // Constant-time compare; lengths must match for timingSafeEqual.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authHeaders() {
  return { Authorization: `Bearer ${serverEnv.lineAccessToken}` };
}

export async function replyMessage(replyToken: string, text: string): Promise<void> {
  const res = await fetch(`${API}/message/reply`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) {
    console.error("LINE reply failed", res.status, await res.text());
  }
}

export async function pushMessage(to: string, text: string): Promise<void> {
  const res = await fetch(`${API}/message/push`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) {
    console.error("LINE push failed", res.status, await res.text());
  }
}

export async function getUserDisplayName(userId: string): Promise<string | null> {
  const res = await fetch(`${API}/profile/${userId}`, { headers: authHeaders() });
  if (!res.ok) return null;
  const data = (await res.json()) as { displayName?: string };
  return data.displayName ?? null;
}

// Download the binary content of an image message.
export async function getMessageContent(
  messageId: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const res = await fetch(`${DATA_API}/message/${messageId}/content`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    console.error("LINE content fetch failed", res.status);
    return null;
  }
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}
