// Self-check for the team-notification outbox worker support (Phase 1A / 0007).
// Run: node --experimental-strip-types src/lib/notifications/notification-outbox.test.ts
//
// DB-level behaviours (locks, RPC transitions, fencing) cannot be verified
// without a live Supabase instance. Those are marked [SQL] below and verified
// by inspecting the migration SQL directly, same convention as payments.test.ts.

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function readMigration(name: string) {
  return readFileSync(join(repoRoot, "supabase/migrations", name), "utf8");
}

const migration = readMigration("0007_team_notification_outbox.sql");

// ===========================================================================
// Migration: status domain includes distinct 'processing' and 'dead'
// ===========================================================================
assert.match(
  migration,
  /drop constraint if exists notification_deliveries_status_check/,
  "must drop and recreate the status check safely",
);
assert.match(
  migration,
  /add constraint notification_deliveries_status_check\s*\n\s*check \(status in \('pending', 'processing', 'sent', 'failed', 'skipped', 'dead'\)\)/,
  "status domain must be exactly pending, processing, sent, failed, skipped, dead",
);

// ===========================================================================
// Migration: durable lease columns are locked_by / locked_at
// ===========================================================================
assert.match(
  migration,
  /alter table public\.notification_deliveries\s+add column if not exists locked_by text/,
  "locked_by column must be added additively",
);
assert.match(
  migration,
  /alter table public\.notification_deliveries\s+add column if not exists locked_at timestamptz/,
  "locked_at column must be added additively",
);
assert.doesNotMatch(
  migration,
  /claim_token|claim_lease_until/,
  "must not use the rejected claim_token/claim_lease_until substitute fields",
);

// ===========================================================================
// Migration: 10-minute stale lease window
// ===========================================================================
assert.match(
  migration,
  /d\.status = 'processing' and d\.locked_at < now\(\) - interval '10 minutes'/,
  "stale lease reclaim window must be exactly 10 minutes",
);
assert.doesNotMatch(migration, /interval '2 minutes'/, "must not use the old 2-minute lease window");

// ===========================================================================
// Migration: claim_team_notification_deliveries RPC — exact signature
// ===========================================================================
assert.match(
  migration,
  /create or replace function public\.claim_team_notification_deliveries\(\s*\n\s*p_worker_id\s+text,\s*\n\s*p_batch\s+int,\s*\n\s*p_event_types\s+text\[\]\s*\n\)/,
  "claim RPC signature must be exactly (p_worker_id text, p_batch int, p_event_types text[])",
);

const claimFnBody = migration.slice(
  migration.indexOf("create or replace function public.claim_team_notification_deliveries"),
  migration.indexOf("revoke all on function public.claim_team_notification_deliveries"),
);

// [SQL] Recipient type is hardcoded to 'team', not parameterized.
assert.match(claimFnBody, /d\.recipient_type = 'team'/, "claim function must hardcode recipient_type = 'team'");
// [SQL] SKIP LOCKED prevents concurrent workers from claiming the same row.
assert.match(claimFnBody, /for update skip locked/, "claim function must use FOR UPDATE SKIP LOCKED");

// [SQL] Claim only sets the lease fields — no attempt_count increment.
assert.match(
  claimFnBody,
  /set status\s*=\s*'processing',\s*\n\s*locked_by\s*=\s*p_worker_id,\s*\n\s*locked_at\s*=\s*now\(\)/,
  "claim function must set status = 'processing' and stamp locked_by/locked_at",
);
assert.doesNotMatch(
  claimFnBody,
  /attempt_count\s*=/,
  "claim function must NOT write attempt_count — that is owned entirely by complete_notification_delivery",
);

