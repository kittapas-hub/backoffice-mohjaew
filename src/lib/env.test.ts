// Self-check for env.ts's LINE team-group configuration, and a repo-wide
// guard that the retired LINE_BOOKING_NOTIFY_GROUP_ID name never comes back.
// Run: node --experimental-strip-types src/lib/env.test.ts
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ===========================================================================
// Repository-wide: zero tracked-file occurrences of the retired env var name.
// No fallback, no dual-name support, no leftover reference in code, tests,
// fixtures, docs, or .env.example.
// ===========================================================================
function trackedOccurrences(needle: string): number {
  try {
    const out = execFileSync("git", ["grep", "-c", needle], { cwd: repoRoot, encoding: "utf8" });
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(":") + 1)), 0);
  } catch (err) {
    // git grep exits 1 when there are no matches — that is the success case.
    if (err && typeof err === "object" && "status" in err && err.status === 1) return 0;
    throw err;
  }
}

assert.equal(
  trackedOccurrences("LINE_BOOKING_NOTIFY_GROUP_ID"),
  0,
  "the retired LINE_BOOKING_NOTIFY_GROUP_ID name must have zero occurrences anywhere in the repository",
);
// Sanity check on the probe itself: a name that legitimately exists must be found.
assert.ok(trackedOccurrences("LINE_BOOKING_GROUP_ID") > 0, "sanity: trackedOccurrences must be able to find a real match");

// ===========================================================================
// serverEnv.notifyGroupId: reads only LINE_BOOKING_GROUP_ID. The old name,
// even when present in the environment, must be completely ignored — no
// fallback, no merge, no dual-name support.
// ===========================================================================
delete process.env.LINE_BOOKING_GROUP_ID;
delete process.env.LINE_BOOKING_NOTIFY_GROUP_ID;

const CORRECT_GROUP_ID = "C" + "1".repeat(32);
const STALE_GROUP_ID = "C" + "2".repeat(32);

{
  process.env.LINE_BOOKING_GROUP_ID = CORRECT_GROUP_ID;
  process.env.LINE_BOOKING_NOTIFY_GROUP_ID = STALE_GROUP_ID;
  const { serverEnv } = await import("./env.ts");
  assert.equal(
    serverEnv.notifyGroupId,
    CORRECT_GROUP_ID,
    "serverEnv.notifyGroupId must read LINE_BOOKING_GROUP_ID and ignore the stale LINE_BOOKING_NOTIFY_GROUP_ID entirely",
  );
}

{
  // No fallback: with only the new name unset (even though the old name is
  // still present in the environment), resolution must fail closed.
  delete process.env.LINE_BOOKING_GROUP_ID;
  process.env.LINE_BOOKING_NOTIFY_GROUP_ID = STALE_GROUP_ID;
  const { serverEnv } = await import("./env.ts");
  assert.throws(
    () => serverEnv.notifyGroupId,
    /Missing required env var: LINE_BOOKING_GROUP_ID/,
    "serverEnv.notifyGroupId must fail closed on the new name being unset, never silently falling back to the old one",
  );
}

// ===========================================================================
// line.ts's notifyTeamSafe / notifyTeamImageSafe read process.env directly
// (not via serverEnv) — same no-fallback requirement applies there.
// ===========================================================================
{
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
  process.env.LINE_CHANNEL_SECRET = "test-secret";
  process.env.LINE_BOOKING_GROUP_ID = CORRECT_GROUP_ID;
  process.env.LINE_BOOKING_NOTIFY_GROUP_ID = STALE_GROUP_ID;
  const { notifyTeamSafe } = await import("./line.ts");

  let observedTo: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    observedTo = body.to ?? null;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const result = await notifyTeamSafe("hello team");
  globalThis.fetch = originalFetch;

  assert.equal(result.ok, true);
  assert.equal(observedTo, CORRECT_GROUP_ID, "notifyTeamSafe must send to LINE_BOOKING_GROUP_ID, never the stale name");
  assert.notEqual(observedTo, STALE_GROUP_ID);
}

console.log("env self-check passed");
