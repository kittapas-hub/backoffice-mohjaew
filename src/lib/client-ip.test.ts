// Self-check for the trusted client-IP resolver (Phase 0 hardening).
// Run: node --experimental-strip-types src/lib/client-ip.test.ts
import assert from "node:assert";
import { clientIp } from "./client-ip.ts";

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/slots", { headers });
}

function withVercelEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.VERCEL;
  if (value === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prev;
  }
}

function captureConsoleError<T>(fn: () => T): { result: T; logs: unknown[][] } {
  const logs: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args);
  };
  try {
    return { result: fn(), logs };
  } finally {
    console.error = original;
  }
}

// --- resolution order: x-vercel-forwarded-for wins over x-real-ip -----------
assert.equal(
  clientIp(req({ "x-vercel-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" })),
  "1.1.1.1",
  "x-vercel-forwarded-for must win when both trusted headers are present and differ",
);

// --- falls back to x-real-ip when x-vercel-forwarded-for is absent ----------
assert.equal(
  clientIp(req({ "x-real-ip": "3.3.3.3" })),
  "3.3.3.3",
  "x-real-ip is used when x-vercel-forwarded-for is missing",
);

// --- x-forwarded-for is never read, even as a last resort -------------------
assert.equal(
  clientIp(req({ "x-forwarded-for": "9.9.9.9, 8.8.8.8" })),
  "unknown",
  "x-forwarded-for must never be read (client-spoofable first hop)",
);
{
  const result = withVercelEnv(undefined, () =>
    clientIp(req({ "x-forwarded-for": "9.9.9.9" })),
  );
  assert.equal(result, "unknown", "x-forwarded-for ignored regardless of VERCEL env");
}

// --- both trusted headers missing, on Vercel: fail-closed shared bucket + redacted log ---
{
  const { result, logs } = withVercelEnv("1", () =>
    captureConsoleError(() => clientIp(req({}))),
  );
  assert.equal(result, "unknown", "missing both headers on Vercel must fail closed to a shared bucket, not bypass the limit");
  assert.equal(logs.length, 1, "must emit exactly one error log when both trusted headers are absent on Vercel");
  const logged = logs[0].map(String).join(" ");
  assert.doesNotMatch(logged, /\d+\.\d+\.\d+\.\d+/, "log must not contain a raw IPv4 address");
  assert.doesNotMatch(logged, /x-forwarded-for/i, "log must not reference the untrusted header");
}

// --- both trusted headers missing, on Vercel, one header present: no log ----
{
  const { result, logs } = withVercelEnv("1", () =>
    captureConsoleError(() => clientIp(req({ "x-real-ip": "4.4.4.4" }))),
  );
  assert.equal(result, "4.4.4.4");
  assert.equal(logs.length, 0, "must not log when a trusted header is present");
}

// --- both trusted headers missing, locally (no VERCEL env): silent fallback ---
{
  const { result, logs } = withVercelEnv(undefined, () =>
    captureConsoleError(() => clientIp(req({}))),
  );
  assert.equal(result, "unknown", "local dev falls back to unknown");
  assert.equal(logs.length, 0, "must not log outside Vercel — expected in local dev");
}

console.log("client-ip self-check passed");
