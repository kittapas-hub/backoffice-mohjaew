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
