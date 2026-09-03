import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateLineUatPairingCode, hashLineUatPairingCode, LINE_UAT_PAIRING_TTL_MS, parseLineUatPairingMessage, resolveLineUatTarget } from "./line-uat-pairing.ts";

assert.equal(LINE_UAT_PAIRING_TTL_MS, 10 * 60 * 1000);
const code = generateLineUatPairingCode();
assert.match(code, /^MJ-UAT-[A-Z0-9]{8}$/);
assert.equal(hashLineUatPairingCode("MJ-UAT-ABCD1234"), hashLineUatPairingCode("MJ-UAT-ABCD1234"));
assert.match(hashLineUatPairingCode("MJ-UAT-ABCD1234"), /^[0-9a-f]{64}$/);
assert.notEqual(hashLineUatPairingCode("MJ-UAT-ABCD1234"), hashLineUatPairingCode("MJ-UAT-ABCD1235"));

assert.equal(parseLineUatPairingMessage("MJ-UAT-ABCD1234"), "MJ-UAT-ABCD1234");
for (const malformed of [null, "", "MJ-UAT-abcd1234", " MJ-UAT-ABCD1234", "MJ-UAT-ABCD1234\n", "MJ-UAT-ABC123", "MJ-UAT-ABCDEFGHI", "hello MJ-UAT-ABCD1234"]) {
  assert.equal(parseLineUatPairingMessage(malformed), null);
}

const envTarget = `U${"a".repeat(32)}`;
const dbTarget = `U${"b".repeat(32)}`;
let dbLoads = 0;
assert.equal(await resolveLineUatTarget(envTarget, async () => { dbLoads += 1; return dbTarget; }), envTarget);
assert.equal(dbLoads, 0);
assert.equal(await resolveLineUatTarget(undefined, async () => dbTarget), dbTarget);
assert.equal(await resolveLineUatTarget("invalid", async () => dbTarget), dbTarget);
assert.equal(await resolveLineUatTarget(undefined, async () => "U-invalid"), null);

const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "migrations", "0016_line_uat_pairings.sql"), "utf8");
assert.match(migration, /create table if not exists public\.line_uat_pairings/);
assert.match(migration, /code_hash text unique not null/);
assert.doesNotMatch(migration, /\bcode\s+text/i);
assert.match(migration, /code_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
assert.match(migration, /expires_at > created_at/);
assert.match(migration, /enable row level security/);
assert.match(migration, /revoke all on table public\.line_uat_pairings from public, anon, authenticated/);
assert.match(migration, /grant all on table public\.line_uat_pairings to service_role/);

console.log("LINE UAT pairing self-check passed");
