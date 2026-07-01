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
