# Codex Independent Release Audit — Booking / Payment

Date: 2026-09-07 (Asia/Bangkok)

Branch: `feat/booking-complete`

Compared with: `origin/main...HEAD`
Pre-audit branch commits: `644fd50`, `710e0e1`

## Verdict

**PASS WITH FIXES**

The actual repository, branch diff, effective database functions, routes, UI states, and tests were independently inspected. The previous implementation report was not treated as evidence. Several meaningful money-flow defects were found and fixed with focused application, migration, and regression-test changes.

No known Critical or High finding remains open in the statically reviewed flow. This verdict means the branch is ready for owner-directed staging and physical-device UAT after the new migrations are applied to staging. It is **not** a production-readiness declaration based only on static/local tests.

## Audited chain

`/booking` → face preparation/upload → booking creation → `/booking/success` → payment-order creation → `/pay/[token]` → slip upload/provider verification → paid/manual-review/expired/closed handling → admin list/day/detail and manual-review approval.

The audit also covered amount and receiver ownership, duplicate transaction claims, idempotency, lock order, expiry enforcement, private evidence, upload validation, token/PII exposure, polling, mobile/error recovery, accessibility basics, payment wording, and the large CSS/UI diff.

## Findings and fixes

### Critical — admin booking override could bypass a verified manual-review claim (fixed)

The list/day confirmation control did not load payment-order state and defaulted `verifiedClaimAvailable` to false. An admin could take the booking-only override path while an order was already `manual_review`, producing a confirmed booking without resolving the verified transaction claim.

Fixes:

- Made `verifiedClaimAvailable` mandatory at every call site.
- List/day views now query manual-review state, fail closed when it is unknown, and route manual-review cases to authenticated booking detail.
- The server action independently blocks the booking-only override when review exists.
- Migration `0018_guard_manual_review_booking_override.sql` locks payment orders before the booking, matching the payment functions' lock order, and rejects `confirmed` overrides with `payment_review_required` when a review claim exists. The database guard closes the application-check race.
- Added embedded PostgreSQL coverage proving the override is rejected and the booking remains pending.

### High — payable UI survived trusted expiry or booking closure (fixed)

`/pay/[token]` depended on persisted order/booking statuses. Until the expiry worker ran, initial and already-open pages could continue showing QR, receiver details, and the slip form after the immutable order/hold deadline. A booking moved out of `pending_payment` could also leave an unpaid order page looking payable.

Fixes:

- Server rendering now uses the earlier valid order/hold deadline and fails closed for missing/malformed trusted timestamps.
- Any booking state other than `pending_payment` closes an unpaid checkout.
- A client deadline gate removes all payment instructions when an open tab reaches the deadline and aborts an in-flight upload when unmounted.
- Open checkout tabs refresh trusted server state every 15 seconds so review, payment, admin closure, or expiry in another context is reflected.
- The upload widget refreshes immediately on terminal review/closed responses.
- The customer support reference now uses the booking reference rather than an unsearchable payment-order prefix.

The database remains authoritative: late upload confirmation is rejected/routed under row locks even if a client clock or stale rendering is wrong.

### High — manual-review state was not propagated through the customer flow (fixed)

`/booking/success` polled only booking status. Because a manual-review slip leaves the booking `pending_payment`, the page could keep showing payment instructions and invite another transfer. Payment-order read failure also looked like “no order”.

Fixes:

- The non-PII token lookup and status endpoint now include only the latest payment status in addition to existing booking status/reference fields.
- `manual_review` has a dedicated, precedence-safe state instructing the customer not to transfer or upload again while polling continues.
- A payment-status query failure uses an `unknown` fail-closed state rather than showing payment instructions.
- `/pay/[token]` manual-review copy now explicitly says not to transfer or upload again.

### High — provider duplicate handling could strand a legitimate interrupted retry (fixed)

EasySlip duplicate checking can report a same-branch verification retry as duplicate. The route previously rejected that signal before entering the local atomic transaction ledger. If the first provider call succeeded but the application request failed before local confirmation, a later retry could never reconcile the real transfer.

Fixes:

- Missing/ambiguous duplicate data still fails closed.
- A positive provider-duplicate signal now reaches the local atomic ledger as evidence.
- Migration `0019_recover_provider_duplicate_slip.sql` preserves local idempotency and the unique provider/reference claim. An already-known claim returns its existing result; a claim owned by another order is rejected; an unseen provider-only duplicate is claimed exactly once into `manual_review` and is never auto-confirmed.
- Embedded PostgreSQL tests cover unseen provider duplicate, same-order retry, and cross-order duplicate rejection.

### Medium — admin review lacked sufficient private evidence and expiry guidance (fixed)

Booking detail showed evidence counts but not the latest private slip or a useful review reason, while the confirmation control remained visible after hold expiry.

Fixes:

- Authenticated detail now shows the normalized review reason and creates a five-minute signed URL for the latest object in the private `payment-slips` bucket.
- Raw provider payloads and transaction references are not rendered.
- Expired holds no longer show an approval control; the page directs staff to refund/rebook handling.

### Medium — customer retry and recovery edges (fixed)

Booking submission could leave the UI in an unhandled state on a non-JSON/network failure, and same-file selection could fail to emit a new change event after compression/upload errors. Slip XHR could remain busy indefinitely on a lost mobile connection.

Fixes:

