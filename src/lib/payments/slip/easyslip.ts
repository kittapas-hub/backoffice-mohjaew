// EasySlip adapter. SERVER-ONLY: holds the API key, talks HTTP to EasySlip,
// and translates its response into NormalizedSlipVerification. EasySlip
// response shapes must never escape this file.
//
// API: POST https://developer.easyslip.com/api/v1/verify
//      Authorization: Bearer <api key> (injected by env.ts), multipart "file".
// Docs: https://document.easyslip.com — response fields are parsed
// defensively; anything missing/unexpected degrades to null fields or a
// malformed_response failure, never to a thrown exception with payload data.
import type {
  SlipVerificationProvider,
  SlipVerifyResult,
  VerifiedUploadInput,
} from "./types.ts";

const EASYSLIP_VERIFY_URL = "https://developer.easyslip.com/api/v1/verify";
const DEFAULT_TIMEOUT_MS = 15_000;

type Json = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

/** THB (possibly fractional) -> integer satang. Null when absent/invalid. */
export function thbToSatang(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v * 100);
}

export function parseTransferDate(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Map an EasySlip HTTP error to a normalized failure. Exported for tests. */
export function mapEasySlipError(
  httpStatus: number,
  message: string | null,
): Extract<SlipVerifyResult, { ok: false }> {
  if (httpStatus === 429) {
    return { ok: false, reason: "provider_rate_limited", retryable: true };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    // Includes quota/account problems — our configuration, not the customer.
    return { ok: false, reason: "provider_auth_error", retryable: false };
  }
  if (httpStatus === 404) {
    // Slip QR decoded but no matching transaction at the bank.
    return { ok: false, reason: "slip_not_found", retryable: false };
  }
  if (httpStatus === 400) {
    const m = message ?? "";
    if (m.includes("quota")) {
      return { ok: false, reason: "provider_auth_error", retryable: false };
    }
    return { ok: false, reason: "unreadable_image", retryable: false };
  }
  return { ok: false, reason: "provider_error", retryable: true };
}

/** Parse a 200 body into the normalized shape. Exported for tests. */
export function normalizeEasySlipBody(body: unknown): SlipVerifyResult {
  const root = obj(body);
  const data = obj(root.data);
  const txRef = str(data.transRef);
  const amount = thbToSatang(obj(data.amount).amount);
  if (!txRef && amount === null) {
    // A "success" body carrying neither a tx ref nor an amount is not a
    // usable verification — treat as malformed rather than guessing.
    return { ok: false, reason: "malformed_response", retryable: false };
  }

  const receiver = obj(data.receiver);
  const receiverAccount = obj(receiver.account);
  const sender = obj(data.sender);
  const senderAccount = obj(sender.account);
  const senderName =
    str(obj(senderAccount.name).th) ?? str(obj(senderAccount.name).en);
  const senderBank = str(obj(sender.bank).short) ?? str(obj(sender.bank).name);

  return {
    ok: true,
    slip: {
      provider: "easyslip",
      providerTransactionReference: txRef,
      transferTimestamp: parseTransferDate(data.date),
      amountSatang: amount,
      receiver: {
        bankShort:
          str(obj(receiver.bank).short) ?? str(obj(receiver.bank).name),
        accountMasked: str(obj(receiverAccount.bank).account),
        proxyMasked: str(obj(receiverAccount.proxy).account),
        nameTh: str(obj(receiverAccount.name).th),
        nameEn: str(obj(receiverAccount.name).en),
      },
      senderDisplay:
        senderName || senderBank
          ? [senderName, senderBank].filter(Boolean).join(" / ")
          : null,
      duplicateSignal: null, // EasySlip does not expose one on this endpoint
    },
  };
}

export function easySlipProvider(opts: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): SlipVerificationProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "easyslip",
    async verify(input: VerifiedUploadInput): Promise<SlipVerifyResult> {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(input.image)], { type: input.mimeType }),
        "slip",
      );

      let res: Response;
      try {
        res = await doFetch(EASYSLIP_VERIFY_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name === "TimeoutError" || name === "AbortError") {
          return { ok: false, reason: "provider_timeout", retryable: true };
        }
        return { ok: false, reason: "provider_error", retryable: true };
      }

      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // fall through with body = null
      }

      if (!res.ok) {
        return mapEasySlipError(res.status, str(obj(body).message));
      }
      if (body === null) {
        return { ok: false, reason: "malformed_response", retryable: false };
      }
      return normalizeEasySlipBody(body);
    },
  };
}
