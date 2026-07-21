// Reproducible disposable-PostgreSQL integration run, owned by this repo (no
// uncommitted scratchpad dependency). Run: npm run test:pg:embedded
//
// What it does:
//   1. Starts an embedded-postgres cluster bound to 127.0.0.1 only, in a
//      throwaway data dir under the OS temp folder.
//   2. Refuses to proceed unless the target database name is clearly a
//      disposable test database (same naming convention the integration
//      test files themselves enforce independently — this is defense in
//      depth, not the only check).
//   3. Applies migrations 0001-0009 verbatim.
//   4. Seeds the exact legacy baseline 0010's own DO-block assertions
//      require (384 legacy hourly open slots across 32 dates, zero
//      canonical session rows, zero referencing bookings) and verifies it
//      before proceeding.
//   5. Applies 0010, 0011, 0012, 0013.
//   6. Runs `npm run test:pg` as a child process with PG_INTEGRATION_URL set
//      ONLY on that child's environment — never exported to this process or
//      any other command.
//   7. Always tears down: stops the cluster and removes the temp dir, even on
//      failure.
import EmbeddedPostgres from "embedded-postgres";
import { readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { stopWithTimeout, forceTerminateCluster, removeDirWithRetry } from "./pg-cleanup.ts";

const STOP_TIMEOUT_MS = 10_000;
const STOP_SETTLE_TIMEOUT_MS = 10_000;
const DIR_REMOVE_ATTEMPTS = 60;
const DIR_REMOVE_DELAY_MS = 500;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");
const SUPABASE_DIR = join(REPO_ROOT, "supabase");
const DB_NAME = "mohjaew_test";
const PORT = 55433;

// Defense in depth: this constant is hardcoded above, but if it is ever
// parameterized, refuse anything that isn't unambiguously a disposable test
// database — the same convention the integration test files enforce
// independently against whatever live database they actually connect to.
const DISPOSABLE_TEST_DB_RE = /(^|[_-])(test|ci)([_-]|$)/i;
if (!DISPOSABLE_TEST_DB_RE.test(DB_NAME)) {
  console.error(`[test-pg-embedded] refusing: "${DB_NAME}" is not clearly named as a disposable test database`);
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), "mohjaew-pg-test-"));
console.log(`[test-pg-embedded] data dir: ${dataDir}`);
console.log(`[test-pg-embedded] port: ${PORT}, db: ${DB_NAME}, bind: 127.0.0.1`);

const pgServer = new EmbeddedPostgres({
  databaseDir: dataDir,
  port: PORT,
  user: "postgres",
  password: "postgres",
  persistent: true, // this script owns independent data-dir removal below
  // The host OS locale can be something Postgres cannot use for a UTF8
  // database (e.g. Thai_Thailand.1252 on a Thai-locale Windows machine,
  // which cannot represent the "→" characters used in some migration
  // comments). Force a UTF8-safe encoding/locale regardless of host locale.
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
});

let exitCode = 0;
let started = false;
let stopAttempt: Promise<void> | null = null;

