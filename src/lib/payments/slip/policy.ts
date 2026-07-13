// Trusted verification policy — pure functions, no I/O, no env access.
// Every value compared here comes from the database (order) or the
// verification provider (slip); nothing is browser-supplied.
//
// Payment-window policy (Phase 1):
//   the transfer must have happened between (order created_at − 30 min of
//   clock skew/pre-transfer allowance) and (now + 10 min of provider clock
//   skew). Anything outside — including a missing timestamp — is NOT
//   auto-confirmed and routes to the exception path (customer told to
//   contact the team; the team can use the manual confirmation flow).
import type { NormalizedSlipVerification } from "./types.ts";

export const TRANSFER_WINDOW_BEFORE_ORDER_MS = 30 * 60 * 1000;
export const TRANSFER_CLOCK_SKEW_AFTER_NOW_MS = 10 * 60 * 1000;

export type SlipPolicyRejection =
  | "tx_ref_missing"
  | "receiver_mismatch"
  | "timestamp_out_of_window";

export type SlipPolicyDecision =
  | { ok: true }
  | { ok: false; code: SlipPolicyRejection };

export type ReceiverConfig = {
  /** Masked receiver accounts exactly as the provider reports them for the
   *  shop's account (bank account and/or PromptPay proxy forms). At least one
   *  entry is required — an empty list fails closed. */
  accounts: string[];
  /** Optional receiver display names (Thai/English). When configured AND the
   *  provider returned a receiver name, the name must also match. */
  names: string[];
};

/** Keep only digits and mask characters; masks compare position-blind.
 *  "xxx-x-x1234-x" -> "xxxx1234x" */
export function normalizeAccount(value: string): string {
  return value.toLowerCase().replace(/[^0-9a-z]/g, "");
}

// Longer alternatives first (นางสาว before นาง) so the regex never
// half-strips an honorific.
const NAME_PREFIXES =
  /^(นางสาว|นาย|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.|mrs\.?|miss|mr\.?|ms\.?)\s*/i;

/** Strip honorifics and whitespace so "นาย อีซี่ สลิป" matches "อีซี่ สลิป". */
export function normalizeName(value: string): string {
  return value.trim().replace(NAME_PREFIXES, "").replace(/\s+/g, "").toLowerCase();
}

export function receiverMatches(
  receiver: NormalizedSlipVerification["receiver"],
  config: ReceiverConfig,
): boolean {
  if (config.accounts.length === 0) return false; // fail closed: unconfigured

  const expected = config.accounts.map(normalizeAccount).filter(Boolean);
  const actual = [receiver.accountMasked, receiver.proxyMasked]
    .filter((v): v is string => Boolean(v))
    .map(normalizeAccount);
  if (!actual.some((a) => expected.includes(a))) return false;

  // Secondary factor: when both sides have names, they must agree too.
  const providerNames = [receiver.nameTh, receiver.nameEn]
    .filter((v): v is string => Boolean(v))
    .map(normalizeName);
  if (config.names.length > 0 && providerNames.length > 0) {
    const expectedNames = config.names.map(normalizeName).filter(Boolean);
    if (!providerNames.some((n) => expectedNames.includes(n))) return false;
  }
  return true;
}

/** Validate a verified slip against the trusted order values.
 *  NOTE: the amount and duplicate-transaction checks are deliberately NOT
 *  here — they are enforced inside the confirm_slip_payment DB transaction
 *  (the only place they can be raced-free). Sender identity is deliberately
 *  never checked: the payer does not have to be the booking customer. */
export function evaluateSlipPolicy(
  slip: NormalizedSlipVerification,
  opts: {
    orderCreatedAt: Date;
    now: Date;
    receiverConfig: ReceiverConfig;
  },
): SlipPolicyDecision {
  const txRef = slip.providerTransactionReference?.trim() ?? "";
  if (!txRef) return { ok: false, code: "tx_ref_missing" };

  if (!receiverMatches(slip.receiver, opts.receiverConfig)) {
    return { ok: false, code: "receiver_mismatch" };
  }

  const t = slip.transferTimestamp?.getTime();
  if (
    t === undefined ||
    Number.isNaN(t) ||
    t < opts.orderCreatedAt.getTime() - TRANSFER_WINDOW_BEFORE_ORDER_MS ||
    t > opts.now.getTime() + TRANSFER_CLOCK_SKEW_AFTER_NOW_MS
  ) {
    return { ok: false, code: "timestamp_out_of_window" };
  }

  return { ok: true };
}
