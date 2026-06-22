import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Exchanges the magic-link code for a session cookie, then lands on `next`.
// Cookies must be set on the redirect response directly — using supabaseServer()
// (which binds to cookies() from next/headers) drops them when a new
// NextResponse is returned.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawNext = url.searchParams.get("next") ?? "/admin";

  // Prevent open redirect: only allow internal paths.
  const safeNext =
    rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/admin";

  if (!code) {
    return NextResponse.redirect(
      new URL("/admin/login?error=otp_expired", url.origin),
    );
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.redirect(
      new URL("/admin/login?setup=missing-env", url.origin),
    );
  }

  // Build the redirect response first so setAll can write cookies onto it.
  const response = NextResponse.redirect(new URL(safeNext, url.origin));

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(
        cookiesToSet: { name: string; value: string; options?: object }[],
      ) {
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      new URL("/admin/login?error=otp_expired", url.origin),
    );
  }

  return response;
}
