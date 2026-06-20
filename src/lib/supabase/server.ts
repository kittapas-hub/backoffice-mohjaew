import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/env";

// Auth-aware client bound to the request cookies. Used for the admin login
// session only (magic link). Data access uses the service-role client.
export async function supabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(toSet: { name: string; value: string; options?: object }[]) {
        try {
          toSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // setAll called from a Server Component — ignored; middleware refreshes.
        }
      },
    },
  });
}
