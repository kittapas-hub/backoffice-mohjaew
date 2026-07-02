// Trusted client IP for rate limiting. Resolution order:
//   1. x-vercel-forwarded-for — set by the Vercel platform, not client-forgeable
//      (distinct from plain x-forwarded-for, whose first hop IS client-controlled).
//   2. x-real-ip — also platform-set, from the connecting socket.
//   3. "unknown" — fail-closed shared bucket, never a bypass: every request
//      missing both headers piles into one HMAC bucket, so it throttles
//      collectively instead of skipping the limit. On Vercel this should
//      never happen; if it does, every affected caller shares one allowance
//      until the underlying platform issue is fixed.
// `x-forwarded-for` is NEVER read: its first hop is client-controlled, which
// previously let a caller rotate rate-limit buckets with a forged header.
// ponytail: Vercel-only assumption; add a proxy-hop config if ever self-hosted.
export function clientIp(req: Request): string {
  const ip =
    req.headers.get("x-vercel-forwarded-for") ?? req.headers.get("x-real-ip");
  if (ip) return ip;

  // Both trusted headers missing. On Vercel this is unexpected — log loudly
  // (no header/IP values, just the fact) so it's visible instead of looking
  // like ordinary user-caused 429s. Off Vercel (local dev) it's expected.
  if (process.env.VERCEL) {
    console.error("[client-ip] both x-vercel-forwarded-for and x-real-ip are absent; falling back to shared bucket");
  }
  return "unknown";
}
