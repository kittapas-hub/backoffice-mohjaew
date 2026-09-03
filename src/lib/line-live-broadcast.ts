import type { LineSendResult } from "./line-campaign.ts";

export type LiveBroadcastOutcome = "success" | "line_failed" | "line_unknown" | "audit_failed" | "duplicate" | "claim_failed";
export type LiveBroadcastDisposition = "new_allowed" | "retry_same" | "locked";

export function liveBroadcastDisposition(outcome: LiveBroadcastOutcome): LiveBroadcastDisposition {
  if (outcome === "success" || outcome === "line_failed") return "new_allowed";
  if (outcome === "claim_failed") return "retry_same";
  return "locked";
}

export async function runLiveBroadcast(dependencies: {
  claim: () => Promise<"claimed" | "duplicate" | "error">;
  send: () => Promise<LineSendResult>;
  finalize: (status: "success" | "failed" | "unknown", lineStatus?: number) => Promise<boolean>;
}): Promise<LiveBroadcastOutcome> {
  let claim: "claimed" | "duplicate" | "error";
  try {
    claim = await dependencies.claim();
  } catch {
    return "claim_failed";
  }
  if (claim === "duplicate") return "duplicate";
  if (claim === "error") return "claim_failed";

  let result: LineSendResult;
  try {
    result = await dependencies.send();
  } catch {
    result = { ok: false, error: "network_error" };
  }
  const status = result.ok ? "success" : result.error === "network_error" ? "unknown" : "failed";
  try {
    if (!await dependencies.finalize(status, result.ok ? 200 : result.status)) return "audit_failed";
  } catch {
    return "audit_failed";
  }
  if (result.ok) return "success";
  return status === "unknown" ? "line_unknown" : "line_failed";
}
