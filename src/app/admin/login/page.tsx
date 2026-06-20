"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { APP_URL, SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/env";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!supabaseConfigured) {
      setError("Supabase environment variables are not configured on Vercel yet.");
      return;
    }
    setLoading(true);
    setError(null);
    const supabase = supabaseBrowser();
    const origin = APP_URL || window.location.origin;
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${origin}/auth/callback` },
    });
    setLoading(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="mb-2 text-2xl font-bold">เข้าสู่ระบบแอดมิน</h1>
      <p className="mb-6 text-sm text-gray-500">หมอแจว Backoffice</p>

      {!supabaseConfigured && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Supabase environment variables are missing on Vercel. Add
          NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, then
          redeploy.
        </div>
      )}

      {sent ? (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          ส่งลิงก์เข้าสู่ระบบไปที่อีเมลแล้ว กรุณาตรวจสอบกล่องจดหมายของคุณ
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="อีเมลแอดมิน"
            className="w-full rounded-lg border border-gray-300 px-4 py-2 outline-none focus:border-gray-900"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={loading || !supabaseConfigured}
            className="w-full rounded-lg bg-gray-900 px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            {loading ? "กำลังส่ง..." : "ส่งลิงก์เข้าสู่ระบบ"}
          </button>
        </form>
      )}
    </main>
  );
}
