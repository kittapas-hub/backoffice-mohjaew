import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { chatScope, chatbotEnabled, chatbotConfig, validUuid } from "@/lib/line-chat";
import { changeChatMode } from "./actions";
export const dynamic = "force-dynamic";
type Conversation = { id: string; user_id: string; mode: string; updated_at: string };
export default async function ChatPage({ searchParams }: { searchParams: Promise<{ conversation?: string }> }) {
  await requireAdmin();
  const params = await searchParams;
  const db = supabaseAdmin();
  const { data, error } = await db.from("line_chat_conversations").select("id,user_id,mode,updated_at")
    .eq("scope", chatScope()).order("updated_at", { ascending: false }).limit(50);
  const conversations = (data ?? []) as Conversation[];
  let selected = conversations.find(c => c.id === params.conversation);
  if (!selected && validUuid(params.conversation)) {
    const { data: older } = await db.from("line_chat_conversations").select("id,user_id,mode,updated_at")
      .eq("id", params.conversation).eq("scope", chatScope()).maybeSingle();
    selected = older ?? undefined;
  }
  const { data: jobs } = selected ? await db.from("line_chat_jobs")
    .select("id,user_text,reply_text,status,error_code,created_at").eq("conversation_id", selected.id)
    .order("created_at", { ascending: false }).limit(30) : { data: [] };
  const status: Record<string, string> = { pending: "รอประมวลผล", processing: "กำลังคิดคำตอบ", ready: "รอส่ง",
    sending: "กำลังส่ง", sent: "ส่งแล้ว", cancelled: "พักการตอบ", failed: "ส่งไม่สำเร็จ", unknown: "ต้องตรวจการส่งใน LINE" };
  return <section style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
    <h1>บทสนทนา LINE</h1>
    <p>{chatbotEnabled() ? chatbotConfig() ? "เปิดรับข้อความอัตโนมัติ" : "ยังตั้งค่าการเชื่อมต่อไม่ครบ" : "บอทยังปิดอยู่"}</p>
    <p>กดพักบอทก่อนตอบลูกค้าใน LINE OA แล้วกดให้บอทตอบเมื่อดูแลเสร็จ ข้อความที่ส่งออกไปแล้วเรียกคืนไม่ได้</p>
    {error ? <p role="alert">ยังอ่านบทสนทนาไม่ได้ ตรวจว่าติดตั้งตาราง Chat Bot แล้ว</p> : null}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,300px),1fr))", gap: 24 }}>
      <div><h2>ลูกค้าล่าสุด</h2>{conversations.length === 0 ? <p>ยังไม่มีบทสนทนา</p> : conversations.map(c =>
        <div key={c.id} style={{ padding: 12, borderBottom: "1px solid #ddd", overflowWrap: "anywhere" }}>
          <Link href={"/admin/chat?conversation=" + c.id}>LINE …{c.user_id.slice(-8)}</Link>
          <p>{c.mode === "human" ? "แอดมินดูแล" : "บอทตอบ"} · {new Date(c.updated_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}</p>
        </div>)}</div>
      <div>{selected ? <>
        <h2>LINE …{selected.user_id.slice(-8)}</h2>
        <form action={changeChatMode}>
          <input type="hidden" name="conversationId" value={selected.id} />
          <input type="hidden" name="mode" value={selected.mode === "bot" ? "human" : "bot"} />
          <button type="submit" style={{ padding: "10px 16px", border: "1px solid #777", borderRadius: 8 }}>
            {selected.mode === "bot" ? "พักบอท — แอดมินรับช่วง" : "ให้บอทตอบข้อความใหม่"}
          </button>
        </form>
        <p>เมื่อเปิดบอทอีกครั้ง จะตอบเฉพาะข้อความใหม่ งานเก่าที่พักไว้จะไม่ส่งย้อนหลัง</p>
        {(jobs ?? []).reverse().map(j => <article key={j.id} style={{ padding: 16, marginTop: 12, border: "1px solid #ddd", borderRadius: 8 }}>
          <small>{new Date(j.created_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })} · {status[j.status] ?? j.status}</small>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}><strong>ลูกค้า:</strong> {j.user_text}</p>
          {j.reply_text ? <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}><strong>{j.status === "sent" ? "บอท:" : "คำตอบที่ยังไม่ยืนยันการส่ง:"}</strong> {j.reply_text}</p> : null}
          {j.status === "unknown" ? <p role="alert">ตรวจข้อความใน LINE OA ก่อนตอบเอง แล้วพักบอทเพื่อปิดงานที่ค้าง</p> : null}
        </article>)}
      </> : <p>เลือกบทสนทนาเพื่อดูข้อความและจัดการบอท</p>}</div>
    </div>
  </section>;
}
