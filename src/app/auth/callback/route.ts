import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

// Exchanges the magic-link code for a session cookie, then lands on /admin.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (code) {
    const supabase = await supabaseServer();
    await supabase.auth.exchangeCodeForSession(code);
  }

  return NextResponse.redirect(new URL("/admin", url.origin));
}
