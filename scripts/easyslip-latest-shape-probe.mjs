import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const easyKey = process.env.EASYSLIP_API_KEY;
if (!supabaseUrl || !serviceKey || !easyKey) throw new Error("probe env missing");
const auth = { Authorization: `Bearer ${easyKey}` };
const accountId = 2186;
const accountUrl = `https://api.easyslip.com/v2/bank-accounts/${accountId}`;

const patchName = await fetch(accountUrl, {
  method: "PATCH", headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ extraVerify: "NAME" }),
});
const patchBody = await patchName.json().catch(() => ({}));
console.log(`[name-ab] patchStatus=${patchName.status} success=${patchBody?.success === true} extraVerify=${patchBody?.data?.extraVerify ?? "unknown"}`);
if (!patchName.ok || patchBody?.success !== true) throw new Error("NAME patch failed");

const path = "0d66b17f-302f-4930-a395-16c17f9351d9/32f09a7d-35c5-4c47-b6c9-97367e0c844e/17e54852-08bf-4ea1-87a2-d1da2e543320.jpg";
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
const { data: blob, error } = await supabase.storage.from("payment-slips").download(path);
if (error || !blob) throw new Error(`slip download failed: ${error?.message ?? "unknown"}`);

const form = new FormData();
form.append("image", blob, "slip.jpg");
form.append("matchAccount", "true");
form.append("checkDuplicate", "false");
const res = await fetch("https://api.easyslip.com/v2/verify/bank", {
  method: "POST", headers: auth, body: form,
});
const body = await res.json().catch(() => ({}));
const obj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
const data = obj(body.data);
const raw = obj(data.rawSlip);
const receiver = obj(raw.receiver);
const account = obj(receiver.account);
const name = obj(account.name);
const matched = data.matchedAccount == null ? null : obj(data.matchedAccount);

console.log(`[name-ab] verifyHttp=${res.status} success=${body.success === true} matchedPresent=${matched !== null}`);
console.log(`[name-ab] receiverNameThPresent=${Boolean(name.th)} receiverNameEnPresent=${Boolean(name.en)} receiverProxyPresent=${Boolean(obj(account.proxy).account)}`);

if (!matched) {
  const rollback = await fetch(accountUrl, {
    method: "PATCH", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ extraVerify: null }),
  });
  const rollbackBody = await rollback.json().catch(() => ({}));
  console.log(`[name-ab] rollbackStatus=${rollback.status} success=${rollbackBody?.success === true} extraVerify=${rollbackBody?.data?.extraVerify ?? "unknown"}`);
}
if (!res.ok || body.success !== true) throw new Error(`EasySlip verify failed http=${res.status}`);
