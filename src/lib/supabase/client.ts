import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/env";

// Browser client — anon key only. Used by the login page to request a magic link.
export function supabaseBrowser() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
