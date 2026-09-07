# Phase 1 EasySlip — controlled UAT runbook

## Purpose and authorization

This runbook takes the EasySlip automatic slip-verification feature
(migrations `0011`–`0013`, `src/app/api/pay/[token]/*`,
`src/lib/payments/slip/*`) from "code merged" to "verified against one real,
small-value transaction" without risking uncontrolled exposure. It complements
[`phase-1-production-schema-verification-runbook.md`](phase-1-production-schema-verification-runbook.md)
(schema reconciliation for `0001`–`0009`) and README §12.

Only an authorized project owner or database operator may execute the
migration and production steps below. Every step that touches the production
Supabase project or moves real money requires the owner's explicit
go-ahead — do not self-approve any step in this document.

**Never let an automated agent apply migrations, flip production env vars, or
send a real bank transfer.** Those steps are marked "OWNER ACTION" below and
must be performed by a human with production access.

## Step 0 — confirm the current baseline (do not assume)

The migration file headers are not a reliable source of "what is actually
applied" — several (`0011`, `0013`) are explicitly marked `PROPOSED` /
"do not apply without review", and prior verification sessions found earlier
headers stale. Before doing anything else:

1. OWNER ACTION: run `supabase/verify_applied_schema.sql` (read-only) against
   the target project and compare against the migration ledger, per
   [`phase-1-production-schema-verification-runbook.md`](phase-1-production-schema-verification-runbook.md).
2. Confirm which of `0001`–`0013` are actually live. Do not trust a prior
   session's notes about baseline state as current fact — re-verify.
3. Only continue past a migration once its own preflight script (below)
   reports all `PASS`.

## Step 1 — preflight → migrate → post-migration, one migration at a time

Run in this exact order. Do not batch or skip a post-migration check. Each
script is read-only catalog/aggregate inspection only (see each script's own
header) — none of them execute application functions or return customer rows.

| Order | Preflight (must be all `PASS`) | Migration (OWNER ACTION) | Post-migration (must be all `PASS`) |
|---|---|---|---|
| 1 | `supabase/verify_0011_production_preflight.sql` | `supabase/migrations/0011_slip_verification.sql` | `supabase/verify_0011_post_migration.sql` |
| 2 | `supabase/verify_0012_production_preflight.sql` | `supabase/migrations/0012_booking_confirmed_notification.sql` | `supabase/verify_0012_post_migration.sql` |
| 3 | `supabase/verify_0013_production_preflight.sql` | `supabase/migrations/0013_payment_slip_notification_image.sql` | `supabase/verify_0013_post_migration.sql` |

If any row reports `FAIL`, stop and escalate to the owner — do not apply the
corresponding migration. `supabase/verify_0012_production_preflight.test.ts`
and `supabase/verify_0013_production_preflight.test.ts` already assert the
preflight scripts' hardcoded provenance literals match the actual migration
file content (`npm test` fails otherwise) — re-run `npm test` on the exact
commit being deployed before relying on these scripts.

The same sequence is exercised end-to-end against a disposable embedded
Postgres cluster by `npm run test:pg:embedded` (applies `0001`–`0013` and
every preflight/post-migration script in order, then runs
`src/lib/payments/slip/slip-postgres.integration.test.ts` and
`src/lib/notifications/booking-confirmed-notification.integration.test.ts`).
Run it locally before asking the owner to touch production — it never
connects to Supabase.

## Step 2 — environment checklist (fail-closed verification)

All 8 variables below must be set on the target Vercel environment before the
feature can activate (see README §12 for what each one means):

```
SLIP_VERIFICATION_ENABLED=true
SLIP_VERIFICATION_PROVIDER=easyslip_v2
EASYSLIP_API_KEY=<real key>
SLIP_RECEIVER_ACCOUNTS=<masked accounts from a verified real slip>
SLIP_RECEIVER_PROFILE=<owner-approved profile id>
SLIP_RECEIVER_NAMES=<receiver display names>
PAYMENT_ORDER_IDEMPOTENCY_SECRET=<random secret>
BOOKING_PAYMENT_AMOUNT_THB=<amount>
```

Before setting real values, prove the fail-closed behavior with at least one
variable intentionally left unset (do this on a preview/staging deployment,
never by half-configuring production):

1. `POST /api/pay/[token]/order` → expect `503 {"error":"not_configured"}`.
2. `POST /api/pay/[token]/slip` → expect `503 {"error":"not_configured", ...}`.
3. `/pay/[token]` page → expect the manual "ส่งสลิปให้ทีมงาน" fallback card,
   never the upload form (`isSlipUploadReady()` in
   `src/app/pay/[token]/pay-page-gate.ts` gates this).

