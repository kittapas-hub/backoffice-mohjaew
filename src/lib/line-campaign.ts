import crypto from "node:crypto";
import { serverEnv } from "./env.ts";

const LINE_API = "https://api.line.me/v2/bot";
const LINE_TIMEOUT_MS = 10_000;

export const SEPTEMBER_WAITING_CAMPAIGN = "september_waiting" as const;
export const WAITING_SEGMENTS = ["WAIT_ANSWER", "WAIT_MULTIPLE", "WAIT_STALLED"] as const;
export type WaitingSegment = (typeof WAITING_SEGMENTS)[number];

export const WAITING_AUTO_REPLIES: Record<WaitingSegment, string> = {
  WAIT_ANSWER: "รับทราบค่ะ ตอนนี้คุณกำลังรอคำตอบที่ยังไม่ชัด หากเป็นเรื่องเงิน งาน หรือการตัดสินใจสำคัญ สามารถดูรายละเอียดการจองคิวหมอแจวได้จากเมนูด้านล่างค่ะ",
  WAIT_MULTIPLE: "รับทราบค่ะ ตอนนี้คุณมีหลายเรื่องที่กำลังรออยู่ หากต้องการดูว่าควรจัดการเรื่องไหนก่อน สามารถดูรายละเอียดการจองคิวหมอแจวได้จากเมนูด้านล่างค่ะ",
  WAIT_STALLED: "รับทราบค่ะ เรื่องที่เคยมีความคืบหน้าแล้วเงียบไปอาจต้องดูเป็นรายกรณี หากต้องการดูจังหวะของเรื่องนี้ สามารถดูรายละเอียดการจองคิวหมอแจวได้จากเมนูด้านล่างค่ะ",
};

export type LinePostbackSelection = { campaign: typeof SEPTEMBER_WAITING_CAMPAIGN; segment: WaitingSegment };

export function postbackData(segment: WaitingSegment): string {
  return `campaign=${SEPTEMBER_WAITING_CAMPAIGN}&segment=${segment}`;
}

export function parseLinePostbackData(value: unknown): LinePostbackSelection | null {
  if (typeof value !== "string" || value.length > 300) return null;
  const params = new URLSearchParams(value);
  const entries = [...params.entries()];
  if (entries.length !== 2 || params.getAll("campaign").length !== 1 || params.getAll("segment").length !== 1 || entries.some(([key]) => key !== "campaign" && key !== "segment")) return null;
  const campaign = params.get("campaign");
  const segment = params.get("segment");
  if (campaign !== SEPTEMBER_WAITING_CAMPAIGN || !isWaitingSegment(segment)) return null;
  return { campaign, segment };
}

function isWaitingSegment(value: unknown): value is WaitingSegment {
  return typeof value === "string" && WAITING_SEGMENTS.some((segment) => segment === value);
}

type LinePostbackAction = { type: "postback"; label: string; data: string; displayText: string };
export type LineTextMessage = { type: "text"; text: string; quickReply?: { items: Array<{ type: "action"; action: LinePostbackAction }> } };

export function buildSeptemberWaitingQuickReply(): LineTextMessage {
  const choices: Array<{ label: string; displayText: string; segment: WaitingSegment }> = [
    { label: "1️⃣ รอคำตอบ", displayText: "1️⃣ รอคำตอบ", segment: "WAIT_ANSWER" },
    { label: "2️⃣ รอหลายเรื่อง", displayText: "2️⃣ รอหลายเรื่อง", segment: "WAIT_MULTIPLE" },
    { label: "3️⃣ สำเร็จแล้วเงียบ", displayText: "3️⃣ เรื่องเกือบสำเร็จแล้วเงียบ", segment: "WAIT_STALLED" },
  ];
  return { type: "text", text: "ตอนนี้คุณกำลังรอเรื่องแบบไหนอยู่คะ", quickReply: { items: choices.map(({ label, displayText, segment }) => ({ type: "action", action: { type: "postback", label, data: postbackData(segment), displayText } })) } };
}

export type LineSendResult = { ok: true } | { ok: false; status?: number; error: "network_error" | "line_error" };
type Fetch = typeof fetch;

const LINE_USER_ID_RE = /^U[0-9a-fA-F]{32}$/;

export function validateLineUserId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return LINE_USER_ID_RE.test(trimmed) ? trimmed : null;
}

export function isLiveBroadcastEnabled(value = process.env.LINE_BROADCAST_LIVE_ENABLED): boolean {
  return value === "true";
}

async function postToLine(path: string, body: unknown, options: { fetch?: Fetch; accessToken?: string; retryKey?: string } = {}): Promise<LineSendResult> {
  const fetchImpl = options.fetch ?? fetch;
  const accessToken = options.accessToken ?? serverEnv.lineAccessToken;
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  if (options.retryKey) headers["X-Line-Retry-Key"] = options.retryKey;
  try {
    const response = await fetchImpl(`${LINE_API}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(LINE_TIMEOUT_MS) });
    if (response.ok || (options.retryKey && response.status === 409)) return { ok: true };
    return { ok: false, status: response.status, error: "line_error" };
  } catch {
    return { ok: false, error: "network_error" };
  }
}

export function replyToPostback(replyToken: string, segment: WaitingSegment, options?: { fetch?: Fetch; accessToken?: string }): Promise<LineSendResult> {
  return postToLine("/message/reply", { replyToken, messages: [{ type: "text", text: WAITING_AUTO_REPLIES[segment] }] }, options);
}

export function replyToTextMessage(replyToken: string, text: string, options?: { fetch?: Fetch; accessToken?: string }): Promise<LineSendResult> {
  return postToLine("/message/reply", { replyToken, messages: [{ type: "text", text }] }, options);
}

export function sendLineBroadcast(messages: LineTextMessage[], options: { fetch?: Fetch; accessToken?: string; retryKey?: string } = {}): Promise<LineSendResult> {
  return postToLine("/message/broadcast", { messages }, { ...options, retryKey: options.retryKey ?? crypto.randomUUID() });
}

export function sendLineUatPush(
  to: string,
  messages: LineTextMessage[],
  options: { fetch?: Fetch; accessToken?: string; retryKey?: string } = {},
): Promise<LineSendResult> {
  const userId = validateLineUserId(to);
  if (!userId) return Promise.resolve({ ok: false, error: "line_error" });
  return postToLine(
    "/message/push",
    { to: userId, messages },
    { ...options, retryKey: options.retryKey ?? crypto.randomUUID() },
  );
}
