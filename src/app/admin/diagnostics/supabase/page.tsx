import { requireAdmin } from "@/lib/auth";
import { SUPABASE_URL } from "@/lib/env";

export const dynamic = "force-dynamic";

const SUPABASE_URL_ENV_NAME = "NEXT_PUBLIC_SUPABASE_URL";

function getSafeSupabaseIdentifiers() {
  try {
    const hostname = new URL(SUPABASE_URL).hostname;
    const projectRef = hostname.endsWith(".supabase.co")
      ? hostname.slice(0, -".supabase.co".length)
      : hostname.split(".")[0];

    return {
      hostname: hostname || "Unavailable",
      projectRef: projectRef || "Unavailable",
    };
  } catch {
    return {
      hostname: "Unavailable",
      projectRef: "Unavailable",
    };
  }
}

export default async function SupabaseDiagnosticsPage() {
  await requireAdmin();

  const { hostname, projectRef } = getSafeSupabaseIdentifiers();

  return (
    <section className="mx-auto max-w-2xl">
      <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900">
        <h1 className="text-xl font-bold">TEMPORARY — Supabase diagnostics</h1>
      </div>

      <dl className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
        <div className="grid gap-1 p-4 sm:grid-cols-2">
          <dt className="font-medium text-gray-600">Supabase hostname</dt>
          <dd className="font-mono text-gray-900">{hostname}</dd>
        </div>
        <div className="grid gap-1 p-4 sm:grid-cols-2">
          <dt className="font-medium text-gray-600">Supabase project ref</dt>
          <dd className="font-mono text-gray-900">{projectRef}</dd>
        </div>
        <div className="grid gap-1 p-4 sm:grid-cols-2">
          <dt className="font-medium text-gray-600">URL environment variable</dt>
          <dd className="font-mono text-gray-900">{SUPABASE_URL_ENV_NAME}</dd>
        </div>
      </dl>
    </section>
  );
}
