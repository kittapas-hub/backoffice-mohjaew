# Mohjaew Booking + Payment — Final Report

Branch: `feat/booking-complete`. Scope: finish the booking/payment flow as a
production-grade user experience without weakening any existing payment
invariant, LINE integration, or Supabase architecture.

## 1. Architecture / flow audited

Full customer chain inspected before editing:

`/booking` → `POST /api/bookings/face-upload` → `POST /api/bookings` →
`/booking/success?token=…` (client `BookingStatusPanel`, 15s status poll) →
`SlipVerificationLink` → `POST /api/pay/[token]/order` → `/pay/[token]` →
`POST /api/pay/[token]/slip` (EasySlip verify + `confirm_slip_payment` RPC) →
confirmed booking → `/admin/bookings/[id]`.

Key finding: **the payment backend state machine is already complete and
well-tested.** The slip route (`src/app/api/pay/[token]/slip/route.ts`) already
covers pending, uploading/verifying, paid/idempotent, manual_review, expired/
closed, duplicate slip, wrong amount (RPC-side), wrong receiver, invalid image,
rate-limit/attempt ceilings, and provider/network errors — every message is
fixed text with no provider internals, and confirmation is one atomic RPC.
Receiver/amount/duplicate/time checks are enforced under DB row locks. This
matched the prior production-readiness audit ("code solid"), so **no payment
logic was rewritten.** Work concentrated on the UX layer the mission targets
and one genuine functional dead-end.

## 2. Bugs / gaps fixed (functional)

- **`/pay/[token]` manual_review dead-end (Phase 1).** An order in
  `manual_review` fell through to the payable branch and re-rendered the slip
  upload form, which then returns HTTP 409. Added a dedicated "อยู่ระหว่างการ
  ตรวจสอบ" (under team review) state that shows the summary and tells the
  customer not to re-upload. The upload form is now unreachable for an order
  already under review. Covered by a new static regression assertion.
- **Invalid HTML fixed incidentally.** The old success page nested a `<p>` note
  directly inside a `<dl>`; the restructure moves it out to a sibling.

No invariant was touched: idempotency keys, duplicate detection, receiver
validation, immutable trust fields, slot capacity, hold expiry, private
evidence storage, and the fail-closed slip config gate are all unchanged. The
"do not pay after hold expiry" guard still hides the amount and shows the
red stop-notice the moment the client clock passes the deadline, while the
server RPC remains the only source of truth.

## 3. UI decisions

Design language: the existing warm rose/neutral identity from `/booking`
(`--mj-primary #be3455`, warm `#ead9d2` borders, cream surfaces, rounded
cards) was extended into a shared **checkout design system** in
`globals.css` (`.checkout-*`) so `/booking/success` and `/pay/[token]` read as
one coherent journey instead of the previous generic gray/teal Tailwind look.
No new dependencies; plain CSS + existing Tailwind base only.

- **Phase 2 — booking.** Added a compact, decorative (aria-hidden) 4-step
  progress strip that reflects date/slot/details/photo completion without
  introducing wizard state (the single-page flow is unchanged). Migrated the
  face dropzone from scattered inline styles to `.booking-dropzone` classes
  with a focus-within ring for keyboard users. Browser-side face compression
  and its size/reduction feedback are retained exactly.
- **Phase 3 — checkout.** Stripe-like information architecture: a calm summary
  panel (reference, date, session, queue, **amount due**, hold countdown)
  beside a clear action panel (QR, bank rows with accessible copy buttons,
  slip upload, LINE fallback). Two columns ≥860px (summary sticky), one
  vertical flow on mobile. Terminal states (paid / under-review / expired /
  not-found) use a shared centered card so every screen in the flow matches.
  Slip upload keeps its real XHR progress bar, now with `role="alert"` /
  `aria-live` states. Copy interactions were already backend-free and were
  kept, with added `aria-label`s. No "100% secure"-style unverifiable claims;
  microcopy states what the system is actually doing.
- **Phase 4 — admin.** Added full Thai labels for every `payment_order` status
  (no raw enum reaches staff) and a **payment-evidence indicator** (slip image
  on file / evidence-storage failure needing follow-up) on the booking detail.
  The evidence lookup is tolerant of the 0013 tables not existing in an
  environment (query error → indicator simply omitted, page never breaks). The
  refreshed admin shell was preserved.

## 4. Tests & exact outcomes

All mission quality gates run and passing on this branch:

| Gate | Command | Result |
|---|---|---|
| Unit suite | `npm test` | pass (all suites; final suite 16/16) |
| Types | `npm run typecheck` | pass, no errors |
| Build | `npm run build` | pass, exit 0 (all routes compiled) |
| Embedded PG | `npm run test:pg:embedded` | pass, exit 0 |
| Whitespace | `git diff --check` | clean |
| Lint (extra) | `npm run lint` | no warnings or errors |

`test:pg:embedded` logs several postgres `ERROR`/`WARNING` lines — these are the
deliberate negative-path assertions (hold_expired raise, the
`payment_slip_images_storage_path_uniq` duplicate-key check, and RLS
permission-denied), not failures; the run exits 0.

Test changes: extended `src/app/pay/[token]/pay-page-gate.test.ts` with static
assertions that the `manual_review` branch is derived from `order.status` and
short-circuits **before** `PayableSection`, so the upload form can never render
for an order under review. The existing `success-page.test.ts` guards (exact
Thai microcopy, the 15s token-only polling effect and its cleanup) still pass —
those strings and the polling logic were preserved verbatim through the
restyle.

## 5. Remaining production configuration / UAT steps

- **Live smoke test.** `/booking/success` and `/pay/[token]` require Supabase
  service env + a real booking token, so they were verified via build/type/lint
  and unit assertions rather than a live server. Before release, run the app
  with staging env and walk one booking end-to-end (mobile viewport first).
- **Automatic slip verification stays OFF here.** `SLIP_VERIFICATION_ENABLED`,
  `LINE_BROADCAST_LIVE_ENABLED`, and the 999 THB amount were **not** changed.
  When automation is enabled in production, confirm the manual_review screen and
  the admin evidence indicator against a real EasySlip result.
- **0013 evidence tables.** The admin evidence indicator only appears where
  `payment_slip_images` / `payment_slip_evidence_failures` exist. Confirm 0013
  is applied in production (see prior migration-state notes) for the indicator
  to show; until then it is silently omitted, which is safe.

## 6. Owner decisions still required

None blocking. Two optional calls:
- Whether to also surface a per-attempt slip verification history on the admin
  detail (currently only latest-order status + evidence presence are shown).
- Whether the compact booking progress strip should become a real focus-manageable
  stepper later; it is intentionally decorative for now to avoid wizard state.

No Production Supabase / Vercel / LINE state was mutated; changes are committed
and pushed on `feat/booking-complete` only.