// [SQL] Validation guards.
assert.match(
  claimFnBody,
  /if p_worker_id is null or btrim\(p_worker_id\) = '' then\s*\n\s*raise exception 'invalid_worker_id'/,
  "claim function must reject null/blank/whitespace p_worker_id",
);
assert.match(
  claimFnBody,
  /if p_batch is null or p_batch < 1 then\s*\n\s*raise exception 'invalid_batch'/,
  "claim function must reject null or <1 p_batch",
);
assert.match(
  claimFnBody,
  /v_batch\s*:=\s*least\(p_batch, 100\)/,
  "claim function must clamp p_batch to a maximum of 100",
);
assert.match(
  claimFnBody,
  /if p_event_types is null or cardinality\(p_event_types\) = 0 then\s*\n\s*raise exception 'invalid_event_types'/,
  "claim function must reject null or empty p_event_types",
);
assert.doesNotMatch(
  claimFnBody,
  /p_event_types is null or d\.event_type/,
  "claim function must NOT support a 'null means all event types' mode",
);
assert.match(
  claimFnBody,
  /and d\.event_type = any \(p_event_types\)/,
  "claim function must always filter by p_event_types",
);

// ===========================================================================
// Migration: complete_notification_delivery RPC — exact signature, boolean return
// ===========================================================================
assert.match(
  migration,
  /create or replace function public\.complete_notification_delivery\(\s*\n\s*p_id\s+uuid,\s*\n\s*p_worker_id\s+text,\s*\n\s*p_outcome\s+text,\s*\n\s*p_error\s+text default null\s*\n\)\s*\nreturns boolean/,
  "completion RPC signature must be exactly (p_id uuid, p_worker_id text, p_outcome text, p_error text default null) returns boolean",
);

const completeFnBody = migration.slice(
  migration.indexOf("create or replace function public.complete_notification_delivery"),
  migration.indexOf("revoke all on function public.complete_notification_delivery"),
);

// [SQL] Validation guards.
assert.match(
  completeFnBody,
  /if p_worker_id is null or btrim\(p_worker_id\) = '' then\s*\n\s*raise exception 'invalid_worker_id'/,
  "completion RPC must reject null/blank/whitespace p_worker_id",
);
assert.match(
  completeFnBody,
  /if p_outcome not in \('sent', 'retry', 'dead'\) then\s*\n\s*raise exception 'invalid_outcome'/,
  "must reject outcomes outside sent/retry/dead",
);

// [SQL] No-match fencing returns false, not null/exception.
assert.match(completeFnBody, /if not found then\s*\n\s*return false;/, "no fenced match must return false");

// [SQL] Every mutating statement must fence on all three: status = 'processing',
// locked_by = p_worker_id, recipient_type = 'team'.
const statusProcessingFenceCount = (completeFnBody.match(/status = 'processing'/g) ?? []).length;
assert.ok(
  statusProcessingFenceCount >= 5,
  `complete_notification_delivery must fence every select/update with status = 'processing' (found ${statusProcessingFenceCount})`,
);
const lockedByFenceCount = (completeFnBody.match(/locked_by = p_worker_id/g) ?? []).length;
assert.ok(
  lockedByFenceCount >= 5,
  `complete_notification_delivery must fence every select/update with locked_by = p_worker_id (found ${lockedByFenceCount})`,
);
const teamFenceCount = (completeFnBody.match(/recipient_type = 'team'/g) ?? []).length;
assert.ok(
  teamFenceCount >= 5,
  `complete_notification_delivery must fence every select/update with recipient_type = 'team' (found ${teamFenceCount})`,
);

// [SQL] 'sent' outcome clears next_retry_at, locked_by, and locked_at; returns true.
const sentBranch = completeFnBody.slice(
  completeFnBody.indexOf("if p_outcome = 'sent' then"),
  completeFnBody.indexOf("if p_outcome = 'dead' then"),
);
assert.match(sentBranch, /status\s*=\s*'sent'/, "'sent' outcome must set status = 'sent'");
assert.match(sentBranch, /sent_at\s*=\s*now\(\)/, "'sent' outcome must set sent_at");
assert.match(sentBranch, /next_retry_at\s*=\s*null/, "'sent' outcome must clear next_retry_at");
assert.match(sentBranch, /locked_by\s*=\s*null/, "'sent' outcome must clear locked_by");
assert.match(sentBranch, /locked_at\s*=\s*null/, "'sent' outcome must clear locked_at");
assert.match(sentBranch, /return true;/, "'sent' outcome must return true");
assert.doesNotMatch(sentBranch, /attempt_count\s*=/, "'sent' outcome must not touch attempt_count");

