import { WAITING_SEGMENTS, type WaitingSegment } from "./line-campaign.ts";

const LINE_API = "https://api.line.me/v2/bot";
type Fetch = typeof fetch;

export type LineQuota = {
  ok: true;
  type: "none" | "limited";
  limit: number | null;
  consumed: number;
} | { ok: false; error: "not_configured" | "unavailable" };

function parseQuotaLimit(value: unknown): { type: "none" | "limited"; limit: number | null } | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (data.type === "none") return { type: "none", limit: null };
  if (data.type === "limited" && Number.isInteger(data.value) && (data.value as number) >= 0) {
    return { type: "limited", limit: data.value as number };
  }
  return null;
}

export function parseLineQuota(quota: unknown, consumption: unknown): LineQuota {
  const parsed = parseQuotaLimit(quota);
  if (!parsed || !consumption || typeof consumption !== "object") return { ok: false, error: "unavailable" };
  const totalUsage = (consumption as Record<string, unknown>).totalUsage;
  if (!Number.isInteger(totalUsage) || (totalUsage as number) < 0) return { ok: false, error: "unavailable" };
  return { ok: true, ...parsed, consumed: totalUsage as number };
}

export async function getLineQuota(options: { fetch?: Fetch; accessToken?: string } = {}): Promise<LineQuota> {
  const token = options.accessToken ?? process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { ok: false, error: "not_configured" };
  const fetchImpl = options.fetch ?? fetch;
  try {
    const init = { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) };
    const [quotaResponse, consumptionResponse] = await Promise.all([
      fetchImpl(`${LINE_API}/message/quota`, init),
      fetchImpl(`${LINE_API}/message/quota/consumption`, init),
    ]);
    if (!quotaResponse.ok || !consumptionResponse.ok) return { ok: false, error: "unavailable" };
    return parseLineQuota(await quotaResponse.json(), await consumptionResponse.json());
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

export function emptySegmentCounts(): Record<WaitingSegment, number> {
  return Object.fromEntries(WAITING_SEGMENTS.map((segment) => [segment, 0])) as Record<WaitingSegment, number>;
}

export function maskLineUserId(value: string): string {
  return value.length > 9 ? `${value.slice(0, 5)}…${value.slice(-4)}` : "••••";
}