This is already covered by `src/lib/payments/slip/slip-feature-gate.test.ts`
and `src/lib/env.test.ts` — re-running `npm test` is a substitute for manual
poking of a running server, but doing the manual check once against the real
target environment catches misconfiguration `npm test` cannot see (e.g. a
typo'd Vercel env var name).

Only once all 8 are confirmed set and correct should real values replace any
placeholder used above.

## Step 3 — 1 THB controlled UAT

Do this against the real production database and a real bank transfer, but
with the smallest amount that still produces a genuine, verifiable slip.

OWNER ACTION — perform in order:

1. Temporarily set `BOOKING_PAYMENT_AMOUNT_THB=1` on the target deployment
   (redeploy or `vercel env pull`/push as appropriate for that environment —
   do **not** leave this set to `1` once the UAT is done).
2. Create one real booking through the normal customer flow
   (`/booking?source=website` or similar) to get a fresh `pending_payment`
   booking with a live hold.
3. From the booking-success page, tap "อัปโหลดสลิป — ยืนยันคิวอัตโนมัติ" to
   create the payment order (`POST /api/pay/[token]/order` →
   `create_slip_payment_order` RPC) and land on `/pay/[checkoutToken]`.
4. Transfer exactly 1 THB from a real bank account to the configured
   receiving account, within the booking's hold window.
5. Upload the real slip image at `/pay/[token]`.
6. Verify all of the following:
   - Response is `{"status":"confirmed"}`.
   - `payment_orders.status = 'paid'` for that order.
   - `bookings.status = 'confirmed'` for that booking.
   - Exactly one row in `payment_transactions` with `resolution = 'confirmed'`
     for that `(provider, normalized_tx_ref)`.
   - Exactly one row in `payment_slip_images` for that `payment_order_id`,
     and the object exists in the private `payment-slips` storage bucket.
   - A `notification_deliveries` row with `event_type = 'booking_confirmed'`
     exists, and — once the delivery worker (`OUTBOX_DELIVERY_ENABLED=true`)
     picks it up — the team LINE group receives the message with both the
     face photo (if one was on file) and the slip image attached
     independently (`notification_image_deliveries`, two rows keyed by
     `image_kind`).
7. Reset `BOOKING_PAYMENT_AMOUNT_THB` back to the real production amount.

If step 6 fails at any point, stop, capture the `payment_slip_verifications`
row for that attempt (has the full audit outcome), and do not proceed to
Step 4 until the owner has reviewed why.

## Step 4 — duplicate-slip replay

Confirms the one-transaction-one-payment invariant
(`payment_transactions_provider_ref_uniq` on `(provider, normalized_tx_ref)`)
holds against a real, already-claimed transaction reference — not just the
mocked unit tests.

1. Re-upload the **same** slip image used in Step 3 to the **same**
   `/pay/[token]` (or to a second booking's `/pay/[token2]`, to exercise the
   cross-order case).
2. Expected result: `409 {"error":"duplicate_tx", ...}`. The booking/order
   from Step 3 is untouched; no second `payment_transactions` row is created
   for that `normalized_tx_ref`; no second `booking_confirmed` notification is
   enqueued for a different booking.
3. Confirm via `payment_slip_verifications` that the replay attempt was
   recorded with `outcome = 'duplicate_tx'` for audit, without affecting the
   original confirmed payment.

This mirrors the concurrent-duplicate assertions already covered by
`src/lib/payments/slip/slip-postgres.integration.test.ts` (which drives the
same RPC directly, under real Postgres locks, with two concurrent callers) —
this manual step is the one confirmation that the same guarantee holds when
the request actually goes through the EasySlip API and the Next.js route, not
just the RPC in isolation.

## Step 5 — rollback / disable gate

Fastest, no-DB-touch disable (use this first if anything in Steps 3–4 looked
wrong): set `SLIP_VERIFICATION_ENABLED=false` (or unset any one of
`EASYSLIP_API_KEY` / `SLIP_RECEIVER_ACCOUNTS` / `SLIP_RECEIVER_NAMES`) on the
target Vercel environment and redeploy/restart. Verify:

- `POST /api/pay/[token]/order` and `POST /api/pay/[token]/slip` both return
  `503 not_configured`.
- `/pay/[token]` shows the manual LINE-slip fallback card only.
- The existing manual admin confirm button (`/admin/bookings/[id]`) still
  works — it does not depend on any of the Phase 1 env vars.

This never requires a database change and never loses data: every table
written by `0011`–`0013` (`payment_slip_verifications`, `payment_transactions`,
`payment_slip_images`, `payment_slip_evidence_failures`,
`notification_image_deliveries`) is additive and is left untouched.

Full DB-level rollback (only if the RPC behavior itself must be reverted, not
just disabled) is documented at the bottom of
`supabase/migrations/0013_payment_slip_notification_image.sql`: re-run
`0012`'s `create or replace function` statements for `transition_slot_booking`,
`confirm_slip_payment`, and `approve_manual_review_payment` to restore their
pre-`0013` bodies. Do not drop the `payment-slips` bucket or any of the tables
listed above — they are payment evidence and must be retained regardless of
whether the migration is rolled back at the application layer.

## Stop conditions

Stop and escalate to the owner without changing production if:

- Step 0's baseline check finds the project/environment cannot be identified
  with certainty, or finds `0011`/`0013` objects already partially present
  before their preflight has been run.
- Any preflight or post-migration script reports a `FAIL` row.
- `npm test`, `npm run typecheck`, `npm run build`, or
  `npm run test:pg:embedded` fail on the commit being deployed.
- The 1 THB UAT (Step 3) does not reach `confirmed` for a slip that a human
  can visually confirm is genuine, correct-amount, correct-receiver.
- The duplicate-slip replay (Step 4) does not return `409 duplicate_tx`, or
  the original confirmed payment is altered in any way.
