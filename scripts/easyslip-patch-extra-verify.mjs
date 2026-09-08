const key = process.env.EASYSLIP_API_KEY;
if (!key || key === "[SENSITIVE]") throw new Error("EASYSLIP_API_KEY unavailable in runtime");

const id = 2186;
const base = "https://api.easyslip.com/v2/bank-accounts";
const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

const patch = await fetch(`${base}/${id}`, {
  method: "PATCH",
  headers: auth,
  body: JSON.stringify({ extraVerify: null }),
});
const patchBody = await patch.json().catch(() => ({}));
console.log(`[easyslip-patch] status=${patch.status} success=${patchBody?.success === true}`);
if (!patch.ok || patchBody?.success !== true) {
  console.log(`[easyslip-patch] errorCode=${patchBody?.error?.code ?? "unknown"}`);
  throw new Error("EasySlip PATCH failed");
}

const get = await fetch(base, { headers: { Authorization: `Bearer ${key}` } });
const getBody = await get.json().catch(() => ({}));
const accounts = Array.isArray(getBody?.data) ? getBody.data : [];
const account = accounts.find((x) => x?.id === id);
console.log(`[easyslip-patch] verifyStatus=${get.status} found=${Boolean(account)} extraVerify=${account?.extraVerify ?? "null"}`);
if (!get.ok || !account || account.extraVerify !== null) {
  throw new Error("EasySlip PATCH verification failed");
}
