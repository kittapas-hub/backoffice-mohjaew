import crypto from "node:crypto";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { isLiveBroadcastEnabled } from "@/lib/line-campaign";
import { BroadcastComposer } from "./BroadcastComposer";

export const dynamic = "force-dynamic";

export default async function BroadcastPage() {
  await requireAdmin();
  return <div>
    <div className="admin-page-header"><div><p className="admin-eyebrow">LINE Marketing</p><h1 className="admin-title">Broadcast Studio</h1><p className="admin-description">ร่างข้อความ ดูตัวอย่าง และส่งทดสอบก่อนเผยแพร่จริง</p></div><Link href="/admin/line" className="admin-focus text-sm font-semibold text-gray-500">← Dashboard</Link></div>
    <BroadcastComposer liveEnabled={isLiveBroadcastEnabled()} aiConfigured={Boolean(process.env.OPENAI_API_KEY)} initialLiveRequestKey={crypto.randomUUID()} />
  </div>;
}
