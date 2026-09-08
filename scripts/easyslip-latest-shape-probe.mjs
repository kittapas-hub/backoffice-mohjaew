import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const easyKey = process.env.EASYSLIP_API_KEY;
if (!supabaseUrl || !serviceKey || !easyKey) throw new Error("probe env missing");

const path = "0d66b17f-302f-4930-a395-16c17f9351d9/32f09a7d-35c5-4c47-b6c9-97367e0c844e/17e54852-08bf-4ea1-87a2-d1da2e543320.jpg";
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
const { data: blob, error } = await supabase.storage.from("payment-slips").download(path);
if (error || !blob) throw new Error(`slip download failed: ${error?.message ?? "unknown"}`);

const form = new FormData();
form.append("image", blob, "slip.jpg");
form.append("matchAccount", "true");
form.append("checkDuplicate", "false");
const res = await fetch("https://api.easyslip.com/v2/verify/bank", {
  method: "POST", headers: { Authorization: `Bearer ${easyKey}` }, body: form,
});
const body = await res.json().catch(() => ({}));
const obj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
const data = obj(body.data); const raw = obj(data.rawSlip); const receiver = obj(raw.receiver);
const account = obj(receiver.account); const name = obj(account.name); const bankAccount = obj(account.bank); const proxy = obj(account.proxy);
const matched = data.matchedAccount == null ? null : obj(data.matchedAccount);
const norm = (v) => String(v ?? "").toLowerCase().replace(/[^0-9a-zก-๙]/g, "");
const cfgAccounts = String(process.env.SLIP_RECEIVER_ACCOUNTS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const cfgNames = String(process.env.SLIP_RECEIVER_NAMES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const actualAccounts = [bankAccount.account, proxy.account].filter(Boolean).map(norm);
const actualNames = [name.th, name.en].filter(Boolean).map(norm);
const expectedAccounts = cfgAccounts.map(norm);
const expectedNames = cfgNames.map(norm);

console.log(`[shape-probe] http=${res.status} success=${body.success === true} duplicate=${String(data.isDuplicate)}`);
console.log(`[shape-probe] matchedPresent=${matched !== null} dataKeys=${Object.keys(data).sort().join(",")}`);
console.log(`[shape-probe] receiverKeys=${Object.keys(receiver).sort().join(",")} accountKeys=${Object.keys(account).sort().join(",")}`);
console.log(`[shape-probe] bankKeys=${Object.keys(obj(receiver.bank)).sort().join(",")} bankAccountKeys=${Object.keys(bankAccount).sort().join(",")} proxyKeys=${Object.keys(proxy).sort().join(",")} nameKeys=${Object.keys(name).sort().join(",")}`);
console.log(`[shape-probe] rawBankPresent=${Boolean(bankAccount.account)} rawProxyPresent=${Boolean(proxy.account)} rawNamePresent=${actualNames.length > 0}`);
console.log(`[shape-probe] cfgAccountCount=${expectedAccounts.length} cfgNameCount=${expectedNames.length} exactAccountMatches=${actualAccounts.filter((a) => expectedAccounts.includes(a)).length} exactNameMatches=${actualNames.filter((n) => expectedNames.includes(n)).length}`);
if (matched) {
  const mbank = obj(matched.bank);
  console.log(`[shape-probe] matchedKeys=${Object.keys(matched).sort().join(",")} matchedBankCodePresent=${Boolean(mbank.code)} matchedBankNumberPresent=${Boolean(matched.bankNumber)} matchedNamePresent=${Boolean(matched.nameTh || matched.nameEn)}`);
}
if (!res.ok || body.success !== true) throw new Error(`EasySlip probe failed http=${res.status}`);
