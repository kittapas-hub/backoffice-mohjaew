import crypto from "node:crypto";
import { validateLineUserId } from "./line-campaign.ts";

const PAIRING_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PAIRING_CODE_RE = /^MJ-UAT-[A-Z0-9]{8}$/;

export const LINE_UAT_PAIRING_TTL_MS = 10 * 60 * 1000;

export function generateLineUatPairingCode(): string {
  let suffix = "";
  for (let index = 0; index < 8; index += 1) {
    suffix += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
  }
  return `MJ-UAT-${suffix}`;
}

export function parseLineUatPairingMessage(value: unknown): string | null {
  return typeof value === "string" && PAIRING_CODE_RE.test(value) ? value : null;
}

export function hashLineUatPairingCode(code: string): string {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

export async function resolveLineUatTarget(
  envValue: unknown,
  loadLatestPairedUserId: () => Promise<unknown>,
): Promise<string | null> {
  const envTarget = validateLineUserId(envValue);
  if (envTarget) return envTarget;
  return validateLineUserId(await loadLatestPairedUserId());
}