// [SQL] Explicit 'dead' outcome (not via retry exhaustion) also does not touch attempt_count.
const explicitDeadBranch = completeFnBody.slice(
  completeFnBody.indexOf("if p_outcome = 'dead' then"),
  completeFnBody.indexOf("-- p_outcome = 'retry': calculate the retry count exactly once."),
);
assert.match(explicitDeadBranch, /status\s*=\s*'dead'/, "explicit dead outcome must set status = 'dead'");
assert.match(explicitDeadBranch, /next_retry_at\s*=\s*null/, "explicit dead outcome must clear next_retry_at");
assert.match(explicitDeadBranch, /return true;/, "explicit dead outcome must return true");
assert.doesNotMatch(explicitDeadBranch, /attempt_count\s*=/, "explicit dead outcome must not touch attempt_count");
assert.doesNotMatch(explicitDeadBranch, /status\s*=\s*'skipped'/, "dead branch must not reuse 'skipped'");

// ===========================================================================
// Migration: retry count computed exactly once, fixed backoff w/ ±20% jitter
// ===========================================================================
assert.match(
  migration,
  /v_attempt\s*:=\s*v_row\.attempt_count \+ 1;/,
  "retry count must be calculated exactly once as v_row.attempt_count + 1",
);
// Only one assignment site for v_attempt in the whole function.
const vAttemptAssignments = (completeFnBody.match(/v_attempt\s*:=/g) ?? []).length;
assert.equal(vAttemptAssignments, 1, "v_attempt must be assigned exactly once");

const retrySection = completeFnBody.slice(completeFnBody.indexOf("v_attempt := v_row.attempt_count + 1;"));

// [SQL] attempt >= 6 branch: write attempt_count, status = 'dead', next_retry_at = null.
const exhaustedBranch = retrySection.slice(
  retrySection.indexOf("if v_attempt >= 6 then"),
  retrySection.indexOf("v_base_minutes := case v_attempt"),
);
assert.match(exhaustedBranch, /attempt_count\s*=\s*v_attempt/, "attempt >= 6 must write attempt_count = v_attempt");
assert.match(exhaustedBranch, /status\s*=\s*'dead'/, "attempt >= 6 must set status = 'dead'");
assert.match(exhaustedBranch, /next_retry_at\s*=\s*null/, "attempt >= 6 must clear next_retry_at");
assert.match(exhaustedBranch, /locked_by\s*=\s*null/, "attempt >= 6 must clear locked_by");
assert.match(exhaustedBranch, /locked_at\s*=\s*null/, "attempt >= 6 must clear locked_at");

// [SQL] attempts 1-5 branch: write attempt_count, status = 'failed', jittered backoff.
const backoffBranch = retrySection.slice(retrySection.indexOf("v_base_minutes := case v_attempt"));
assert.match(
  backoffBranch,
  /when 1 then 1\s*\n\s*when 2 then 5\s*\n\s*when 3 then 15\s*\n\s*when 4 then 60\s*\n\s*when 5 then 360/,
  "backoff table must be exactly 1/5/15/60/360 minutes for attempts 1-5",
);
assert.match(backoffBranch, /attempt_count\s*=\s*v_attempt/, "attempts 1-5 must write attempt_count = v_attempt");
assert.match(backoffBranch, /status\s*=\s*'failed'/, "attempts 1-5 must set status = 'failed'");
assert.match(
  backoffBranch,
  /make_interval\(mins => v_base_minutes\) \* \(0\.8 \+ random\(\) \* 0\.4\)/,
  "retry backoff must apply ±20% jitter (0.8 to 1.2 multiplier)",
);

