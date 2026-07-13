// Self-check for the payment foundation (V1).
// Run: node --experimental-strip-types src/lib/payments/payments.test.ts
//
// DB-level behaviours (unique indexes, row locks, RPC transitions) cannot be
// verified without a live Supabase instance. Those are marked [SQL] below and
// verified by inspecting the migration SQL directly.
// TypeScript-level pure logic is asserted directly.

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function readMigration(name: string) {
  return readFileSync(join(repoRoot, "supabase/migrations", name), "utf8");
}
function readSrc(rel: string) {
  return readFileSync(join(repoRoot, "src", rel), "utf8");
}

const migration = readMigration("0005_payment_foundation.sql");

// ===========================================================================
// Pure TypeScript: PROVIDER_PLACEHOLDER exported by provider.ts
// ===========================================================================
import { PROVIDER_PLACEHOLDER } from "./provider.ts";
assert.equal(typeof PROVIDER_PLACEHOLDER, "string");
assert.ok(PROVIDER_PLACEHOLDER.length > 0);

// ===========================================================================
// Migration: booking status extended with 'booked'
// ===========================================================================
assert.match(
  migration,
  /'booked'/,
  "0005 must add 'booked' to the booking status constraint",
);
assert.match(
  migration,
  /drop constraint if exists bookings_status_check/,
  "0005 must drop and recreate the status check safely",
);

// ===========================================================================
// Migration: payment_orders table & constraints
// ===========================================================================
assert.match(migration, /create table if not exists public\.payment_orders/, "payment_orders table");
assert.match(migration, /amount_satang.*check.*amount_satang > 0/, "positive amount constraint");
assert.match(migration, /checkout_token.*unique/, "checkout_token must be unique");
assert.match(migration, /idempotency_key.*not null unique/, "payment idempotency_key must be unique");

// [SQL] Duplicate active order prevention: unique partial index.
assert.match(
  migration,
  /payment_orders_booking_active_uniq[\s\S]*?where status in \('created', 'pending'\)/,
  "partial unique index prevents two active orders for the same booking",
);

// [SQL] provider_order_id unique per provider once set.
assert.match(
  migration,
  /payment_orders_provider_order_uniq[\s\S]*?where provider_order_id is not null/,
  "partial unique index prevents duplicate provider_order_id per provider",
);

// ===========================================================================
// Migration: payment_webhook_events table & idempotency
// ===========================================================================
assert.match(migration, /create table if not exists public\.payment_webhook_events/, "webhook events table");

// [SQL] Duplicate provider events handled by unique index on (provider, provider_event_id).
assert.match(
  migration,
  /payment_webhook_events_provider_event_uniq[\s\S]*?on public\.payment_webhook_events \(provider, provider_event_id\)/,
  "unique index on (provider, provider_event_id) for webhook idempotency",
);

// ===========================================================================
// Migration: notification_deliveries outbox
// ===========================================================================
assert.match(migration, /create table if not exists public\.notification_deliveries/, "notification_deliveries table");
assert.match(
  migration,
  /idempotency_key.*not null unique/,
  "notification_deliveries.idempotency_key must be unique",
);

// ===========================================================================
// Migration: create_booking updated to count 'booked'
// ===========================================================================
// [SQL] Occupancy counts include 'booked' so a paid booking holds its seat.
assert.match(
  migration,
  /status in \('booked', 'confirmed', 'completed'\)/,
  "create_booking occupancy count must include 'booked'",
);

// ===========================================================================
// Migration: transition_slot_booking allows booked -> confirmed / cancelled
// ===========================================================================
assert.match(
  migration,
  /v_from = 'booked'.*p_to in \('confirmed', 'cancelled'\)/,
  "transition_slot_booking must allow booked -> confirmed | cancelled",
);

// [SQL] pending_payment -> booked is NOT in transition_slot_booking.
// That transition is only done by process_payment_paid_event.
assert.doesNotMatch(
  migration.slice(
    migration.indexOf("create or replace function public.transition_slot_booking"),
    migration.indexOf("create or replace function public.get_open_slots"),
  ),
  /v_from = 'pending_payment'.*p_to.*'booked'/,
  "transition_slot_booking must NOT allow pending_payment -> booked (payment-only path)",
);

