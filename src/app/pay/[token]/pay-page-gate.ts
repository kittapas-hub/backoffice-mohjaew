type SlipVerificationUiConfig = {
  enabled: boolean;
  provider: string;
  easySlipApiKey: string;
  receiverProfile: string;
  receiverAccounts: string[];
  receiverNames: string[];
};

/** Render automatic slip upload only when the explicit release gate is on. */
export function isSlipUploadReady(cfg: SlipVerificationUiConfig): boolean {
  return cfg.enabled === true &&
    cfg.provider === "easyslip_v2" &&
    Boolean(cfg.easySlipApiKey) &&
    Boolean(cfg.receiverProfile) &&
    cfg.receiverAccounts.length > 0 &&
    cfg.receiverNames.length > 0;
}

/** The payment deadline is the earlier of the immutable order expiry and the
 * booking hold expiry. Missing or malformed trusted timestamps fail closed. */
export function resolvePaymentDeadline(
  orderExpiresAt: string,
  bookingHoldExpiresAt: string | null | undefined,
): string | null {
  if (!bookingHoldExpiresAt) return null;
  const orderMs = new Date(orderExpiresAt).getTime();
  const holdMs = new Date(bookingHoldExpiresAt).getTime();
  if (!Number.isFinite(orderMs) || !Number.isFinite(holdMs)) return null;
  return new Date(Math.min(orderMs, holdMs)).toISOString();
}

export function isPaymentDeadlinePassed(
  deadline: string | null,
  now = Date.now(),
): boolean {
  if (!deadline) return true;
  const deadlineMs = new Date(deadline).getTime();
  return !Number.isFinite(deadlineMs) || deadlineMs <= now;
}
