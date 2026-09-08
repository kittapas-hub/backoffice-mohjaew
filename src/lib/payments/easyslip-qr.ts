const EASYSLIP_QR_URL = "https://api.easyslip.com/v1/qr/generate";
const DEFAULT_TIMEOUT_MS = 10_000;

export type PromptPayTarget =
  | { kind: "msisdn"; value: string }
  | { kind: "natId"; value: string }
  | { kind: "eWalletId"; value: string };

export type GeneratedPaymentQr = {
  dataUrl: string;
  payload: string;
};

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : {};
}

export async function generateEasySlipPromptPayQr(opts: {
  apiKey: string;
  amountSatang: number;
  target: PromptPayTarget;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<GeneratedPaymentQr | null> {  if (!opts.apiKey || !Number.isSafeInteger(opts.amountSatang) || opts.amountSatang <= 0) {
    return null;
  }
  const body: Record<string, string | number> = {
    type: "PROMPTPAY",
    amount: opts.amountSatang / 100,
    [opts.target.kind]: opts.target.value,
  };
  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(EASYSLIP_QR_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    return null;
  }

  const raw = await response.json().catch(() => null);
  const root = obj(raw);
  const data = obj(root.data);
  const image = typeof data.image === "string" ? data.image.trim() : "";
  const mime = typeof data.mime === "string" ? data.mime.trim().toLowerCase() : "";
  const payload = typeof data.payload === "string" ? data.payload.trim() : "";
  if (
    !response.ok ||
    root.status !== 200 ||
    !image ||
    mime !== "image/png" ||
    !payload ||
    payload.length > 512
  ) {
    return null;
  }

  return {
    dataUrl: `data:image/png;base64,${image}`,
    payload,
  };
}
