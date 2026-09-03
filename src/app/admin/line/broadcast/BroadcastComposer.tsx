"use client";

import { useActionState, useEffect, useState } from "react";
import { draftWithAi, sendLive, sendUat, type AiState, type SendState } from "./actions";

const initialSend: SendState = { kind: "idle", message: "" };
const initialAi: AiState = { kind: "idle", message: "", drafts: [] };
const choices = ["1️⃣ รอคำตอบ", "2️⃣ รอหลายเรื่อง", "3️⃣ สำเร็จแล้วเงียบ"];

export function BroadcastComposer({ liveEnabled, aiConfigured, initialLiveRequestKey }: { liveEnabled: boolean; aiConfigured: boolean; initialLiveRequestKey: string }) {
  const [messageText, setMessageText] = useState("");
  const [sendState, sendAction, sending] = useActionState(sendUat, initialSend);
  const [liveState, liveAction, liveSending] = useActionState(sendLive, initialSend);
  const [aiState, aiAction, drafting] = useActionState(draftWithAi, initialAi);
  const [liveRequestKey, setLiveRequestKey] = useState(initialLiveRequestKey);
  const [confirmation, setConfirmation] = useState("");
  const [liveResultVisible, setLiveResultVisible] = useState(true);

  useEffect(() => {
    if (liveState.kind !== "idle") {
      setConfirmation("");
      setLiveResultVisible(true);
    }
  }, [liveState]);

  const startNewBroadcast = () => {
    setLiveRequestKey(crypto.randomUUID());
    setConfirmation("");
    setLiveResultVisible(false);
  };

  const liveLocked = liveState.liveDisposition === "locked" || liveState.liveDisposition === "new_allowed";

  return <div className="grid gap-6 lg:grid-cols-[1.15fr_.85fr]">
    <div className="space-y-6">
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-rose-600">Campaign: september_waiting</p>
        <label className="mt-4 block text-sm font-semibold" htmlFor="messageText">ข้อความ Broadcast</label>
        <textarea id="messageText" value={messageText} onChange={(event) => setMessageText(event.target.value)} rows={7} maxLength={5000} className="mt-2 w-full rounded-lg border border-gray-300 p-3 text-sm" placeholder="เขียนข้อความที่ต้องการส่ง…" />
        <div className="mt-2 flex justify-between text-xs text-gray-500"><span>Quick reply 3 ตัวเลือกจะถูกแนบอัตโนมัติ</span><span>{messageText.length}/5,000</span></div>
        <form action={sendAction} className="mt-4">
          <input type="hidden" name="messageText" value={messageText} />
          <button disabled={sending || !messageText.trim()} className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{sending ? "กำลังส่ง…" : "ส่งทดสอบ (UAT)"}</button>
          <p className="mt-2 text-xs text-gray-500">ส่งเฉพาะบัญชี UAT ที่ตั้งค่าไว้ ไม่แสดง LINE user ID บนหน้านี้</p>
          {sendState.message && <Status kind={sendState.kind} message={sendState.message} />}
        </form>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="font-bold">Estimated message usage</h2>
        <p className="mt-2 text-sm text-gray-600">UAT: 1 ข้อความต่อการทดสอบ · Live: จำนวนผู้รับจริงจะขึ้นกับ LINE ณ เวลาส่ง</p>
      </section>

      {liveEnabled ? <section className="rounded-xl border border-red-200 bg-red-50 p-5">
        <h2 className="font-bold text-red-900">Live broadcast</h2>
        <p className="mt-1 text-sm text-red-800">ส่งถึงเพื่อนของ LINE OA ทุกคนที่มีสิทธิ์รับ Broadcast ณ เวลาส่ง ไม่ได้ส่งเฉพาะกลุ่ม WAIT_*</p>
        <p className="mt-1 text-xs text-red-700">WAIT_ANSWER, WAIT_MULTIPLE และ WAIT_STALLED ใช้เพื่อวิเคราะห์ผลใน Phase 1 เท่านั้น ไม่ใช่กลุ่มเป้าหมาย</p>
        <p className="mt-2 text-sm text-red-800">พิมพ์ BROADCAST เพื่อยืนยันการส่งถึงผู้ติดตามจริง</p>
        <form action={liveAction} className="mt-3 flex flex-wrap gap-2">
          <input type="hidden" name="messageText" value={messageText} />
          <input type="hidden" name="requestKey" value={liveRequestKey} />
          <input name="confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={liveLocked || liveSending} className="rounded-lg border border-red-300 px-3 py-2 text-sm disabled:opacity-50" autoComplete="off" />
          <button disabled={liveSending || liveLocked || !messageText.trim()} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{liveSending ? "กำลังส่ง…" : "ส่ง Live"}</button>
        </form>
        {liveResultVisible && liveState.message && <Status kind={liveState.kind} message={liveState.message} />}
        {liveState.liveDisposition === "new_allowed" && <button type="button" onClick={startNewBroadcast} className="mt-3 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-800">เริ่ม Broadcast ใหม่</button>}
        {liveState.liveDisposition === "locked" && <p className="mt-3 text-sm font-semibold text-red-900">รายการนี้ถูกล็อกเพื่อป้องกันการส่งซ้ำ โปรดตรวจสอบประวัติและ LINE ก่อนออกจากหน้านี้</p>}
      </section> : <p className="text-sm text-gray-500">Live broadcast ปิดอยู่ (ค่าเริ่มต้นเพื่อความปลอดภัย)</p>}
    </div>

    <div className="space-y-6">
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="font-bold">Preview</h2>
        <div className="mt-4 rounded-2xl bg-[#dce8e5] p-4">
          <div className="rounded-xl bg-white p-3 text-sm leading-6 shadow-sm">{messageText || "ข้อความของคุณจะแสดงที่นี่"}</div>
          <div className="mt-3 grid gap-2">{choices.map((choice) => <div key={choice} className="rounded-lg bg-white px-3 py-2 text-center text-xs font-medium text-sky-700">{choice}</div>)}</div>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="font-bold">AI Campaign Assistant</h2>
        {!aiConfigured && <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">AI Assistant ยังไม่ได้ตั้งค่า</p>}
        <form action={aiAction} className="mt-4 space-y-3">
          <input name="objective" required placeholder="เป้าหมาย / ธีม" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <input name="audience" required placeholder="Pain point / กลุ่มเป้าหมาย" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <textarea name="notes" rows={3} placeholder="โน้ตเพิ่มเติม (ถ้ามี)" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <button disabled={drafting || !aiConfigured} className="rounded-lg border border-gray-900 px-4 py-2 text-sm font-semibold disabled:opacity-40">{drafting ? "กำลังร่าง…" : "สร้าง 3 ร่าง"}</button>
        </form>
        {aiState.message && <Status kind={aiState.kind} message={aiState.message} />}
        <div className="mt-4 space-y-3">{aiState.drafts.map((draft, index) => <article key={index} className="rounded-lg border border-gray-200 p-3 text-sm">
          <h3 className="font-bold">{draft.headline}</h3><p className="mt-2 whitespace-pre-wrap">{draft.body}</p><p className="mt-2 font-medium text-rose-700">{draft.cta}</p><p className="mt-2 text-xs text-gray-500">มุม: {draft.angle}</p><p className="mt-1 text-xs text-amber-700">ข้อควรระวัง: {draft.caution}</p>
          <button type="button" onClick={() => setMessageText(`${draft.headline}\n\n${draft.body}\n\n${draft.cta}`)} className="mt-3 text-xs font-semibold text-blue-700">ใช้ร่างนี้ใน Composer</button>
        </article>)}</div>
      </section>
    </div>
  </div>;
}

function Status({ kind, message }: { kind: SendState["kind"] | AiState["kind"]; message: string }) {
  return <p className={`mt-3 rounded-lg p-3 text-sm ${kind === "success" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`} role="status">{message}</p>;
}
