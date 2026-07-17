import { SLIP_MAX_BYTES } from "../../image-meta.ts";

// 128 KiB is ample for the single file part, boundary, and honeypot field,
// while keeping the whole request below Vercel Functions' documented 4.5 MB
// request limit. Self-hosted deployments still receive this application guard.
export const SLIP_MULTIPART_OVERHEAD_BYTES = 128 * 1024;
export const SLIP_MAX_REQUEST_BYTES = SLIP_MAX_BYTES + SLIP_MULTIPART_OVERHEAD_BYTES;

export type ContentLengthDecision =
  | { ok: true; bytes: number }
  | { ok: false; reason: "missing" | "invalid" | "too_large" };

/** Strict, fail-closed Content-Length validation performed before formData(). */
export function validateUploadContentLength(raw: string | null): ContentLengthDecision {
  if (raw === null || raw.trim() === "") return { ok: false, reason: "missing" };
  // Reject signs, decimals, exponent notation, comma-joined duplicates, and
  // other ambiguous metadata instead of letting Number() reinterpret it.
  if (!/^[0-9]+$/.test(raw)) return { ok: false, reason: "invalid" };
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return { ok: false, reason: "invalid" };
  if (bytes > SLIP_MAX_REQUEST_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, bytes };
}

/** File.size is available from FormData without allocating a second buffer. */
export function fileFitsBeforeBuffering(size: number): boolean {
  return Number.isSafeInteger(size) && size > 0 && size <= SLIP_MAX_BYTES;
}
