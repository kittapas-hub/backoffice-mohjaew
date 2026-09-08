const apiKey = process.env.EASYSLIP_API_KEY;
if (!apiKey) {
  console.log("[easyslip-probe] EASYSLIP_API_KEY missing");
  process.exit(0);
}

const headers = { Authorization: `Bearer ${apiKey}` };
const endpoints = [
  ["accounts", "https://api.easyslip.com/v2/bank-accounts?limit=100"],
  ["allAccounts", "https://api.easyslip.com/v2/bank-accounts/all?limit=100"],
  ["banks", "https://api.easyslip.com/v2/banks"],
  ["info", "https://api.easyslip.com/v2/info"],
];

const asObj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
const mask = (v) => {
  if (typeof v !== "string") return v ?? null;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
};
for (const [label, url] of endpoints) {
  try {
    const res = await fetch(url, { headers });
    const raw = await res.json().catch(() => null);
    const root = asObj(raw);
    const data = root.data;
    console.log(`[easyslip-probe] ${label} status=${res.status} rootKeys=${Object.keys(root).join(",")}`);

    if (label === "accounts" || label === "allAccounts") {
      const items = Array.isArray(data) ? data : Array.isArray(asObj(data).items) ? asObj(data).items : [];
      console.log(`[easyslip-probe] ${label} count=${items.length}`);
      for (const value of items) {
        const item = asObj(value);
        console.log("[easyslip-probe] account=" + JSON.stringify({
          id: item.id ?? null,
          bankCode: item.bankCode ?? item.bank?.code ?? null,
          bankNumber: mask(item.bankNumber ?? item.accountNumber),
          nameTh: item.nameTh ?? null,
          nameEn: item.nameEn ?? null,
          type: item.type ?? null,
          extraVerify: item.extraVerify ?? null,
          keys: Object.keys(item),
        }));
      }
    }
    if (label === "banks") {
      const items = Array.isArray(data) ? data : Array.isArray(asObj(data).items) ? asObj(data).items : [];
      const kbank = items.map(asObj).find((x) => String(x.code ?? x.bankCode ?? "").toUpperCase().includes("KBANK"));
      console.log("[easyslip-probe] kbank=" + JSON.stringify(kbank ? {
        code: kbank.code ?? kbank.bankCode ?? null,
        name: kbank.name ?? kbank.nameTh ?? null,
        extraVerify: kbank.extraVerify ?? null,
        keys: Object.keys(kbank),
      } : null));
    }

    if (label === "info") {
      const info = asObj(data);
      const branch = asObj(info.branch);
      console.log("[easyslip-probe] info=" + JSON.stringify({
        dataKeys: Object.keys(info),
        branch: Object.keys(branch).length ? {
          id: branch.id ?? null,
          name: branch.name ?? null,
          isActive: branch.isActive ?? null,
          keys: Object.keys(branch),
        } : null,
      }));
    }
  } catch (error) {
    console.log(`[easyslip-probe] ${label} ERROR=${error instanceof Error ? error.message : "unknown"}`);
  }
}
