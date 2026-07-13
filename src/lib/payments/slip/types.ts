// Provider-neutral slip verification domain types.
// No EasySlip (or any provider) response shapes may leak past the adapter —
// everything downstream of the adapter consumes only these types.

/** Input the adapter receives: an already server-validated upload. */
export type VerifiedUploadInput = {
  image: Buffer;
  mimeType: string;
};

/** Normalized failure reasons. `retryable` on the result tells the UI whether
 *  trying again later can help (provider hiccup) or not (bad slip). */
export type SlipVerifyFailureReason =
  | "unreadable_image" // provider could not read a slip from the image
  | "slip_not_found" // valid image but no matching bank transaction
  | "provider_timeout"
  | "provider_rate_limited"
  | "provider_auth_error" // our credentials/quota problem — config, not customer
  | "malformed_response" // provider replied with an unparseable body
  | "provider_error"; // provider 5xx / unknown failure

/** The ONLY shape verification results take beyond the adapter boundary. */
export type NormalizedSlipVerification = {
  provider: string;
  /** Bank transaction reference. Required for confirmation. */
  providerTransactionReference: string | null;
  /** When the money actually moved, per the slip. */
  transferTimestamp: Date | null;
  /** Transfer amount in satang (integer). */
  amountSatang: number | null;
  /** Provider-reported ISO currency. Never synthesized downstream. */
  currency: string | null;
  /** Receiver identity evidence (masked by the provider). */
  receiver: {
    bankShort: string | null;
    /** Masked bank account, e.g. "xxx-x-x1234-x". */
    accountMasked: string | null;
    /** Masked PromptPay proxy (phone / e-wallet), when the transfer used one. */
    proxyMasked: string | null;
    nameTh: string | null;
    nameEn: string | null;
    /** True only when EasySlip v2 matched the receiver to the merchant's
     * registered account. A masked suffix alone is never sufficient. */
    providerMatchedAccount?: boolean | null;
  };
  /** Sender display evidence where available (masked name/bank for audit). */
  senderDisplay: string | null;
  /** Provider-supplied duplicate signal where available; null = not provided. */
  duplicateSignal: boolean | null;
};

export type SlipVerifyResult =
  | { ok: true; slip: NormalizedSlipVerification }
  | { ok: false; reason: SlipVerifyFailureReason; retryable: boolean };

export interface SlipVerificationProvider {
  /** Short identifier recorded in payment_slip_verifications.provider. */
  readonly name: string;
  verify(input: VerifiedUploadInput): Promise<SlipVerifyResult>;
}