- Booking submission catches network/parse failures while retaining its idempotency key and already-issued upload token, so retry converges on the same attempt.
- File inputs reset after capturing the selected `File`, allowing the same image to be retried.
- Slip verification has a 30-second client timeout, abort-on-unmount, terminal-state handling, and same-file retry.
- Selected slots expose `aria-pressed`; booking errors use `role="alert"`.

### Medium — face intent readiness, image dimensions, and amount configuration (fixed)

An idempotent face-upload retry could receive the pending intent token before the corresponding private object existed (concurrent upload or failed first upload). Server-side face validation also lacked a pixel-dimension ceiling, and a positive but sub-satang/overflowing payment configuration could produce a display/RPC mismatch.

Fixes:

- A pending face intent is returned only after the expected private object is visible; otherwise the retry receives a retryable in-progress response.
- Failed storage uploads attempt partial-object cleanup before releasing the intent.
- Sniffed face dimensions now have a server-side 4096×4096 ceiling in addition to byte limits; the client never bypasses its 1800px policy merely because the original file is small.
- Browser decoding requests EXIF orientation before canvas compression.
- Payment amount parsing now requires a positive, safe PostgreSQL-int satang value, and checkout displays the same parsed value used by order creation. The configured 999 THB remains 99,900 satang.

## Invariants independently verified

- The amount remains server-owned at **999 THB**; this audit did not change it. Client requests do not supply a trusted amount.
- Order amount, currency, receiver profile, and booking ownership are immutable database trust fields.
- Receiver acceptance requires normalized provider evidence to match configured account/name data and the order-bound receiver profile.
- Provider transaction reference ownership is unique by provider/reference. Confirmation, retry, and cross-order contention are resolved under row locks with a consistent payment-order → transaction → booking lock order.
- Booking and payment-order deadlines are rechecked with database time after locks. Late verified transfers are claimed for manual review and do not revive expired/cancelled bookings. Manual approval also rejects expired holds and full slots.
- Face and slip uploads are size/type/signature/dimension checked and use private buckets. Evidence rows/paths are immutable/unique; admin access uses short-lived signed URLs after authentication.
- The public booking status response contains status/reference/latest payment status only; inspected code does not expose customer name, phone, birth date, consultation topic, evidence, or provider payload.
- Booking/order creation uses idempotency keys and database-side eligibility checks.
- The large UI/CSS change is predominantly scoped to booking/checkout selectors and passed lint/build. No unrelated aesthetic changes were added during this audit.

## Exact verification outcomes

- `npm test` — **PASS**, exit 0. All repository self-checks passed, including the added pay-page deadline/polling, success-page manual-review/fail-closed, duplicate evidence, hold-expiry, upload, notification, and migration static checks. Node emitted existing `MODULE_TYPELESS_PACKAGE_JSON` performance warnings only.
- `npm run typecheck` — **PASS**, exit 0 (`tsc --noEmit`).
- `npm run build` — **PASS**, exit 0 on Next.js 15.5.19; optimized build compiled, type/lint phase passed, and all routes were generated. Webpack emitted cache-serialization performance warnings only.
- `npm run test:pg:embedded` — **PASS**, exit 0. Disposable PostgreSQL 18.4 applied migrations 0001–0013, 0018, and 0019; all pre/post migration verifiers passed (0011: 11/25 rows, 0012: 23/11 rows, 0013: 6/14 rows). Slip PostgreSQL integration, controlled concurrency, and booking-confirmed notification integration passed. Expected rejected-operation errors were exercised. The temporary cluster stopped cleanly and its data directory was removed.
- `npm run lint` — **PASS**, exit 0 with no warnings/errors. The repository's `next lint` command emitted only its upstream deprecation notice.
- `git diff --check` — **PASS**, exit 0. Git emitted line-ending conversion notices only; no whitespace errors.

## Residual staging / live-UAT risks

These cannot be closed by static/local tests and must remain owner-directed:

- Apply migrations 0018 then 0019 to a staging clone and verify effective function definitions/permissions before exercising the flow. No remote migration was run by this audit.
- Exercise a real non-production EasySlip account with fresh, same-branch duplicate, cross-branch duplicate, receiver-name/account variants, wrong amount, wrong currency, and transfer-time boundaries. Confirm provider latency fits both server and 30-second client behavior.
- Test iOS Safari and Android Chrome camera/gallery inputs, including EXIF rotation, large panoramas, low-memory canvas failure, PNG/WebP, unsupported HEIC feedback, slow/offline retry, background/foreground transitions, and selecting the same file again.
- Test 320/360px widths, landscape, large text, Thai wrapping, keyboard/focus behavior, VoiceOver/TalkBack announcements, QR visibility/save flow, tab switching, and the 15-second state refresh on physical devices.
- Verify staging cron cadence, runtime clock/timezone, Vercel request-size limits, private signed-slip expiry, and admin refund/rebook operating procedure for transfers received after expiry.
- Treat booking and checkout UUIDs as bearer capabilities in browser history/access logs and shared links. The inspected public responses are non-PII, but retention/redaction policy for infrastructure logs requires live-platform validation.
- Run an owner-observed staging pass across paid, manual-review approval, expired, cancelled, completed, double-click, concurrent-upload, and notification-delivery states. No real payment or LINE notification was performed here.

## Production mutation statement

**Production was not mutated.** This audit did not deploy, merge, push migrations to Supabase, modify Vercel/Supabase/LINE settings, enable flags, send LINE messages, run a real payment, or change the 999 THB amount. No secret values, environment-file contents, API keys, auth cookies, personal data, or production tokens were read or printed.
