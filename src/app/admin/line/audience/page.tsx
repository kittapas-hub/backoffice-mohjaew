import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { WAITING_SEGMENTS, type WaitingSegment } from "@/lib/line-campaign";
import { emptySegmentCounts, maskLineUserId } from "@/lib/line-marketing";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Row = { id: string; line_user_id: string; segment: WaitingSegment; created_at: string };

export default async function AudiencePage({ searchParams }: { searchParams: Promise<{ segment?: string }> }) {
  await requireAdmin();
  const { segment: rawSegment } = await searchParams;
  const segment = WAITING_SEGMENTS.includes(rawSegment as WaitingSegment) ? rawSegment as WaitingSegment : null;
  const db = supabaseAdmin();
  let recentQuery = db.from("line_user_segments").select("id, line_user_id, segment, created_at").eq("campaign", "september_waiting").order("created_at", { ascending: false }).limit(50);
  if (segment) recentQuery = recentQuery.eq("segment", segment);
  const [countResults, recentResult] = await Promise.all([
    Promise.all(WAITING_SEGMENTS.map((item) => db.from("line_user_segments").select("id", { count: "exact", head: true }).eq("campaign", "september_waiting").eq("segment", item))), recentQuery,
  ]);
  const counts = emptySegmentCounts();
  WAITING_SEGMENTS.forEach((item, index) => { counts[item] = countResults[index].count ?? 0; });
  const rows = (recentResult.data ?? []) as Row[];
  return <div>
    <div className="admin-page-header"><div><p className="admin-eyebrow">LINE Marketing</p><h1 className="admin-title">Audience</h1><p className="admin-description">ภาพรวมกลุ่มผู้ติดตามและรายการที่อัปเดตล่าสุด</p></div><Link href="/admin/line" className="admin-focus text-sm font-semibold text-gray-500">← Dashboard</Link></div>
    <div className="grid gap-3 sm:grid-cols-3">{WAITING_SEGMENTS.map((item) => <Link key={item} href={`/admin/line/audience?segment=${item}`} className={`rounded-xl border p-4 ${segment === item ? "border-rose-400 bg-rose-50" : "border-gray-200 bg-white"}`}><p className="text-xs text-gray-500">{item}</p><p className="mt-1 text-2xl font-bold">{counts[item]}</p></Link>)}</div>
    <div className="mt-4"><Link href="/admin/line/audience" className="text-sm text-gray-500">ล้างตัวกรอง</Link></div>
    <section className="admin-card mt-4 overflow-hidden"><div className="border-b border-gray-100 px-5 py-4 font-bold">รายการเลือกล่าสุด</div>
      {recentResult.error ? <p className="p-4 text-sm text-amber-700">ยังอ่าน Audience ไม่ได้</p> : rows.length ? <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="bg-gray-50 text-gray-500"><tr><th className="px-4 py-3">LINE user</th><th className="px-4 py-3">Segment</th><th className="px-4 py-3">เวลา</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="border-t border-gray-100"><td className="px-4 py-3 font-mono text-xs">{maskLineUserId(row.line_user_id)}</td><td className="px-4 py-3">{row.segment}</td><td className="px-4 py-3 text-gray-500">{new Date(row.created_at).toLocaleString("th-TH")}</td></tr>)}</tbody></table></div> : <p className="p-4 text-sm text-gray-500">ยังไม่มีข้อมูล</p>}
    </section>
  </div>;
}
