export type CampaignDraft = {
  headline: string;
  body: string;
  cta: string;
  angle: string;
  caution: string;
};

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

export function parseCampaignDrafts(value: unknown): CampaignDraft[] | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  const drafts = parsed && typeof parsed === "object" && "drafts" in parsed
    ? (parsed as { drafts?: unknown }).drafts
    : null;
  if (!Array.isArray(drafts) || drafts.length !== 3) return null;
  const valid = drafts.every((draft) => {
    if (!draft || typeof draft !== "object") return false;
    const d = draft as Record<string, unknown>;
    return isText(d.headline, 120) && isText(d.body, 1000) && isText(d.cta, 160) && isText(d.angle, 300) && isText(d.caution, 300);
  });
  return valid ? drafts as CampaignDraft[] : null;
}

type Fetch = typeof fetch;
export async function generateCampaignDrafts(
  input: { objective: string; audience: string; notes?: string },
  options: { fetch?: Fetch; apiKey?: string; model?: string } = {},
): Promise<{ ok: true; drafts: CampaignDraft[] } | { ok: false; error: "not_configured" | "invalid_input" | "unavailable" }> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "not_configured" };
  const objective = input.objective.trim().slice(0, 500);
  const audience = input.audience.trim().slice(0, 500);
  const notes = (input.notes ?? "").trim().slice(0, 1000);
  if (!objective || !audience) return { ok: false, error: "invalid_input" };
  try {
    const response = await (options.fetch ?? fetch)("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model: options.model ?? process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
        input: [
          { role: "system", content: "Create exactly 3 Thai LINE campaign drafts for Mohjaew. Premium but accessible; situation/decision-oriented; no generic fortune bait, medical claims, guaranteed money/results, or fabricated scarcity. CTA must lead to booking or a next action, never promise a prediction. Return JSON only." },
          { role: "user", content: `Objective: ${objective}\nAudience pain: ${audience}\nNotes: ${notes || "-"}` },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "campaign_drafts",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["drafts"],
              properties: {
                drafts: {
                  type: "array",
                  minItems: 3,
                  maxItems: 3,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["headline", "body", "cta", "angle", "caution"],
                    properties: {
                      headline: { type: "string" }, body: { type: "string" },
                      cta: { type: "string" }, angle: { type: "string" }, caution: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    });
    if (!response.ok) return { ok: false, error: "unavailable" };
    const payload = await response.json() as { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
    const outputText = payload.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
    const drafts = parseCampaignDrafts(outputText);
    return drafts ? { ok: true, drafts } : { ok: false, error: "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
