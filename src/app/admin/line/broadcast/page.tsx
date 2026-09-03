import crypto from "node:crypto";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { isLiveBroadcastEnabled } from "@/lib/line-campaign";
import { BroadcastComposer } from "./BroadcastComposer";

export const dynamic = "force-dynamic";

export default async function BroadcastPage() {
  await requireAdmin();
  return <div>
    <div className="mb-6 flex items-center justify-between"><div><p className="text-sm text-rose-600">LINE Marketing</p><h1 className="text-2xl font-bold">Broadcast</h1></div><Link href="/admin/line" className="text-sm text-gray-500">← Dashboard</Link></div>
    <BroadcastComposer liveEnabled={isLiveBroadcastEnabled()} aiConfigured={Boolean(process.env.OPENAI_API_KEY)} initialLiveRequestKey={crypto.randomUUID()} />
  </div>;
}
