"use client";

import { useActionState } from "react";
import { createUatPairingCode, type PairingState } from "./actions";

const initialState: PairingState = { kind: "idle", code: null, message: "" };

export function PairingForm() {
  const [state, action, pending] = useActionState(createUatPairingCode, initialState);
  return <div>
    <form action={action}>
      <button disabled={pending} className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
        {pending ? "กำลังสร้าง…" : "สร้างรหัส Pair 10 นาที"}
      </button>
    </form>
    {state.code ? <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-4">
      <p className="font-mono text-xl font-bold tracking-wider text-rose-900">{state.code}</p>
      <p className="mt-2 text-sm text-rose-800">เปิดแชต LINE หมอแจว แล้วส่งรหัสนี้เป็นข้อความ</p>
    </div> : null}
    {state.message ? <p className={`mt-3 text-sm ${state.kind === "error" ? "text-red-700" : "text-gray-600"}`} role="status">{state.message}</p> : null}
  </div>;
}
