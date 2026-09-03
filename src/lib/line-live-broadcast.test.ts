import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveBroadcastDisposition, runLiveBroadcast } from "./line-live-broadcast.ts";

let sends = 0;
let finalizations: unknown[] = [];
const run = (overrides: Partial<Parameters<typeof runLiveBroadcast>[0]> = {}) => runLiveBroadcast({
  claim: async () => "claimed",
  send: async () => { sends += 1; return { ok: true }; },
  finalize: async (...args) => { finalizations.push(args); return true; },
  ...overrides,
});

assert.equal(await run(), "success");
assert.deepEqual(finalizations.pop(), ["success", 200]);

sends = 0;
assert.equal(await run({ claim: async () => "duplicate" }), "duplicate");
assert.equal(sends, 0, "a duplicate claim must never call LINE");
assert.equal(await run({ claim: async () => "error" }), "claim_failed");
assert.equal(sends, 0, "a failed audit claim must never call LINE");

assert.equal(await run({ finalize: async () => false }), "audit_failed");
assert.equal(await run({ finalize: async () => { throw new Error("audit unavailable"); } }), "audit_failed");

finalizations = [];
assert.equal(await run({ send: async () => ({ ok: false, error: "network_error" }) }), "line_unknown");
assert.deepEqual(finalizations.pop(), ["unknown", undefined]);

finalizations = [];
assert.equal(await run({ send: async () => ({ ok: false, error: "line_error", status: 400 }) }), "line_failed");
assert.deepEqual(finalizations.pop(), ["failed", 400]);

sends = 0;
assert.equal(await run({ claim: async () => { throw new Error("claim unavailable"); } }), "claim_failed");
assert.equal(sends, 0, "a thrown claim failure must never call LINE");

let claimed = false;
sends = 0;
const durableRun = () => runLiveBroadcast({
  claim: async () => claimed ? "duplicate" : (claimed = true, "claimed"),
  send: async () => { sends += 1; return { ok: false, error: "network_error" }; },
  finalize: async () => true,
});
assert.equal(await durableRun(), "line_unknown");
assert.equal(await durableRun(), "duplicate");
assert.equal(sends, 1, "an unknown LINE result must keep its claim and block retry");

assert.equal(liveBroadcastDisposition("success"), "new_allowed");
assert.equal(liveBroadcastDisposition("line_failed"), "new_allowed");
assert.equal(liveBroadcastDisposition("claim_failed"), "retry_same");
assert.equal(liveBroadcastDisposition("line_unknown"), "locked");
assert.equal(liveBroadcastDisposition("audit_failed"), "locked");
assert.equal(liveBroadcastDisposition("duplicate"), "locked");

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migration = readFileSync(join(root, "supabase", "migrations", "0017_line_campaign_live_idempotency.sql"), "utf8");
assert.match(migration, /request_key uuid/);
assert.match(migration, /unique index[\s\S]*request_key/i);
assert.match(migration, /status in \('pending', 'success', 'failed', 'unknown'\)/);
assert.match(migration, /enable row level security/);
assert.match(migration, /revoke all.*anon, authenticated/);
assert.match(migration, /grant all.*service_role/);

const action = readFileSync(join(root, "src", "app", "admin", "line", "broadcast", "actions.ts"), "utf8");
assert.ok(action.indexOf('status: "pending"') < action.indexOf("sendLineBroadcast(campaignMessages(messageText)"), "the durable claim must be written before LINE is called");
assert.match(action, /อาจส่ง LINE สำเร็จแล้ว แต่บันทึก Audit ไม่สำเร็จ ห้ามส่งซ้ำ/);
assert.match(action, /คำขอนี้ถูกส่งไปแล้วหรือกำลังดำเนินการ ห้ามส่งซ้ำ/);

const composer = readFileSync(join(root, "src", "app", "admin", "line", "broadcast", "BroadcastComposer.tsx"), "utf8");
assert.match(composer, /useState\(initialLiveRequestKey\)/, "one submission must keep its initial request key");
assert.doesNotMatch(composer, /useEffect\(\(\) => \{[\s\S]*setLiveRequestKey\(crypto\.randomUUID\(\)\)[\s\S]*\}, \[liveState\]\)/, "a resolved attempt must not silently rotate its request key");
assert.match(composer, /liveState\.liveDisposition === "new_allowed"[\s\S]*startNewBroadcast/, "only a definitely completed attempt may expose an explicit new-broadcast flow");
assert.match(composer, /setConfirmation\(""\)/, "confirmation text must be cleared after an attempt");
assert.match(composer, /name="requestKey" value=\{liveRequestKey\}/, "the live form must submit the current request key");

const packageJson = readFileSync(join(root, "package.json"), "utf8");
assert.match(packageJson, /src\/lib\/line-live-broadcast\.test\.ts/, "npm test must include live-broadcast hardening checks");

console.log("LINE live broadcast hardening self-check passed");