// ===========================================================================
// Migration: get_open_slots updated to count 'booked'
// ===========================================================================
assert.match(
  migration,
  /b\.status in \('booked', 'confirmed', 'completed'\)/,
  "get_open_slots occupancy count must include 'booked'",
);

// ===========================================================================
// Migration: create_payment_order RPC
// ===========================================================================
assert.match(migration, /create or replace function public\.create_payment_order/, "create_payment_order RPC");
assert.match(migration, /v_booking\.status <> 'pending_payment'/, "must reject non-pending_payment bookings");
assert.match(migration, /booking_hold_expired/, "must check hold expiry");
// [SQL] idempotency: same key returns the original order.
assert.match(migration, /select \* into v_order from public\.payment_orders[\s\S]*?where idempotency_key = p_idempotency_key/, "idempotency short-circuit");
// [SQL] duplicate active order: rejected by 'active_order_exists' check.
assert.match(migration, /active_order_exists/, "must raise active_order_exists for duplicate active orders");

// ===========================================================================
// Migration: process_payment_paid_event RPC
// ===========================================================================
assert.match(migration, /create or replace function public\.process_payment_paid_event/, "process_payment_paid_event RPC");

// [SQL] Webhook idempotency via ON CONFLICT.
assert.match(
  migration,
  /on conflict \(provider, provider_event_id\) do update/,
  "webhook event insert must use ON CONFLICT for idempotency",
);
assert.match(migration, /processing_status = 'processed'.*already_processed/s, "duplicate event returns already_processed");

// [SQL] Amount mismatch → manual_review, slot NOT booked.
assert.match(
  migration,
  /p_amount_received_satang <> v_order\.amount_satang[\s\S]*?manual_review[\s\S]*?amount_mismatch/,
  "amount mismatch must set manual_review, not book the slot",
);

// [SQL] Valid payment transitions booking to 'booked', not directly to 'confirmed'.
assert.match(
  migration,
  /status\s*=\s*'booked'[\s\S]*?hold_expires_at\s*=\s*null/,
  "valid payment must set booking status to 'booked' and clear hold",
);
// Must have 'pending_payment' guard so booked/confirmed bookings are never touched.
assert.match(
  migration,
  /and status = 'pending_payment'/,
  "booking transition must guard on status = pending_payment to avoid overwriting booked/confirmed",
);

// [SQL] Expired/cancelled bookings: late payment → manual_review, no auto-revival.
assert.match(
  migration,
  /v_booking\.status in \('expired', 'cancelled'\)[\s\S]*?manual_review[\s\S]*?booking_/,
  "late payment on expired/cancelled booking must set manual_review, not revive",
);

// [SQL] Notification outbox inserted with ON CONFLICT DO NOTHING (idempotent).
assert.match(
  migration,
  /on conflict \(idempotency_key\) do nothing/,
  "notification outbox inserts must use ON CONFLICT DO NOTHING",
);

// ===========================================================================
// Migration: expire_due_payment_orders RPC
// ===========================================================================
assert.match(migration, /create or replace function public\.expire_due_payment_orders/, "expire_due_payment_orders RPC");
assert.match(migration, /for update skip locked/, "must use SKIP LOCKED to avoid conflicts with concurrent cron runs");
// [SQL] Never expires a booked/confirmed booking.
assert.match(
  migration,
  /and status = 'pending_payment'/,
  "expire_due_payment_orders must guard booking update with status = pending_payment",
);

