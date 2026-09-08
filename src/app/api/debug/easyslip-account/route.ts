export const dynamic = "force-dynamic";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" ? value as JsonObject : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function maskAccount(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length > 4 ? `***${digits.slice(-4)}` : "***";
}

export async function GET() {
  if (process.env.VERCEL_ENV !== "preview") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const apiKey = process.env.EASYSLIP_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "missing_config" }, { status: 503 });
  }

  const headers = { Authorization: `Bearer ${apiKey}` };
  const [infoRes, accountsRes, banksRes] = await Promise.all([
    fetch("https://api.easyslip.com/v2/info", { headers, cache: "no-store" }),
    fetch("https://api.easyslip.com/v2/bank-accounts?limit=100", { headers, cache: "no-store" }),
    fetch("https://api.easyslip.com/v2/banks", { headers, cache: "no-store" }),
  ]);

  const [infoRaw, accountsRaw, banksRaw]: unknown[] = await Promise.all([
    infoRes.json(), accountsRes.json(), banksRes.json(),
  ]);
  if (!infoRes.ok || !accountsRes.ok || !banksRes.ok) {
    const info = asObject(infoRaw);
    const accounts = asObject(accountsRaw);
    const banks = asObject(banksRaw);
    return Response.json({
      infoStatus: infoRes.status,
      accountsStatus: accountsRes.status,
      banksStatus: banksRes.status,
      infoError: asString(asObject(info.error).code),
      accountsError: asString(asObject(accounts.error).code),
      banksError: asString(asObject(banks.error).code),
    }, { status: 502 });
  }

  const info = asObject(asObject(infoRaw).data);
  const branch = asObject(info.branch);
  const accountItems = asObject(asObject(accountsRaw).data).items;
  const bankItems = asObject(banksRaw).data;
  const accounts = Array.isArray(accountItems) ? accountItems.map((value) => {
    const item = asObject(value);
    const bankCode = asString(item.bankCode);
    const bank = Array.isArray(bankItems)
      ? bankItems.map(asObject).find((entry) => asString(entry.code) === bankCode)
      : undefined;
    return {
      id: item.id,
      bankCode,
      bankNumber: maskAccount(item.bankNumber),
      nameTh: asString(item.nameTh),
      nameEn: asString(item.nameEn),
      type: asString(item.type),
      extraVerify: asString(item.extraVerify),
      supportedExtraVerify: bank && Array.isArray(bank.extraVerify)
        ? bank.extraVerify.map((option) => asObject(option)).map((option) => ({
            value: asString(option.value), label: asString(option.label),
          }))
        : null,
    };
  }) : [];
  return Response.json({
    branch: {
      name: asString(branch.name),
      isActive: typeof branch.isActive === "boolean" ? branch.isActive : null,
    },
    accounts,
  }, { headers: { "Cache-Control": "no-store" } });
}