try {
  console.log("[test-pg-embedded] initialising cluster...");
  await pgServer.initialise();
  console.log("[test-pg-embedded] starting cluster...");
  await pgServer.start();
  started = true;
  console.log(`[test-pg-embedded] creating database ${DB_NAME}...`);
  await pgServer.createDatabase(DB_NAME);

  const client = pgServer.getPgClient(DB_NAME, "127.0.0.1");
  await client.connect();

  console.log("[test-pg-embedded] creating Supabase-convention roles (anon/authenticated/service_role)...");
  await client.query(`
    do $$
    begin
      if not exists (select from pg_roles where rolname = 'anon') then
        create role anon nologin;
      end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
      end if;
      if not exists (select from pg_roles where rolname = 'service_role') then
        create role service_role nologin bypassrls;
      end if;
    end $$;
  `);

  console.log("[test-pg-embedded] stubbing storage.buckets (0001 inserts into it)...");
  await client.query(`
    create schema if not exists storage;
    create table if not exists storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false
    );
  `);

  const baseMigrations = [
    "0001_init.sql",
    "0002_booking_slots.sql",
    "0003_face_upload.sql",
    "0004_face_upload_cleanup_lease.sql",
    "0005_payment_foundation.sql",
    "0006_read_only_get_open_slots.sql",
    "0007_team_notification_outbox.sql",
    "0008_reject_expired_hold_confirmation.sql",
    "0009_queue_session_cutover.sql",
  ];
  for (const name of baseMigrations) {
    console.log(`[test-pg-embedded] applying ${name}...`);
    await client.query(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
  // Supabase grants service_role table access as part of its platform
  // baseline. Plain embedded PostgreSQL has no such defaults, so reproduce
  // that baseline explicitly before running the Production ACL preflights.
  console.log("[test-pg-embedded] applying Supabase service_role table-access baseline...");
  await client.query("grant select, insert, update, delete on all tables in schema public to service_role");

  console.log("[test-pg-embedded] seeding verified legacy baseline for 0010 (384 slots / 32 dates)...");
  await client.query(`
    insert into public.booking_slots (booking_date, start_time, end_time, label, capacity, is_open)
    select d::date,
           ('09:00'::time + (h || ' hours')::interval)::time as start_time,
           ('09:00'::time + (h || ' hours')::interval + interval '1 hour')::time as end_time,
           'legacy hourly ' || h,
           3,
           true
      from generate_series('2026-07-12'::date, '2026-08-12'::date, interval '1 day') d
     cross join generate_series(0, 11) h
  `);
  const seedCheck = await client.query(`
    select
      count(*)::int as total,
      count(*) filter (where is_open)::int as open,
      count(distinct booking_date)::int as dates
    from public.booking_slots
    where booking_date >= '2026-07-12'
      and not (
            (start_time = '09:00'::time and end_time = '12:00'::time)
         or (start_time = '13:00'::time and end_time = '16:00'::time)
         or (start_time = '18:00'::time and end_time = '21:00'::time)
         or (start_time = '22:00'::time and end_time = '23:00'::time)
          )
      and (end_time - start_time) = interval '1 hour'
      and start_time >= '09:00'::time
      and end_time <= '21:00'::time
  `);
  const seed = seedCheck.rows[0];
  console.log(`[test-pg-embedded] seed check: total=${seed.total} open=${seed.open} dates=${seed.dates}`);
  if (seed.total !== 384 || seed.open !== 384 || seed.dates !== 32) {
    throw new Error(`legacy baseline seed mismatch: expected total=384 open=384 dates=32, got ${JSON.stringify(seed)}`);
  }
  const canonicalCheck = await client.query(`
    select count(*)::int as n from public.booking_slots
     where booking_date >= '2026-07-12'
       and (
             (start_time = '09:00'::time and end_time = '12:00'::time)
          or (start_time = '13:00'::time and end_time = '16:00'::time)
          or (start_time = '18:00'::time and end_time = '21:00'::time)
          or (start_time = '22:00'::time and end_time = '23:00'::time)
           )
  `);
  if (canonicalCheck.rows[0].n !== 0) {
    throw new Error(`expected zero canonical session rows before 0010, found ${canonicalCheck.rows[0].n}`);
  }
  const bookingCheck = await client.query("select count(*)::int as n from public.bookings");
  if (bookingCheck.rows[0].n !== 0) {
    throw new Error(`expected zero bookings before 0010, found ${bookingCheck.rows[0].n}`);
  }
  console.log("[test-pg-embedded] baseline verified: 384 legacy open slots, 32 dates, 0 canonical rows, 0 bookings.");

  const applyMigration = async (name: string) => {
    console.log(`[test-pg-embedded] applying ${name}...`);
    await client.query(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  };
  const runPassFailVerifier = async (name: string) => {
    console.log(`[test-pg-embedded] running ${name}...`);
    const result = await client.query(readFileSync(join(SUPABASE_DIR, name), "utf8"));
    const failed = result.rows.filter((row) => row.status !== "PASS");
    if (failed.length > 0) {
      throw new Error(`${name} reported failures: ${JSON.stringify(failed)}`);
    }
    console.log(`[test-pg-embedded] ${name}: ${result.rows.length} PASS rows`);
  };

  await applyMigration("0010_reconcile_0006_0009.sql");
  const reconciliationReport = await client.query(
    readFileSync(join(SUPABASE_DIR, "verify_0010_reconciliation.sql"), "utf8"),
  );
  if (reconciliationReport.rows.length !== 4) {
    throw new Error(`verify_0010_reconciliation.sql returned ${reconciliationReport.rows.length} sections, expected 4`);
  }
  console.log("[test-pg-embedded] verify_0010_reconciliation.sql: 4 read-only report sections");
  await runPassFailVerifier("verify_0011_production_preflight.sql");

  await applyMigration("0011_slip_verification.sql");
  await runPassFailVerifier("verify_0011_post_migration.sql");
  await runPassFailVerifier("verify_0012_production_preflight.sql");

  await applyMigration("0012_booking_confirmed_notification.sql");
  await runPassFailVerifier("verify_0012_post_migration.sql");

  await runPassFailVerifier("verify_0013_production_preflight.sql");
  await applyMigration("0013_payment_slip_notification_image.sql");
  await runPassFailVerifier("verify_0013_post_migration.sql");
  console.log("[test-pg-embedded] all migrations 0001-0013 applied successfully.");

  await client.end();

  const connString = `postgres://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;
  console.log("[test-pg-embedded] running `npm run test:pg` with PG_INTEGRATION_URL scoped to this command only...");
  const result = spawnSync("npm", ["run", "test:pg"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, PG_INTEGRATION_URL: connString },
  });
  exitCode = result.status ?? 1;
  if (result.error) {
    console.error("[test-pg-embedded] failed to spawn npm run test:pg:", result.error);
    exitCode = 1;
  }
} catch (err) {
  console.error("[test-pg-embedded] failed:", err);
  exitCode = 1;
}

// Cleanup runs independently of the try/catch above: a hung or throwing
// graceful stop() must never prevent the data dir from being removed.
let cleanupOk = true;
let shutdownOk = true;

if (started) {
  console.log(`[test-pg-embedded] stopping cluster (timeout ${STOP_TIMEOUT_MS}ms)...`);
  const stopResult = await stopWithTimeout(() => {
    const attempt = pgServer.stop();
    stopAttempt = attempt;
    return attempt;
  }, STOP_TIMEOUT_MS);
  if (stopResult.outcome === "graceful") {
    console.log("[test-pg-embedded] cleanup evidence: graceful stop succeeded");
  } else {
    shutdownOk = false;
    if (stopResult.outcome === "timeout") {
      console.error(`[test-pg-embedded] stop() timed out after ${STOP_TIMEOUT_MS}ms`);
    } else {
      console.error("[test-pg-embedded] stop() threw:", stopResult.error);
    }
    const forced = await forceTerminateCluster(dataDir);
    if (forced.attempted && forced.terminated) {
      shutdownOk = true;
      console.log(`[test-pg-embedded] cleanup evidence: forced shutdown used (pid=${forced.pid})`);
    } else if (forced.attempted) {
      console.error(`[test-pg-embedded] cleanup evidence: forced shutdown failed (pid=${forced.pid})`);
    } else {
      console.error("[test-pg-embedded] cleanup evidence: forced shutdown skipped (no postmaster.pid found)");
    }

    // A timed-out stop() is still running underneath the race. After the
    // cluster process is forcibly terminated, give that original stop call a
    // bounded chance to observe the exit and finish its own file cleanup.
    if (stopAttempt) {
      const settleResult = await stopWithTimeout(() => stopAttempt!, STOP_SETTLE_TIMEOUT_MS);
      if (settleResult.outcome === "timeout") {
        console.error(`[test-pg-embedded] timed-out stop() did not settle within ${STOP_SETTLE_TIMEOUT_MS}ms after force termination`);
      }
    }
  }
}

// Independent finally path: always attempt directory removal, regardless of
// what happened above, with retries for Windows file-lock release.
let lastRemovalError: unknown;
const dirRemoved = await removeDirWithRetry(
  dataDir,
  DIR_REMOVE_ATTEMPTS,
  DIR_REMOVE_DELAY_MS,
  undefined,
  undefined,
  undefined,
  (error) => {
    lastRemovalError = error;
  },
);
if (dirRemoved) {
  console.log(`[test-pg-embedded] cleanup evidence: data directory removed (${dataDir})`);
} else {
  console.error(`[test-pg-embedded] cleanup evidence: data directory still present after retries (${dataDir})`);
  if (lastRemovalError) {
    console.error("[test-pg-embedded] last data-directory removal error:", lastRemovalError);
  }
  cleanupOk = false;
}

if (!shutdownOk) {
  cleanupOk = false;
}

if (exitCode === 0 && !cleanupOk) {
  exitCode = 1;
}

console.log(`[test-pg-embedded] exiting with code ${exitCode}`);
process.exit(exitCode);
