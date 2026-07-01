import crypto from "node:crypto";
import { serverEnv } from "@/lib/env";

const API = "https://api.line.me/v2/bot";

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

export async function pushMessage(to: string, text: string): Promise<void> {
  const res = await fetch(`${API}/message/push`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) {
    console.error("LINE push failed", res.status);
  }
}

// Non-fatal team notification. Never throws: if LINE isn't configured yet,
// it logs and reports skipped so a booking is never blocked by missing env.
export async function notifyTeamSafe(
  text: string,
): Promise<{ ok: boolean; skipped?: boolean; status?: number }> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const groupId = process.env.LINE_BOOKING_NOTIFY_GROUP_ID;
  if (!token || !groupId) {
    console.warn(
      "[line] team notify skipped: missing LINE_CHANNEL_ACCESS_TOKEN or LINE_BOOKING_NOTIFY_GROUP_ID",
    );
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch(`${API}/message/push`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: groupId, messages: [{ type: "text", text }] }),
    });
    if (!res.ok) {
      console.error("[line] team notify failed", res.status);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    console.error("[line] team notify error", err instanceof Error ? err.message : "unknown");
    return { ok: false };
  }
}

// Non-fatal image push to the team group. Returns skipped when LINE env is absent.
export async function notifyTeamImageSafe(
  imageUrl: string,
): Promise<{ ok: boolean; skipped?: boolean }> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const groupId = process.env.LINE_BOOKING_NOTIFY_GROUP_ID;
  if (!token || !groupId) return { ok: false, skipped: true };
  try {
    const res = await fetch(`${API}/message/push`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to: groupId,
        messages: [
          {
            type: "image",
            originalContentUrl: imageUrl,
            previewImageUrl: imageUrl,
          },
        ],
      }),
    });
    if (!res.ok) {
      console.error("[line] image notify failed", res.status);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error("[line] image notify error", err instanceof Error ? err.message : "unknown");
    return { ok: false };
  }
}
