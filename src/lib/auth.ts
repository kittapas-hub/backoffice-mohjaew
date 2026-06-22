import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { isAdminEmail } from "@/lib/env";

// Guard for admin server components/actions. Redirects non-admins to login.
export async function requireAdmin() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/admin/login");
  }
  if (!isAdminEmail(user.email)) {
    redirect("/admin/login?error=unauthorized");
  }
  return user;
}
