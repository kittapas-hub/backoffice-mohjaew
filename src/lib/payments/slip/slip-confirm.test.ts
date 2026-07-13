// Self-check for the atomic slip-payment confirmation (V1).
// Run: node --experimental-strip-types src/lib/payments/slip/slip-confirm.test.ts
//
// DB-level behaviours (row locks, unique indexes, transaction atomicity)
// cannot be verified without a live Supabase instance. Those are marked
// [SQL] below and verified by inspecting the migration SQL directly — the
// same approach as payments.test.ts / hold-expiry.test.ts. Wiring and trust
// boundaries are verified by reading the actual source files.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildEvidence, redactTxRef } from "./evidence.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const migration = read("supabase/migrations/0010_slip_verification.sql");

// ===========================================================================
// [SQL] Audit table: RLS, service-role only, outcome domain
// ===========================================================================
assert.match(migration, /create table if not exists public\.payment_slip_verifications/);
assert.match(migration, /alter table public\.payment_slip_verifications enable row level security/);
assert.match(migration, /revoke all on table public\.payment_slip_verifications from anon, authenticated/);
assert.match(migration, /grant all on table public\.payment_slip_verifications to service_role/);

// ===========================================================================
// [SQL] One-transaction-one-payment invariant (H-9)
// ===========================================================================
assert.match(
  migration,
  /create unique index if not exists payment_slip_verifications_tx_claim_uniq[\s\S]*?\(provider, provider_tx_ref\)[\s\S]*?where outcome = 'confirmed' and provider_tx_ref is not null/,
  "partial unique index must allow one confirmed claim per (provider, tx_ref)",
);

// ===========================================================================
// [SQL] confirm_slip_payment: locks, ordering, guards
// ===========================================================================
const fn = migration.slice(
  migration.indexOf("create or replace function public.confirm_slip_payment"),
);
assert.ok(fn.length > 0, "confirm_slip_payment must exist in 0010");

// Locks the order row, then the booking row (same order as
// process_payment_paid_event — no cross-path deadlock). (H-10)
const orderLock = fn.indexOf("where id = p_payment_order_id for update");
const bookingLock = fn.indexOf("where id = v_order.booking_id for update");
assert.ok(orderLock > 0, "must lock the payment order row");
assert.ok(bookingLock > orderLock, "must lock the booking row after the order row");

// Missing/blank tx ref can never confirm. (H-7)
assert.match(fn, /p_provider_tx_ref is null or btrim\(p_provider_tx_ref\) = ''/);

// Duplicate transaction: same order replays safely; another order is rejected. (H-8, H-9, H-11)
assert.match(fn, /if v_claim\.payment_order_id = p_payment_order_id then/);
assert.match(fn, /'result', 'already_paid'/);
assert.match(fn, /'reason', 'duplicate_tx'/);

// Already-paid order returns a safe idempotent result. (H-11)
assert.match(fn, /if v_order\.status = 'paid' then[\s\S]*?already_paid/);

// Only an open order can be paid.
assert.match(fn, /v_order\.status not in \('created', 'pending'\)/);

// Amount equality against the TRUSTED order amount inside the transaction. (H-2, H-17)
assert.match(fn, /p_amount_satang <> v_order\.amount_satang/);

// Hold eligibility identical to the manual flow (0008): pending_payment + live hold. (H-5, H-6)
assert.match(
  fn,
  /v_booking\.status <> 'pending_payment'[\s\S]*?v_booking\.hold_expires_at is null[\s\S]*?v_booking\.hold_expires_at <= now\(\)/,
  "must require a live pending_payment hold",
);

// Ineligible booking: order -> manual_review, booking untouched, team alerted. (H-5, H-6)
assert.match(fn, /set status\s+= 'manual_review'/);
assert.match(fn, /'slip_manual_review'/);
assert.match(fn, /'slip:review:' \|\| p_payment_order_id::text/);
assert.match(fn, /'result', 'manual_review'/);
// The exception path must never flip the booking's own status.
const reviewBlock = fn.slice(fn.indexOf("v_reason := case"), fn.indexOf("-- Claim the transaction"));
assert.doesNotMatch(reviewBlock, /update public\.bookings/, "manual_review path must not touch the booking");

