import { createClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env";

// Service-role client. SERVER ONLY — never import from client components.
// Bypasses RLS, so callers must enforce their own authorization.
export function supabaseAdmin() {
  return createClient(serverEnv.supabaseUrl, serverEnv.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
