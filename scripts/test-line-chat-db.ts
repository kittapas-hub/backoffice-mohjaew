// Disposable local PostgreSQL only. No .env files and no external connection strings.
import assert from "node:assert/strict";
import EmbeddedPostgres from "embedded-postgres";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stopWithTimeout, forceTerminateCluster, removeDirWithRetry } from "./pg-cleanup.ts";
const dir = mkdtempSync(join(tmpdir(), "mohjaew-chat-test-"));
const pg = new EmbeddedPostgres({ databaseDir: dir, port: 55435, user: "postgres", password: "postgres",
  persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-c", "listen_addresses=127.0.0.1"] });
let started = false;
try {
  await pg.initialise(); await pg.start(); started = true; await pg.createDatabase("mohjaew_chat_test");
  const db = pg.getPgClient("mohjaew_chat_test", "127.0.0.1"); await db.connect();
  const db2 = pg.getPgClient("mohjaew_chat_test", "127.0.0.1"); await db2.connect();
  try {
    await db.query("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls");
    await db.query(readFileSync("supabase/migrations/20261005043116_mohjaew_line_chat.sql", "utf8"));
    const funcs = await db.query("select proname,prosecdef from pg_proc where proname like 'line_chat_%'");
    assert.ok(funcs.rows.every(r => !r.prosecdef), "RPCs must use invoker security");
    const acl = await db.query("select has_table_privilege('anon','public.line_chat_jobs','select') as anon, has_function_privilege('authenticated','public.line_chat_claim(uuid,text)','execute') as auth");
    assert.equal(acl.rows[0].anon, false); assert.equal(acl.rows[0].auth, false);
    const rls = await db.query("select relrowsecurity from pg_class where relname in ('line_chat_jobs','line_chat_conversations')");
    assert.ok(rls.rows.every(r => r.relrowsecurity));
    await db.query("set role service_role"); await db2.query("set role service_role");
    const user = "U" + "a".repeat(32);
    const enqueue = async (event: string, scope = "preview", u = user, timestamp = Date.now()) => (await db.query(
      "select line_chat_enqueue($1,$2,$3,$4,$5,$6) id", [scope, u, event, "question " + event, "token", timestamp])).rows[0].id as string | null;
    const claim = async (id: string, scope = "preview") => (await db.query("select line_chat_claim($1,$2) job", [id,scope])).rows[0].job;
    const finish = async (id: string, lease: string, reply = "answer", failed = false) => (await db.query(
      "select line_chat_complete($1,'preview',$2,$3,$4) ok", [id,lease,reply,failed])).rows[0].ok;
    const first = (await enqueue("one"))!; const second = (await enqueue("two"))!;
    assert.equal(await enqueue("one"), null, "duplicate events do not create a second job");
    assert.equal(await claim(first, "production"), null, "scope isolation");
    const [a,b] = await Promise.all([
      db.query("select line_chat_claim($1,'preview') job", [first]),
      db2.query("select line_chat_claim($1,'preview') job", [first]),
    ]);
    const jobs = [a.rows[0].job, b.rows[0].job].filter(Boolean);
    assert.equal(jobs.length, 1, "concurrent executions have one owner");
    const job = jobs[0];
    assert.equal(await claim(second), null, "same-user messages stay ordered");
    assert.equal(await finish(first, "00000000-0000-4000-8000-000000000001"), false);
    assert.equal(await finish(first, job.lease_token), true);
    const reserved = (await db.query("select line_chat_reserve_delivery($1,'preview') job", [first])).rows[0].job;
    assert.equal(reserved.transport, "reply");
    assert.equal((await db.query("select line_chat_reserve_delivery($1,'preview') job", [first])).rows[0].job, null);
    await db.query("select line_chat_delivery_receipt($1,'preview',$2,'sent')", [first,reserved.lease_token]);
    assert.equal((await db.query("select line_chat_delivery_receipt($1,'preview',$2,'sent') ok", [first,reserved.lease_token])).rows[0].ok, false);
    const next = await claim(second); assert.ok(next);
    await db.query("select line_chat_set_mode($1,'preview','human')", [job.conversation_id]);
    assert.equal(await finish(second, next.lease_token), false, "pause discards late AI replies");
    const paused = (await enqueue("while-human"))!;
    assert.equal((await db.query("select status from line_chat_jobs where id=$1", [paused])).rows[0].status, "cancelled");
    await db.query("select line_chat_set_mode($1,'preview','bot')", [job.conversation_id]);
    assert.equal(await claim(second), null, "resume never revives old messages");
    const prod = (await enqueue("production-message", "production"))!;
    assert.equal(await claim(prod), null);
    const retryUser = "U" + "b".repeat(32);
    const retry = (await enqueue("retry", "preview", retryUser, Date.now() - 60000))!;
    for (let i=0;i<3;i++) {
      const j = await claim(retry); assert.ok(j);
      await finish(retry, j.lease_token, "ignored", true);
      await db.query("update line_chat_jobs set next_attempt_at=now() where id=$1", [retry]);
    }
    assert.equal((await db.query("select status from line_chat_jobs where id=$1", [retry])).rows[0].status, "ready");
    const push = (await db.query("select line_chat_reserve_delivery($1,'preview') job", [retry])).rows[0].job;
    assert.equal(push.transport, "push");
    await db.query("select line_chat_delivery_receipt($1,'preview',$2,'retry')", [retry,push.lease_token]);
    await db.query("update line_chat_jobs set next_attempt_at=now() where id=$1", [retry]);
    const push2 = (await db.query("select line_chat_reserve_delivery($1,'preview') job", [retry])).rows[0].job;
    assert.equal(push2.retry_key, push.retry_key, "push retries use one persistent LINE retry key");
    await db.query("update line_chat_jobs set lease_until=now()-interval '1 second' where id=$1", [retry]);
    await db.query("select line_chat_recover('preview')");
    assert.equal((await db.query("select status from line_chat_jobs where id=$1", [retry])).rows[0].status, "ready");
    const timeout = (await enqueue("timeout", "preview", "U" + "c".repeat(32)))!;
    const oldLease = await claim(timeout);
    await db.query("update line_chat_jobs set lease_until=now()-interval '1 second' where id=$1", [timeout]);
    await db.query("select line_chat_recover('preview')");
    assert.equal(await finish(timeout, oldLease.lease_token), false, "expired generation lease cannot send a reply");
    const newLease = await claim(timeout);
    assert.notEqual(newLease.lease_token, oldLease.lease_token);
    await finish(timeout, newLease.lease_token);
    const reply = (await db.query("select line_chat_reserve_delivery($1,'preview') job", [timeout])).rows[0].job;
    await db.query("update line_chat_jobs set lease_until=now()-interval '1 second' where id=$1", [timeout]);
    await db.query("select line_chat_recover('preview')");
    assert.equal((await db.query("select status from line_chat_jobs where id=$1", [timeout])).rows[0].status, "unknown", "ambiguous replies need manual review, not duplicate pushes");
    assert.ok(reply);
    const limitUser = "U" + "d".repeat(32);
    for (let i=0;i<20;i++) assert.ok(await enqueue("rate-" + i,"preview",limitUser));
    assert.equal(await enqueue("rate-21","preview",limitUser), null, "per-user burst is bounded");
    console.log("LINE chat PostgreSQL: isolation, RLS, ACL, dedup, ordering, races, pause, leases and recovery passed");
  } finally { await db2.end(); await db.end(); }
} finally {
  if (started) {
    const stopped = await stopWithTimeout(() => pg.stop(), 10000);
    if (stopped.outcome !== "graceful") {
      const forced = await forceTerminateCluster(dir);
      assert.ok(forced.terminated, "owned local PostgreSQL must stop");
    }
  }
  assert.ok(await removeDirWithRetry(dir, 40, 250), "temporary database directory cleanup");
}
