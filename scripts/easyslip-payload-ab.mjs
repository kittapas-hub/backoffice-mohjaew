import { createClient } from "@supabase/supabase-js";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const easyKey = process.env.EASYSLIP_API_KEY;
if (!supabaseUrl || !serviceKey || !easyKey) throw new Error("probe env missing");
const auth = { Authorization: `Bearer ${easyKey}` };
const path = "0d66b17f-302f-4930-a395-16c17f9351d9/32f09a7d-35c5-4c47-b6c9-97367e0c844e/17e54852-08bf-4ea1-87a2-d1da2e543320.jpg";
const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
const { data: blob, error } = await sb.storage.from("payment-slips").download(path);
if (error || !blob) throw new Error(`download failed: ${error?.message ?? "unknown"}`);
const form = new FormData();
form.append("image", blob, "slip.jpg");
form.append("matchAccount", "true");
form.append("checkDuplicate", "false");
const imageRes = await fetch("https://api.easyslip.com/v2/verify/bank", { method: "POST", headers: auth, body: form });
const imageBody = await imageRes.json().catch(() => ({}));
const payload = imageBody?.data?.rawSlip?.payload;
console.log(`[payload-ab] imageHttp=${imageRes.status} imageSuccess=${imageBody?.success === true} imageMatched=${imageBody?.data?.matchedAccount != null} payloadPresent=${typeof payload === "string" && payload.length > 0}`);
if (!imageRes.ok || imageBody?.success !== true || typeof payload !== "string" || !payload) throw new Error("image probe failed");
const payloadRes = await fetch("https://api.easyslip.com/v2/verify/bank", {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ payload, matchAccount: true, checkDuplicate: false }),
});
const payloadBody = await payloadRes.json().catch(() => ({}));
const receiver = payloadBody?.data?.rawSlip?.receiver;
const account = receiver?.account;
console.log(`[payload-ab] payloadHttp=${payloadRes.status} payloadSuccess=${payloadBody?.success === true} payloadMatched=${payloadBody?.data?.matchedAccount != null}`);
console.log(`[payload-ab] payloadReceiverBank=${Boolean(account?.bank?.account)} payloadReceiverProxy=${Boolean(account?.proxy?.account)} payloadReceiverName=${Boolean(account?.name?.th || account?.name?.en)}`);
if (!payloadRes.ok || payloadBody?.success !== true) throw new Error("payload probe failed");
