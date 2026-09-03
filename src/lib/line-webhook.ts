import type { LinePostbackSelection } from "./line-campaign.ts";
import { parseLinePostbackData } from "./line-campaign.ts";

type PersistSelection = (input: LinePostbackSelection & { lineUserId: string; createdAt: string }) => Promise<void>;
type Reply = (replyToken: string, segment: LinePostbackSelection["segment"]) => Promise<unknown>;

export type LineWebhookDependencies = {
  verifySignature: (rawBody: string, signature: string | null) => boolean;
  persistSelection: PersistSelection;
  reply: Reply;
};

type LineEvent = {
  type?: unknown;
  timestamp?: unknown;
  replyToken?: unknown;
  source?: { type?: unknown; userId?: unknown };
  postback?: { data?: unknown };
};

const LINE_USER_ID = /^U[0-9a-f]{32}$/i;

export async function handleLineWebhookRequest(request: Request, dependencies: LineWebhookDependencies): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");
  if (!dependencies.verifySignature(rawBody, signature)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ ok: true });
  }

  const events = isRecord(payload) && Array.isArray(payload.events) ? payload.events : [];
  for (const candidate of events) {
    const event = isRecord(candidate) ? (candidate as LineEvent) : null;
    const selection = event?.type === "postback" ? parseLinePostbackData(event.postback?.data) : null;
    if (!selection || event?.source?.type !== "user" || typeof event.source.userId !== "string" || !LINE_USER_ID.test(event.source.userId) || typeof event.replyToken !== "string" || !event.replyToken) continue;

    const eventDate = typeof event.timestamp === "number" ? new Date(event.timestamp) : null;
    const createdAt = eventDate && Number.isFinite(eventDate.getTime())
      ? eventDate.toISOString()
      : new Date().toISOString();
    try {
      await dependencies.persistSelection({ ...selection, lineUserId: event.source.userId, createdAt });
    } catch {
      return Response.json({ error: "persistence_failed" }, { status: 500 });
    }

    // Reply tokens are single-use. Once persistence succeeds, reply delivery
    // is best-effort and never turns the acknowledgement into a retry loop.
    try {
      await dependencies.reply(event.replyToken, selection.segment);
    } catch {
      // Intentionally acknowledged below.
    }
  }
  return Response.json({ ok: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
