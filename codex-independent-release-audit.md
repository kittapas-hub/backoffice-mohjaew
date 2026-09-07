# Codex independent release audit

Date: 2026-09-07 (Asia/Bangkok)

Verdict: **PASS WITH FIXES**

This is an independent audit of the actual feat/booking-complete tree and
the origin/main...HEAD implementation diff. The previous implementation
report was not used as evidence. The audited base was origin/main at
fb54cf1; the pre-audit branch tip was e5023da (with the existing pushed
commits 644fd50 and 710e0e1).

## Scope and verified chain

Reviewed the customer and admin chain:

`/booking` → face compression/upload → `POST /api/bookings` →
`/booking/success` → POST payment-order creation → `/pay/[token]` → slip
validation/provider verification → atomic payment confirmation →
`paid`/`manual_review`/`expired`/`closed` customer states → admin list/day/detail
and approval/override actions.

The current slip path derives booking, order, amount, currency, receiver
profile, expiry, and transaction state server-side. A customer cannot submit
an amount, receiver, booking ID, payment status, or storage path. The final
confirmation RPC locks the payment order and booking, claims the normalized
provider transaction reference under a unique index, and routes late,
mismatched, duplicate, or otherwise unsafe claims to `manual_review` rather
than auto-confirming them. A booking-only admin override is blocked when a
manual-review payment claim exists.

## Findings by severity

### High — deployment/schema prerequisite remains explicit

The application’s final manual-review, duplicate-claim, evidence, and private
image behavior depends on migrations `0011`, `0012`, `0013`, `0018`, and `0019`
being applied in order. The repository does not apply these to a live
environment. The `0013` preflight also must confirm that `payment-slips` is
private; an insert-with-conflict-do-nothing cannot repair an already-public
bucket. Do not stage the app against a database that has not passed the
read-only production preflight/post-migration checks.

### Medium — fixed in this audit

- A `refunded` payment order could fall through `/pay/[token]` to payment
  instructions. It now renders a closed/no-pay state, with a regression guard.
- The public booking wrapper accepted a direct booking request without the
  face-upload token even though the current flow requires a face image. The
  shared booking boundary now requires a valid UUID face token before calling
  the RPC; legacy database rows are unchanged.
- A face-upload retry could receive an intent token while its storage object
  was not ready. Retries now verify the private object exists; failed storage
  cleanup retains the intent for the cleanup lease instead of stranding an
  object without a row.
- Client upload responses are shape/UUID checked, status polling is explicitly
  no-store/private, capability pages send `no-referrer`, and paid/manual-review/
  closed states no longer invite another payment or slip upload.
- Payment-slip evidence cleanup now fails closed when the reference lookup is
  uncertain, so an object cannot be removed while a committed evidence row may
  still reference it.
- Image compression now falls back to the existing browser image decoder when
  a browser exposes `createImageBitmap` but rejects its EXIF-orientation
  options. Same-file retry and timeout/error recovery remain covered.

### Medium — residual/future-path risk

- The older generic `create_payment_order`/`process_payment_paid_event`
  foundation in migration `0005` permits a caller-supplied expiry longer than
  the booking hold, and its generic paid-event function does not itself enforce
  the full slip receiver/expiry policy. No current route calls that provider
  path; the current customer flow uses `create_slip_payment_order` and the
  strict slip confirmation RPC. Treat the generic provider path as disabled
  until it receives an additive hardening migration and integration tests.
- `create_booking` locks slot → booking, while payment confirmation/admin
  approval/override use order → booking → slot. A rare concurrent new booking
  against an expiring/manual-review booking can therefore deadlock and cause
  one transaction to retry/fail. PostgreSQL aborts the transaction safely, so
  this is an availability/retry concern rather than an overbooking or payment
  corruption path. A staging concurrency test should exercise it before high
  traffic.

### Low — live/UAT residuals

- No browser E2E or real-device test exists for iOS/Android image pickers,
  EXIF orientation, large/odd images, browser decoder differences, QR scanning,
  long Thai/account strings, keyboard/focus behavior, screen-reader alerts, or
  mobile widths. These require owner-directed staging/mobile UAT.
- No live EasySlip verification, receiver-profile/account alignment, private
  Storage signed-URL check, LINE delivery, or real payment was performed.
  Owner must verify that the displayed bank details and provider receiver
  allowlist describe the same account and that the configured amount remains
  exactly the approved 999 THB.
- Server image checks sniff supported signatures and dimensions but do not
  fully decode/re-encode arbitrary direct face-upload callers. The bucket is
  private and the normal customer path compresses first; fuzzing and storage
  UAT remain appropriate.
- Replaying a booking request with the same idempotency key prevents a second
  booking/hold, but the current immediate team-notification helper can repeat
  a notification after a lost response. This is operational duplication only;
  it does not create a second booking or payment claim.

## Fixes and invariant checks

- Amount is server-derived in satang; the order stores immutable amount,
  currency, provider, booking, and receiver profile fields.
- Receiver matching requires the provider-side matched-account signal plus an
  exact configured masked account/proxy and configured receiver name; missing
  or ambiguous provider data fails closed.
- One provider transaction reference can be claimed only once across orders;
  same-order retries are idempotent, cross-order reuse is rejected, and
  provider-only duplicates are manual review.
- Hold/order expiry is checked again inside the locked RPC. Late verified money
  is retained as a review claim rather than silently accepted or discarded.
- Manual approval resolves only an existing manual-review payment claim and
  rechecks booking state, hold expiry, slot capacity, and locks before
  confirming. Booking-only override cannot bypass that review.
- Face and slip evidence are in separate private buckets; customer responses
  expose opaque capability tokens only, while admin pages use short-lived
  signed URLs after admin authorization.
- Customer URLs contain no booking PII; LINE prefill contains only fixed text
  and the short reference. Referrer leakage is disabled for the capability
  pages.

## Exact verification outcomes

All commands were run after the final code/test changes in this audit:

| Command | Outcome |
|---|---|
| `npm test` | PASS — exit code 0; all listed self-checks passed |
| `npm run typecheck` | PASS — exit code 0 |
| `npm run build` | PASS — exit code 0; Next.js production build completed |
| `npm run test:pg:embedded` | PASS — exit code 0; disposable PostgreSQL on `127.0.0.1`, migrations through `0019`, slip concurrency/manual-review/expiry/permission integration passed, temporary data removed |
| `npm run lint` | PASS — exit code 0; no ESLint warnings/errors (Next.js deprecation notice only) |
| `git diff --check` | PASS — exit code 0; only LF/CRLF conversion warnings |

Targeted post-fix checks also passed: success-page guards, pay-page guards,
integration guards, face-upload guards, client-image-compression guards,
slip-upload guards, hold-expiry guards, and payment-slip notification-image
guards.

## Release disposition

The branch is suitable for owner-directed staging and mobile UAT after the
schema migration/preflight gate above. Static tests do not establish
production readiness. No production Supabase, Vercel, LINE, payment provider,
feature flag, deployment, merge, or message-sending system was mutated during
this audit. No real payment was initiated and no secret values, tokens, API
keys, auth cookies, or customer data were inspected or printed.
