import type { LinePostbackSelection } from "./line-campaign.ts";
import { parseLinePostbackData, validateLineUserId } from "./line-campaign.ts";
import { parseLineUatPairingMessage } from "./line-uat-pairing.ts";

type PersistSelection = (input: LinePostbackSelection & { lineUserId: string; createdAt: string }) => Promise<void>;
type Reply = (replyToken: string, segment: LinePostbackSelection["segment"]) => Promise<unknown>;
type CompletePairing = (input: { code: string; lineUserId: string; pairedAt: string }) => Promise<boolean>;

export type LineWebhookDependencies = {
  verifySignature: (rawBody: string, signature: string | null) => boolean;
  persistSelection: PersistSelection;
  reply: Reply;
  completePairing: CompletePairing;
  replyPairing: (replyToken: string) => Promise<unknown>;
};

type LineEvent = {
  type?: unknown;
  timestamp?: unknown;
  replyToken?: unknown;
  source?: { type?: unknown; userId?: unknown };
  postback?: { data?: unknown };
  message?: { type?: unknown; text?: unknown };
};

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
    const userId = event?.source?.type === "user" ? validateLineUserId(event.source.userId) : null;
    const replyToken = typeof event?.replyToken === "string" && event.replyToken ? event.replyToken : null;
    const pairingCode = event?.type === "message" && event.message?.type === "text"
      ? parseLineUatPairingMessage(event.message.text)
      : null;
    if (userId && replyToken && pairingCode) {
      let paired = false;
      try {
        paired = await dependencies.completePairing({ code: pairingCode, lineUserId: userId, pairedAt: new Date().toISOString() });
      } catch {
        return Response.json({ error: "persistence_failed" }, { status: 500 });
      }
      if (paired) {
        try {
          await dependencies.replyPairing(replyToken);
        } catch {
          // Pairing is already durable; reply delivery is best-effort.
        }
      }
      continue;
    }
    const selection = event?.type === "postback" ? parseLinePostbackData(event.postback?.data) : null;
    if (!selection || !userId || !replyToken) continue;

    const eventDate = typeof event?.timestamp === "number" ? new Date(event.timestamp) : null;
    const createdAt = eventDate && Number.isFinite(eventDate.getTime())
      ? eventDate.toISOString()
      : new Date().toISOString();
    try {
      await dependencies.persistSelection({ ...selection, lineUserId: userId, createdAt });
    } catch {
      return Response.json({ error: "persistence_failed" }, { status: 500 });
    }

    // Reply tokens are single-use. Once persistence succeeds, reply delivery
    // is best-effort and never turns the acknowledgement into a retry loop.
    try {
      await dependencies.reply(replyToken, selection.segment);
    } catch {
      // Intentionally acknowledged below.
    }
  }
  return Response.json({ ok: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
