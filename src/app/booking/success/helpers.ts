/** Format milliseconds as MM:SS (clamped to 00:00 for non-positive values). */
export function formatMmSs(ms: number): string {
  if (ms <= 0) return "00:00";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// The real Mohjaew LINE OA id. Used whenever NEXT_PUBLIC_LINE_OA_URL is unset
// or doesn't match the expected "/@id" shape, so the slip-submission button
// never points at a generic LINE landing page.
export const MOHJAEW_LINE_OA_ID = "695bosga";

/**
 * Build a LINE OA message deep link with pre-filled text, always targeting
 * the real Mohjaew OA (@695bosga) — never a generic LINE page. Extracts the
 * OA id from NEXT_PUBLIC_LINE_OA_URL when it matches the expected
 * `https://line.me/R/ti/p/@oaId` shape; otherwise falls back to the known
 * MOHJAEW_LINE_OA_ID rather than returning the unmatched URL as-is.
 */
export function buildLineHref(lineOaUrl: string, prefillText: string): string {
  const match = lineOaUrl.match(/\/@([^/?#]+)/);
  const oaId = match ? match[1] : MOHJAEW_LINE_OA_ID;
  return `https://line.me/R/oaMessage/@${oaId}?text=${encodeURIComponent(prefillText)}`;
}

/** Build the minimal LINE prefill message for slip submission: the fixed
 *  instruction text plus the booking reference only. No name, phone, birth
 *  date, consultation topic, or token — those never belong in a URL. */
export function buildLinePrefill(opts: { reference: string }): string {
  return ["ส่งสลิปชำระเงิน", `เลขอ้างอิง: ${opts.reference}`].join("\n");
}

// Polling cadence for the pending_payment status re-check on the success
// page. Must never be shorter than this.
export const STATUS_POLL_INTERVAL_MS = 15_000;

/** Whether the success page should keep polling for a status change. */
export function shouldPollStatus(status: string): boolean {
  return status === "pending_payment";
}
