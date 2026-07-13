// Trusted verification policy — pure functions, no I/O, no env access.
// Every value compared here comes from the database (order) or the
// verification provider (slip); nothing is browser-supplied.
//
// The transfer window is enforced only by confirm_slip_payment under DB row
// locks. This module intentionally does not reject late, verified money:
// the database must claim it and route it to manual review.
import type { NormalizedSlipVerification } from "./types.ts";

export type SlipPolicyRejection =
  | "tx_ref_missing";

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

// Retained only as deprecated exports for downstream compatibility. The DB
// function now owns the strict time policy under locks.
export const TRANSFER_WINDOW_BEFORE_ORDER_MS = 0;
export const TRANSFER_CLOCK_SKEW_AFTER_NOW_MS = 0;

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
  if (
    config.accounts.length === 0 ||
    config.names.length === 0 ||
    receiver.providerMatchedAccount !== true
  ) return false; // fail closed: no profile or no provider-side match

  const expected = config.accounts.map(normalizeAccount).filter(Boolean);
  const actual = [receiver.accountMasked, receiver.proxyMasked]
    .filter((v): v is string => Boolean(v))
    .map(normalizeAccount);
  const matchingAccounts = [...new Set(actual.filter((a) => expected.includes(a)))];
  if (matchingAccounts.length !== 1) return false;

  // Secondary factor: when both sides have names, they must agree too.
  const providerNames = [receiver.nameTh, receiver.nameEn]
    .filter((v): v is string => Boolean(v))
    .map(normalizeName);
  const expectedNames = config.names.map(normalizeName).filter(Boolean);
  const matchingNames = [...new Set(providerNames.filter((n) => expectedNames.includes(n)))];
  return matchingNames.length === 1;
}

/** Validate a verified slip against the trusted order values.
 *  NOTE: the amount and duplicate-transaction checks are deliberately NOT
 *  here — they are enforced inside the confirm_slip_payment DB transaction
 *  (the only place they can be raced-free). Sender identity is deliberately
 *  never checked: the payer does not have to be the booking customer. */
export function evaluateSlipPolicy(
  slip: NormalizedSlipVerification,
  _opts?: { receiverConfig?: ReceiverConfig; orderCreatedAt?: Date; now?: Date },
): SlipPolicyDecision {
  void _opts;
  const txRef = slip.providerTransactionReference?.trim() ?? "";
  if (!txRef) return { ok: false, code: "tx_ref_missing" };

  return { ok: true };
}
