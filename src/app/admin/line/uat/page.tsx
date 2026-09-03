import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { resolveLineUatTarget } from "@/lib/line-uat-pairing";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { PairingForm } from "./PairingForm";

export const dynamic = "force-dynamic";

export default async function LineUatPage() {
  await requireAdmin();
  const { data, error } = await supabaseAdmin()
    .from("line_uat_pairings")
    .select("line_user_id")
    .not("paired_at", "is", null)
    .order("paired_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const pairingAvailable = !error;
  const target = await resolveLineUatTarget(process.env.LINE_UAT_USER_ID, async () => data?.line_user_id);

  return <div>
    <div className="mb-6 flex items-center justify-between">
      <div><p className="text-sm text-rose-600">LINE Marketing</p><h1 className="text-2xl font-bold">ตั้งค่าบัญชี UAT</h1></div>
      <Link href="/admin/line" className="text-sm text-gray-500">← Dashboard</Link>
    </div>
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="font-bold">สถานะ</h2>
      <p className={`mt-2 text-sm font-semibold ${target ? "text-green-700" : "text-amber-700"}`}>{target ? "พร้อมทดสอบ" : "ยังไม่พร้อมทดสอบ"}</p>
      <p className="mt-1 text-sm text-gray-500">{target ? "มีบัญชี LINE สำหรับรับข้อความ UAT แล้ว (ซ่อน LINE user ID)" : pairingAvailable ? "สร้างรหัสด้านล่าง แล้วส่งจากบัญชี LINE ที่ต้องการใช้ทดสอบ" : "การ Pair ยังใช้ไม่ได้จนกว่าจะใช้ migration 0016"}</p>
    </section>
    <section className="mt-5 rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="font-bold">เชื่อมบัญชี LINE</h2>
      <p className="mb-4 mt-1 text-sm text-gray-500">รหัสไม่ถูกเก็บเป็นข้อความปกติ และหมดอายุใน 10 นาที</p>
      {pairingAvailable ? <PairingForm /> : <p className="text-sm text-amber-700">กรุณาใช้ migration 0016 ก่อนสร้างรหัส Pair</p>}
    </section>
  </div>;
}
