// Pure evidence/redaction helpers (relative imports only, so plain-Node
// tests can exercise them without a bundler).
import type { NormalizedSlipVerification } from "./types.ts";

/** Normalized, PII-light evidence stored with audit rows and the paid order.
 *  Provider-masked identifiers only — receiver display names stay out, and
 *  neither the raw provider payload nor any image is ever included. */
export function buildEvidence(slip: NormalizedSlipVerification) {
  return {
    provider: slip.provider,
    tx_ref: slip.providerTransactionReference,
    transfer_at: slip.transferTimestamp?.toISOString() ?? null,
    amount_satang: slip.amountSatang,
    receiver_bank: slip.receiver.bankShort,
    receiver_account_masked: slip.receiver.accountMasked,
    receiver_proxy_masked: slip.receiver.proxyMasked,
    sender_display: slip.senderDisplay,
  };
}

/** Redact a transaction reference for ordinary logs: keep last 4 chars. */
export function redactTxRef(txRef: string | null): string {
  if (!txRef) return "-";
  return `…${txRef.slice(-4)}`;
}
