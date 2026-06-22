import { redirect } from "next/navigation";

// Supabase may redirect magic-link emails to /?code=... if /auth/callback is
// not in the dashboard's allowed-redirect-URLs list. Forward the code so the
// exchange still works.
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const params = await searchParams;
  if (params.code) {
    const next = encodeURIComponent(params.next ?? "/admin");
    redirect(
      `/auth/callback?code=${encodeURIComponent(params.code)}&next=${next}`,
    );
  }
  redirect("/admin");
}