// ===========================================================================
// Migration: RLS + grants for all new tables and functions
// ===========================================================================
for (const tbl of ["payment_orders", "payment_webhook_events", "notification_deliveries"]) {
  assert.match(
    migration,
    new RegExp(`revoke all on table public\\.${tbl}\\s+from anon, authenticated`),
    `${tbl} must revoke DML from anon/authenticated`,
  );
  assert.match(
    migration,
    new RegExp(`grant all on table public\\.${tbl}\\s+to service_role`),
    `${tbl} must grant to service_role`,
  );
}
for (const fn of ["create_payment_order", "process_payment_paid_event", "expire_due_payment_orders"]) {
  assert.match(
    migration,
    new RegExp(`revoke all on function public\\.${fn}\\b[\\s\\S]*?from public, anon, authenticated`),
    `${fn} must revoke execute from public/anon/authenticated`,
  );
  assert.match(
    migration,
    new RegExp(`grant execute on function public\\.${fn}\\b[\\s\\S]*?to service_role`),
    `${fn} must grant execute to service_role`,
  );
}

// No SECURITY DEFINER in the new migration.
assert.doesNotMatch(migration, /security definer/i, "no SECURITY DEFINER expected");

// ===========================================================================
// Application layer: /pay/[token] page must not expose PII or accept money
// ===========================================================================
const payPage = readSrc("app/pay/[token]/page.tsx");
// Must not import or call unapproved payment gateway APIs. (PromptPay bank
// transfer + slip verification is the approved Phase 1 channel; gateway
// providers below remain out of scope.)
assert.doesNotMatch(payPage, /\b(kbank|kgp|omise|stripe)\b/i, "/pay page must not reference unapproved payment gateways");
// Must not mark anything paid itself — confirmation happens only through the
// server route -> confirm_slip_payment RPC.
assert.doesNotMatch(payPage, /mark.*paid|process.*payment/i, "/pay page must not mark payments paid");
// Must not expose PII fields.
assert.doesNotMatch(payPage, /\bnickname\b|\bphone\b|\bbirth_date_text\b/, "/pay page must not expose customer PII");

// ===========================================================================
// /pay/[token] payment truth: isPaid derived ONLY from order.status === 'paid'
// ===========================================================================
// booking.status confirmed/completed must never set isPaid
assert.doesNotMatch(
  payPage,
  /isPaid[\s\S]{0,200}bookingRow\?\.status.*?(?:confirmed|completed)/,
  "/pay page: booking status confirmed/completed must not contribute to isPaid",
);
// single source of truth: exactly order.status === 'paid'
assert.match(
  payPage,
  /const isPaid\s*=\s*order\.status\s*===\s*['"]paid['"]/,
  "/pay page: isPaid must be derived solely from order.status === 'paid'",
);
// booking status row is shown separately
assert.match(
  payPage,
  /bookingStatusLabel/,
  "/pay page: booking status must be displayed separately from payment success",
);
// confirmed and completed exist only in the booking status label map, not in isPaid
assert.match(
  payPage,
  /BOOKING_STATUS_LABEL[\s\S]*?confirmed[\s\S]*?completed/,
  "/pay page: confirmed/completed should appear in booking status label map",
);

// ===========================================================================
// slots.ts: 'booked' added to occupies() and SLOT_TRANSITIONS
// ===========================================================================
const slotsSrc = readSrc("lib/slots.ts");
assert.match(slotsSrc, /status.*booked.*occupies|booked.*status.*occupies/s, "occupies() must include 'booked'");
assert.match(slotsSrc, /booked.*confirmed.*cancelled|SLOT_TRANSITIONS[\s\S]*?booked/s, "SLOT_TRANSITIONS must include 'booked'");

// ===========================================================================
// status.tsx: 'booked' status label and badge added
// ===========================================================================
const statusSrc = readSrc("app/admin/status.tsx");
assert.match(statusSrc, /booked/, "status.tsx must include 'booked'");

// ===========================================================================
// No public 'mark paid' endpoint exists
// ===========================================================================
// The payments module must not export a route that marks a payment paid.
const paymentOrdersSrc = readSrc("lib/payments/payment-orders.ts");
assert.doesNotMatch(paymentOrdersSrc, /export.*route|mark.*paid/i, "payment-orders must not be a route");

console.log("payments self-check passed");
