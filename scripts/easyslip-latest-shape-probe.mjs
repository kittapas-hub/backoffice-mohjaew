import { createClient } from "@supabase/supabase-js";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const easyKey = process.env.EASYSLIP_API_KEY;
if (!supabaseUrl || !serviceKey || !easyKey) throw new Error("probe env missing");
const auth = { Authorization: `Bearer ${easyKey}` };
const jsonHeaders = { ...auth, "Content-Type": "application/json" };
const accountUrl = "https://api.easyslip.com/v2/bank-accounts/2186";
const path = "0d66b17f-302f-4930-a395-16c17f9351d9/32f09a7d-35c5-4c47-b6c9-97367e0c844e/17e54852-08bf-4ea1-87a2-d1da2e543320.jpg";
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
const { data: blob, error } = await supabase.storage.from("payment-slips").download(path);
if (error || !blob) throw new Error(`slip download failed: ${error?.message ?? "unknown"}`);
const obj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};

async function verify() {
  const form = new FormData();
  form.append("image", blob, "slip.jpg");
  form.append("matchAccount", "true");
  form.append("checkDuplicate", "false");
  const res = await fetch("https://api.easyslip.com/v2/verify/bank", { method: "POST", headers: auth, body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success !== true) throw new Error(`verify failed ${res.status}`);
  return obj(body.data);
}
const accountRes = await fetch(accountUrl, { headers: auth });
const accountBody = await accountRes.json().catch(() => ({}));
const original = obj(accountBody.data);
if (!accountRes.ok || accountBody.success !== true) throw new Error("account fetch failed");
const first = await verify();
const receiverName = obj(obj(obj(first.rawSlip).receiver).account).name;
const rawNameTh = obj(receiverName).th;
console.log(`[rawname-ab] baselineMatched=${first.matchedAccount != null} rawNameThPresent=${Boolean(rawNameTh)}`);
if (typeof rawNameTh !== "string" || !rawNameTh.trim()) throw new Error("raw Thai receiver name missing");

const patch = await fetch(accountUrl, {
  method: "PATCH", headers: jsonHeaders,
  body: JSON.stringify({ nameTh: rawNameTh, extraVerify: "NAME" }),
});
const patchBody = await patch.json().catch(() => ({}));
console.log(`[rawname-ab] patchStatus=${patch.status} success=${patchBody?.success === true}`);
if (!patch.ok || patchBody?.success !== true) throw new Error("raw-name patch failed");

const second = await verify();
console.log(`[rawname-ab] rawNameMatched=${second.matchedAccount != null}`);
const rollback = await fetch(accountUrl, {
  method: "PATCH", headers: jsonHeaders,
  body: JSON.stringify({ nameTh: original.nameTh, nameEn: original.nameEn, extraVerify: null }),
});
const rollbackBody = await rollback.json().catch(() => ({}));
console.log(`[rawname-ab] rollbackStatus=${rollback.status} success=${rollbackBody?.success === true}`);
if (!rollback.ok || rollbackBody?.success !== true) throw new Error("rollback failed");
