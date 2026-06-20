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

export function bookingStartKeywords(): string[] {
  const raw = process.env.BOOKING_START_KEYWORDS ?? "จองคิวปรึกษาหมอแจว";
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}
