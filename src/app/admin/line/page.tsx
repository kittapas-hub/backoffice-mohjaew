import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { WAITING_SEGMENTS, type WaitingSegment } from "@/lib/line-campaign";
import { emptySegmentCounts, getLineQuota } from "@/lib/line-marketing";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Run = { id: string; mode: string; status: string; message_text: string; target_count: number | null; created_at: string };

export default async function LineDashboard() {
  await requireAdmin();
  const db = supabaseAdmin();
  const [quota, segmentResult, runResult] = await Promise.all([
    getLineQuota(),
    db.from("line_user_segments").select("segment").eq("campaign", "september_waiting"),
    db.from("line_campaign_runs").select("id, mode, status, message_text, target_count, created_at").order("created_at", { ascending: false }).limit(8),
  ]);
  const counts = emptySegmentCounts();
  for (const row of segmentResult.data ?? []) if (WAITING_SEGMENTS.includes(row.segment as WaitingSegment)) counts[row.segment as WaitingSegment] += 1;
  const runs = (runResult.data ?? []) as Run[];

  return <div>
    <div className="mb-6"><p className="text-sm font-medium text-rose-600">Mohjaew Backoffice</p><h1 className="text-2xl font-bold">LINE Marketing</h1></div>
    <div className="grid gap-4 md:grid-cols-2">
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="font-bold">Messaging API เดือนนี้</h2>
        {quota.ok ? <div className="mt-3"><p className="text-3xl font-bold">{quota.consumed.toLocaleString("th-TH")}</p><p className="text-sm text-gray-500">ใช้แล้ว {quota.type === "limited" ? `จาก ${quota.limit?.toLocaleString("th-TH")}` : "· ไม่จำกัด quota"}</p></div> : <p className="mt-3 text-sm text-amber-700">ยังอ่าน Usage ไม่ได้</p>}
      </section>
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="font-bold">september_waiting</h2>
        <div className="mt-3 grid grid-cols-3 gap-2">{WAITING_SEGMENTS.map((segment) => <div key={segment} className="rounded-lg bg-gray-50 p-3"><p className="break-all text-[11px] text-gray-500">{segment}</p><p className="mt-1 text-2xl font-bold">{counts[segment]}</p></div>)}</div>
      </section>
    </div>
    <div className="mt-5 grid gap-4 sm:grid-cols-2">
      <Link href="/admin/line/broadcast" className="rounded-xl border border-rose-200 bg-rose-50 p-5 font-bold text-rose-800">สร้าง Broadcast →</Link>
      <Link href="/admin/line/audience" className="rounded-xl border border-gray-200 bg-white p-5 font-bold">ดู Audience →</Link>
    </div>
    <section className="mt-6 rounded-xl border border-gray-200 bg-white p-5"><h2 className="font-bold">Campaign run ล่าสุด</h2>
      {runResult.error ? <p className="mt-3 text-sm text-gray-500">ยังไม่มีประวัติที่อ่านได้</p> : runs.length ? <div className="mt-3 divide-y divide-gray-100">{runs.map((run) => <div key={run.id} className="flex items-start justify-between gap-4 py-3 text-sm"><div><p className="line-clamp-1 font-medium">{run.message_text}</p><p className="text-xs text-gray-500">{run.mode.toUpperCase()} · {new Date(run.created_at).toLocaleString("th-TH")}</p></div><span className={run.status === "success" ? "text-green-700" : "text-red-700"}>{run.status}</span></div>)}</div> : <p className="mt-3 text-sm text-gray-500">ยังไม่มีประวัติการส่ง</p>}
    </section>
  </div>;
}
