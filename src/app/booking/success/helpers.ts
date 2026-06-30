/** Format milliseconds as MM:SS (clamped to 00:00 for non-positive values). */
export function formatMmSs(ms: number): string {
  if (ms <= 0) return "00:00";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/**
 * Build a LINE OA message deep link with pre-filled text.
 * Converts `https://line.me/R/ti/p/@oaId` → `https://line.me/R/oaMessage/@oaId?text=...`
 * Falls back to the raw URL if the OA ID cannot be extracted.
 */
export function buildLineHref(lineOaUrl: string, prefillText: string): string {
  const match = lineOaUrl.match(/\/@([^/?#]+)/);
  if (!match) return lineOaUrl; // ponytail: unknown URL format — no prefill, best-effort
  return `https://line.me/R/oaMessage/@${match[1]}?text=${encodeURIComponent(prefillText)}`;
}

/** Build the LINE prefill message for slip submission. No PII — reference/date/time only. */
export function buildLinePrefill(opts: {
  reference: string;
  thaiDate: string;
  slotLabel: string;
}): string {
  return [
    "ส่งสลิปชำระค่าปรึกษา",
    `เลขอ้างอิง: ${opts.reference}`,
    `วันนัด: ${opts.thaiDate}`,
    `เวลา: ${opts.slotLabel}`,
  ].join("\n");
}