// [SQL] Concurrency backstop: unique_violation on the claim resolves to
// already_paid (same order) or duplicate_tx (other order). (H-10)
assert.match(fn, /exception when unique_violation then/);

// Success path: order paid + booking pending_payment -> confirmed + audit +
// outbox, all inside this ONE function = one transaction. (H-1, H-21)
assert.match(fn, /set status\s+= 'paid'/);
assert.match(fn, /update public\.bookings[\s\S]*?set status\s+= 'confirmed',[\s\S]*?hold_expires_at = null/);
assert.match(fn, /'payment_confirmed'/);
assert.match(fn, /'payment_received'/);
// Same outbox idempotency keys as process_payment_paid_event — no double notify.
assert.match(fn, /'pay:confirmed:customer:' \|\| p_payment_order_id::text/);
assert.match(fn, /'pay:received:team:' \|\| p_payment_order_id::text/);
assert.match(fn, /on conflict \(idempotency_key\) do nothing/);
// No explicit transaction control statement — the function body IS the
// transaction; any failure rolls back order+booking+audit+outbox together. (H-21)
assert.doesNotMatch(fn, /^\s*(commit|rollback)\s*;/im);

// Invoker rights (no definer escalation), service-role-only execution.
assert.doesNotMatch(migration, /security definer/i);
assert.match(migration, /revoke all on function public\.confirm_slip_payment[\s\S]*?from public, anon, authenticated/);
assert.match(migration, /grant execute on function public\.confirm_slip_payment[\s\S]*?to service_role/);

// ===========================================================================
// [SQL] 0010 does not redefine any existing behaviour (H-22, H-23, H-24)
// ===========================================================================
for (const untouched of [
  "transition_slot_booking",
  "create_booking",
  "process_payment_paid_event",
  "expire_pending_bookings",
  "expire_due_payment_orders",
  "get_open_slots",
]) {
  assert.ok(
    !migration.includes(`function public.${untouched}`),
    `0010 must not redefine ${untouched}`,
  );
}
// The manual confirmation flow (H-22) and its hold guard (H-23) still exist.
assert.match(read("src/app/admin/actions.ts"), /export async function confirmPayment/);
assert.match(read("src/app/admin/actions.ts"), /p_to: "confirmed", \/\/ never from client/);
assert.match(read("supabase/migrations/0008_reject_expired_hold_confirmation.sql"), /hold_expired/);
// Admin auth guard untouched (H-24).
assert.match(read("src/app/admin/actions.ts"), /await requireAdmin\(\);/);

// ===========================================================================
// Upload route: trust boundary (H-17, H-18, H-19)
// ===========================================================================
const route = read("src/app/api/pay/[token]/slip/route.ts");