// ===========================================================================
// Migration: SECURITY DEFINER with pinned search_path
// ===========================================================================
assert.match(
  migration,
  /create or replace function public\.claim_team_notification_deliveries\([\s\S]*?\)\s*\nreturns table[\s\S]*?language plpgsql\s*\nsecurity definer\s*\nset search_path = public, pg_temp/,
  "claim RPC must be SECURITY DEFINER with search_path pinned to public, pg_temp",
);
assert.match(
  migration,
  /create or replace function public\.complete_notification_delivery\([\s\S]*?\)\s*\nreturns boolean\s*\nlanguage plpgsql\s*\nsecurity definer\s*\nset search_path = public, pg_temp/,
  "completion RPC must be SECURITY DEFINER with search_path pinned to public, pg_temp",
);
// Every SQL statement touching the table must schema-qualify it (comments are
// prose and are not checked; constraint/index names like
// notification_deliveries_status_check are excluded by requiring a following
// word boundary, which an underscore-joined suffix does not have).
assert.doesNotMatch(
  migration,
  /\b(?:from|update|into|table)\s+notification_deliveries\b/i,
  "table references in SQL statements must remain schema-qualified as public.notification_deliveries",
);

// ===========================================================================
// Migration: grants restricted to service_role
// ===========================================================================
assert.match(
  migration,
  /revoke all on function public\.claim_team_notification_deliveries\(text, int, text\[\]\)\s*\n\s*from public, anon, authenticated/,
  "claim RPC must revoke execute from public/anon/authenticated",
);
assert.match(
  migration,
  /grant execute on function public\.claim_team_notification_deliveries\(text, int, text\[\]\)\s*\n\s*to service_role/,
  "claim RPC must grant execute to service_role",
);
assert.match(
  migration,
  /revoke all on function public\.complete_notification_delivery\(uuid, text, text, text\)\s*\n\s*from public, anon, authenticated/,
  "completion RPC must revoke execute from public/anon/authenticated",
);
assert.match(
  migration,
  /grant execute on function public\.complete_notification_delivery\(uuid, text, text, text\)\s*\n\s*to service_role/,
  "completion RPC must grant execute to service_role",
);

// ===========================================================================
// Migration: no destructive verification queries or sample data
// ===========================================================================
assert.doesNotMatch(migration, /\binsert into public\.notification_deliveries\b/i, "migration must not insert sample data");
assert.doesNotMatch(migration, /\bdelete from\b/i, "migration must not contain destructive DELETE statements");
assert.doesNotMatch(migration, /\btruncate\b/i, "migration must not contain TRUNCATE statements");

// ===========================================================================
// Migration: rollback block is non-destructive
// ===========================================================================
const rollbackBlock = migration.slice(migration.indexOf("-- ROLLBACK"));
assert.match(
  rollbackBlock,
  /drop function if exists public\.complete_notification_delivery\(uuid, text, text, text\)/,
  "rollback must drop the completion RPC",
);
assert.match(
  rollbackBlock,
  /drop function if exists public\.claim_team_notification_deliveries\(text, int, text\[\]\)/,
  "rollback must drop the claim RPC",
);
assert.match(
  rollbackBlock,
  /drop index if exists notification_deliveries_locked_idx/,
  "rollback must drop the lease index",
);
assert.doesNotMatch(
  rollbackBlock,
  /drop column/i,
  "rollback must NEVER drop added columns (locked_by/locked_at are permanent)",
);
assert.doesNotMatch(
  rollbackBlock,
  /notification_deliveries_status_check/,
  "rollback must NEVER revert the status constraint once processing/dead may be in use",
);

console.log("notification outbox self-check passed");
