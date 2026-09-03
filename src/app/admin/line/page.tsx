import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { WAITING_SEGMENTS } from "@/lib/line-campaign";
import { emptySegmentCounts, getLineQuota } from "@/lib/line-marketing";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Run = { id: string; mode: string; status: string; message_text: string; target_count: number | null; created_at: string };

export default async function LineDashboard() {
  await requireAdmin();
  const db = supabaseAdmin();
  const [quota, segmentResults, runResult] = await Promise.all([
    getLineQuota(),
    Promise.all(WAITING_SEGMENTS.map((segment) => db.from("line_user_segments").select("id", { count: "exact", head: true }).eq("campaign", "september_waiting").eq("segment", segment))),
    db.from("line_campaign_runs").select("id, mode, status, message_text, target_count, created_at").order("created_at", { ascending: false }).limit(8),
  ]);
  const counts = emptySegmentCounts();
  WAITING_SEGMENTS.forEach((segment, index) => { counts[segment] = segmentResults[index].count ?? 0; });
  const runs = (runResult.data ?? []) as Run[];

  return <div>
    <div className="admin-page-header"><div><p className="admin-eyebrow">Customer engagement</p><h1 className="admin-title">LINE Marketing</h1><p className="admin-description">ดูภาพรวมผู้ติดตาม เตรียมแคมเปญ และติดตามผลการส่ง</p></div><Link href="/admin/line/broadcast" className="admin-focus rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-rose-200 hover:bg-rose-700">สร้าง Broadcast</Link></div>
    <div className="grid gap-4 md:grid-cols-2">
      <section className="admin-card p-5 sm:p-6">
        <p className="admin-eyebrow">Usage</p><h2 className="mt-1 font-bold">Messaging API เดือนนี้</h2>
        {quota.ok ? <div className="mt-3"><p className="text-3xl font-bold">{quota.consumed.toLocaleString("th-TH")}</p><p className="text-sm text-gray-500">ใช้แล้ว {quota.type === "limited" ? `จาก ${quota.limit?.toLocaleString("th-TH")}` : "· ไม่จำกัด quota"}</p></div> : <p className="mt-3 text-sm text-amber-700">ยังอ่าน Usage ไม่ได้</p>}
      </section>
      <section className="admin-card p-5 sm:p-6">
        <p className="admin-eyebrow">Audience</p><h2 className="mt-1 font-bold">september_waiting</h2>
        <div className="mt-3 grid grid-cols-3 gap-2">{WAITING_SEGMENTS.map((segment) => <div key={segment} className="rounded-lg bg-gray-50 p-3"><p className="break-all text-[11px] text-gray-500">{segment}</p><p className="mt-1 text-2xl font-bold">{counts[segment]}</p></div>)}</div>
      </section>
    </div>
    <div className="mt-5 grid gap-4 sm:grid-cols-3">
      <Link href="/admin/line/broadcast" className="admin-card admin-focus group p-5 font-bold text-rose-800 transition hover:-translate-y-0.5 hover:border-rose-200"><span className="mb-3 block text-2xl">✦</span>สร้าง Broadcast <span className="float-right">→</span><small className="mt-2 block font-normal text-gray-500">เขียน ทดสอบ และดูตัวอย่าง</small></Link>
      <Link href="/admin/line/audience" className="admin-card admin-focus group p-5 font-bold transition hover:-translate-y-0.5 hover:border-rose-200"><span className="mb-3 block text-2xl">◎</span>ดู Audience <span className="float-right">→</span><small className="mt-2 block font-normal text-gray-500">ตรวจสอบ Segment ล่าสุด</small></Link>
      <Link href="/admin/line/uat" className="admin-card admin-focus group p-5 font-bold transition hover:-translate-y-0.5 hover:border-rose-200"><span className="mb-3 block text-2xl">✓</span>ตั้งค่า UAT <span className="float-right">→</span><small className="mt-2 block font-normal text-gray-500">เชื่อมบัญชีสำหรับทดสอบ</small></Link>
    </div>
    <section className="admin-card mt-6 p-5 sm:p-6"><p className="admin-eyebrow">History</p><h2 className="mt-1 font-bold">Campaign run ล่าสุด</h2>
      {runResult.error ? <p className="mt-3 text-sm text-gray-500">ยังไม่มีประวัติที่อ่านได้</p> : runs.length ? <div className="mt-3 divide-y divide-gray-100">{runs.map((run) => <div key={run.id} className="flex items-start justify-between gap-4 py-3 text-sm"><div><p className="line-clamp-1 font-medium">{run.message_text}</p><p className="text-xs text-gray-500">{run.mode.toUpperCase()} · {new Date(run.created_at).toLocaleString("th-TH")}</p></div><span className={run.status === "success" ? "text-green-700" : "text-red-700"}>{run.status}</span></div>)}</div> : <p className="mt-3 text-sm text-gray-500">ยังไม่มีประวัติการส่ง</p>}
    </section>
  </div>;
}
