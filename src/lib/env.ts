// Centralized env access. Server-only secrets are read lazily so the browser
// bundle never references them.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// Public (safe for browser) ----------------------------------------------------
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "";
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// Server-only ------------------------------------------------------------------
export const serverEnv = {
  get supabaseUrl() {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get serviceRoleKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },
  get lineChannelSecret() {
    return required("LINE_CHANNEL_SECRET");
  },
  get lineAccessToken() {
    return required("LINE_CHANNEL_ACCESS_TOKEN");
  },
  get notifyGroupId() {
    return required("LINE_BOOKING_NOTIFY_GROUP_ID");
  },
  // Used to HMAC the client IP for DB-backed rate limiting. Required when
  // POST /api/bookings is reachable (the route returns a 500 config error if
  // it is missing rather than silently disabling the limit).
  get rateLimitSecret() {
    return required("BOOKING_RATE_LIMIT_SECRET");
  },
};

export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().includes(email.toLowerCase());
}

// Slip verification (EasySlip) — SERVER-ONLY. The API key must never reach
// the browser bundle; only server modules may call this.
// receiverProfile is the immutable, owner-approved profile identifier stored
// on each order. The account/name values are a second server-side check of
// EasySlip v2's registered-account result. Missing any part fails closed.
export function slipVerificationConfig() {
  const split = (v: string | undefined) =>
    (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    enabled: process.env.SLIP_VERIFICATION_ENABLED === "true" &&
      process.env.SLIP_VERIFICATION_PROVIDER === "easyslip_v2",
    provider: process.env.SLIP_VERIFICATION_PROVIDER ?? "",
    easySlipApiKey: process.env.EASYSLIP_API_KEY ?? "",
    receiverProfile: process.env.SLIP_RECEIVER_PROFILE ?? "",
    receiverAccounts: split(process.env.SLIP_RECEIVER_ACCOUNTS),
    receiverNames: split(process.env.SLIP_RECEIVER_NAMES),
  };
}

/** Explicit server-only release gate. Credentials never enable automation. */
export function slipVerificationEnabled(): boolean {
  return slipVerificationConfig().enabled;
}

// Trusted booking price in satang, from BOOKING_PAYMENT_AMOUNT_THB.
// Null when unset/invalid — payment orders are then not created and the
// pre-Phase-1 manual flow is the only path.
export function paymentAmountSatang(): number | null {
  const raw = process.env.BOOKING_PAYMENT_AMOUNT_THB ?? "";
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

// Payment instructions displayed on /booking/success.
// All four fields (amount, bankName, accountName, accountNumber) must be set
// for the payment card to appear; if any is empty a safe fallback is shown.
export function paymentConfig() {
  return {
    amount: process.env.BOOKING_PAYMENT_AMOUNT_THB ?? "",
    bankName: process.env.BOOKING_BANK_NAME ?? "",
    accountName: process.env.BOOKING_ACCOUNT_NAME ?? "",
    accountNumber: process.env.BOOKING_ACCOUNT_NUMBER ?? "",
    qrPath: process.env.BOOKING_PAYMENT_QR_PATH ?? "",
    lineOaUrl: process.env.NEXT_PUBLIC_LINE_OA_URL ?? "",
  };
}