// The ONLY form fields the route may read: the file and the honeypot. A
// client-forged amount / receiver / booking id has nowhere to enter.
const formReads = [...route.matchAll(/form\.get\("([^"]+)"\)/g)].map((m) => m[1]);
assert.deepEqual([...new Set(formReads)].sort(), ["company", "file"]);
assert.doesNotMatch(route, /form\.get\("(amount|receiver|booking|bookingId|orderId)"\)/);
assert.doesNotMatch(route, /req\.json\(\)/, "route must not accept a JSON body");
assert.doesNotMatch(route, /searchParams/, "route must not read query params");

// Order + booking resolved server-side from the checkout token.
assert.match(route, /eq\("checkout_token", token\)/);
assert.match(route, /eq\("id", order\.booking_id\)/);

// Real image validation, size cap, honeypot, rate limit, attempt ceiling.
assert.match(route, /validateSlipImage\(image\)/);
assert.match(route, /form\.get\("company"\)/);
assert.match(route, /recordRateHit\(/);
assert.match(route, /MAX_ATTEMPTS_PER_ORDER/);
// The provider is fed the SNIFFED type, never the client's claimed MIME.
assert.match(route, /mimeType: imgCheck\.meta\.type/);

// Fail closed when unconfigured; never silently skip verification.
assert.match(route, /cfg\.receiverAccounts\.length === 0/);

// Privacy: no raw provider payload or slip image in logs; tx refs redacted.
assert.doesNotMatch(route, /console\.[a-z]+\([^)]*verified\.slip/);
assert.doesNotMatch(route, /console\.[a-z]+\([^)]*image/);
assert.match(route, /redactTxRef\(/);
// No secret and no provider internals in any customer-facing message.
assert.doesNotMatch(route, /EASYSLIP_API_KEY/);
assert.doesNotMatch(route, /message: .*error\.message/);

// ===========================================================================
// Secrets stay server-side (H-G)
// ===========================================================================
const clientUpload = read("src/app/pay/[token]/SlipUpload.tsx");
assert.match(clientUpload, /^"use client";/m);
assert.doesNotMatch(clientUpload, /easyslip/i, "client must not know the provider");
assert.doesNotMatch(clientUpload, /process\.env/, "client must not read env");
// EASYSLIP_API_KEY is read in exactly one place: server-only env.ts.
const envSrc = read("src/lib/env.ts");
assert.match(envSrc, /EASYSLIP_API_KEY/);
for (const rel of [
  "src/lib/payments/slip/easyslip.ts",
  "src/app/pay/[token]/page.tsx",
  "src/app/pay/[token]/SlipUpload.tsx",
]) {
  assert.ok(!read(rel).includes("EASYSLIP_API_KEY"), `${rel} must not read the API key`);
}

// ===========================================================================
// Wiring: UI, outbox worker, cron, notification retry (H-20)
// ===========================================================================
assert.match(read("src/app/pay/[token]/page.tsx"), /<SlipUpload token=\{token\} \/>/);
assert.match(read("src/app/booking/success/page.tsx"), /getOrCreateSlipPaymentOrder/);
assert.match(read("src/app/booking/success/BookingStatusPanel.tsx"), /props\.payUrl/);

const worker = read("src/lib/notifications/delivery-worker.ts");
assert.match(worker, /"slip_manual_review"/);
assert.match(worker, /renderSlipManualReviewMessage/);
// Notification retry (H-20) is the existing outbox machinery: confirm inserts
// pending rows only; the worker + complete_notification_delivery backoff
// handle delivery/retry. Verified by 0007 + delivery-worker tests; here we
// only pin that confirm_slip_payment never performs delivery itself.
assert.doesNotMatch(fn, /pg_net|http_post|net\.http/i);

const cron = read("src/app/api/cron/expire-bookings/route.ts");
assert.match(cron, /expireDuePaymentOrders/);

// ===========================================================================
// Evidence + log redaction helpers (pure TS)
// ===========================================================================
{
  const evidence = buildEvidence({
    provider: "easyslip",
    providerTransactionReference: "TXREF123456",
    transferTimestamp: new Date("2026-07-13T04:50:00Z"),
    amountSatang: 50000,
    receiver: {
      bankShort: "KBANK",
      accountMasked: "xxx-x-x1234-x",
      proxyMasked: null,
      nameTh: "นาง มลฤดี ใจดี",
      nameEn: null,
    },
    senderDisplay: "SCB",
    duplicateSignal: null,
  });
  assert.deepEqual(Object.keys(evidence).sort(), [
    "amount_satang",
    "provider",
    "receiver_account_masked",
    "receiver_bank",
    "receiver_proxy_masked",
    "sender_display",
    "transfer_at",
    "tx_ref",
  ]);
  // Evidence keeps only normalized fields — receiver names (PII) stay out.
  assert.ok(!JSON.stringify(evidence).includes("มลฤดี"));
}
assert.equal(redactTxRef("68370160657749I376388B35"), "…8B35");
assert.equal(redactTxRef(null), "-");

console.log("slip-confirm self-check passed");
