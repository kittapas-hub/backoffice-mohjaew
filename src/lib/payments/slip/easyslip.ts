// EasySlip v2 adapter. SERVER-ONLY: the API key and provider response never
// cross this boundary. Partial or unexpected response shapes fail closed.
import type {
  SlipVerificationProvider,
  SlipVerifyResult,
  VerifiedUploadInput,
} from "./types.ts";

const EASYSLIP_VERIFY_URL = "https://api.easyslip.com/v2/verify/bank";
const DEFAULT_TIMEOUT_MS = 15_000;

type Json = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function has(o: Json, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
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

export function mapEasySlipError(
  httpStatus: number,
  message: string | null,
): Extract<SlipVerifyResult, { ok: false }> {
  if (httpStatus === 429) {
    return { ok: false, reason: "provider_rate_limited", retryable: true };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { ok: false, reason: "provider_auth_error", retryable: false };
  }
  if (httpStatus === 404) {
    return { ok: false, reason: "slip_not_found", retryable: false };
  }
  if (httpStatus === 400) {
    if ((message ?? "").toLowerCase().includes("quota")) {
      return { ok: false, reason: "provider_auth_error", retryable: false };
    }
    return { ok: false, reason: "unreadable_image", retryable: false };
  }
  return { ok: false, reason: "provider_error", retryable: true };
}

/** Parse the official v2 response envelope without inventing missing values. */
export function normalizeEasySlipBody(body: unknown): SlipVerifyResult {
  const root = obj(body);
  if (root.success !== true || !str(root.message) || !has(root, "data")) {
    return { ok: false, reason: "malformed_response", retryable: false };
  }

  const data = obj(root.data);
  // checkDuplicate=true is always sent, so a boolean duplicate signal is
  // required. rawSlip carries the money/identity facts. matchedAccount and
  // amountInSlip are OPTIONAL — the documented v2 200 example (and real
  // bank-app PromptPay slips) omit them — so their absence is not malformed.
  if (typeof data.isDuplicate !== "boolean" || !has(data, "rawSlip")) {
    return { ok: false, reason: "malformed_response", retryable: false };
  }

  const rawSlip = obj(data.rawSlip);
  const rawAmount = obj(rawSlip.amount);
  const localAmount = obj(rawAmount.local);
  const txRef = str(rawSlip.transRef);
  const transferTimestamp = parseTransferDate(rawSlip.date);
  const amount = thbToSatang(rawAmount.amount);

  // Money-critical facts: reference, timestamp, positive finite amount.
  if (!txRef || !transferTimestamp || amount === null || amount <= 0) {
    return { ok: false, reason: "malformed_response", retryable: false };
  }

  // Optional duplicate amount fields: when present they MUST agree exactly;
  // when absent they are not required (documented minimal success omits them).
  if (has(data, "amountInSlip") && thbToSatang(data.amountInSlip) !== amount) {
    return { ok: false, reason: "malformed_response", retryable: false };
  }
  if (has(rawAmount, "local") && thbToSatang(localAmount.amount) !== amount) {
    return { ok: false, reason: "malformed_response", retryable: false };
  }

  // Currency: trust an explicit local currency; default to THB for this Thai
  // bank endpoint only when local currency is absent. Reject an explicitly
  // foreign currency or an explicitly non-TH country. A missing countryCode is
  // common on legitimate domestic slips (amount is the authoritative guard).
  const localCurrency = str(localAmount.currency)?.toUpperCase() ?? null;
  const countryCode = str(rawSlip.countryCode);
  if (
    (localCurrency !== null && localCurrency !== "THB") ||
    (countryCode !== null && countryCode !== "TH")
  ) {
    return { ok: false, reason: "malformed_response", retryable: false };
  }
  const currency = localCurrency ?? "THB";

  // matchedAccount is additional receiver evidence when present; absent/null
  // yields providerMatchedAccount=false so downstream receiverMatches (in
  // policy.ts) routes to manual review, never auto-confirm. A present-but-
  // incomplete matchedAccount fails closed rather than fabricating a match.
  const matched = has(data, "matchedAccount") && data.matchedAccount !== null
    ? obj(data.matchedAccount)
    : null;
  if (matched !== null && !(
    Boolean(str(matched.bankNumber)) &&
    Boolean(str(matched.nameTh) || str(matched.nameEn)) &&
    Boolean(str(obj(matched.bank).code))
  )) {
    return { ok: false, reason: "malformed_response", retryable: false };
  }

  const receiver = obj(rawSlip.receiver);
  const receiverBank = obj(receiver.bank);
  const receiverAccount = obj(receiver.account);
  const receiverName = obj(receiverAccount.name);
  const sender = obj(rawSlip.sender);
  const senderBankObj = obj(sender.bank);
  const senderAccount = obj(sender.account);
  const senderNameObj = obj(senderAccount.name);
  const senderName = str(senderNameObj.th) ?? str(senderNameObj.en);
  const senderBank = str(senderBankObj.short) ?? str(senderBankObj.name);

  return {
    ok: true,
    slip: {
      provider: "promptpay_slip",
      providerTransactionReference: txRef,
      transferTimestamp,
      amountSatang: amount,
      currency,
      receiver: {
        bankShort: str(receiverBank.short) ?? str(receiverBank.name),
        accountMasked: str(obj(receiverAccount.bank).account),
        proxyMasked: str(obj(receiverAccount.proxy).account),
        nameTh: str(receiverName.th),
        nameEn: str(receiverName.en),
        providerMatchedAccount: matched !== null,
      },
      senderDisplay: senderName || senderBank
        ? [senderName, senderBank].filter(Boolean).join(" / ")
        : null,
      duplicateSignal: data.isDuplicate,
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
    name: "promptpay_slip",
    async verify(input: VerifiedUploadInput): Promise<SlipVerifyResult> {
      const form = new FormData();
      form.append(
        "image",
        new Blob([new Uint8Array(input.image)], { type: input.mimeType }),
        "slip",
      );
      form.append("matchAccount", "true");
      form.append("checkDuplicate", "true");

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
        // Null is handled as a malformed response below.
      }

      if (!res.ok) {
        return mapEasySlipError(res.status, str(obj(obj(body).error).message));
      }
      if (body === null) {
        return { ok: false, reason: "malformed_response", retryable: false };
      }
      return normalizeEasySlipBody(body);
    },
  };
}
