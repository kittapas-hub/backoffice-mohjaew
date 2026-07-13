# Phase 1 policy decision table

Date: 2026-07-13
Companion to: [phase-1-2-implementation-contract.md](phase-1-2-implementation-contract.md)
(recovered verbatim from git object `ca5c86a`; it was never checked in and its
`NOT_READY_FOR_PHASE_1_IMPLEMENTATION` stop was violated by commits
`c27897d..2f7dfff` — finding SEC-001) and to the independent review that
returned `NO_GO_PHASE_1` on HEAD `2f7dfff`.

Status legend:

- **DICTATED** — the position is fixed by the contract and/or the independent
  review + remediation order. Code remediation implements it. The owner still
  countersigns at release sign-off, but no further design input is needed.
- **OWNER** — requires an explicit decision or artifact from the business /
  privacy / production owner. Nothing here is self-approved by the
  implementation. Until supplied, the implementation keeps the safest
  fail-closed default stated in the row.

| # | Policy | State at reviewed HEAD `2f7dfff` | Required position | Status |
|---|--------|----------------------------------|-------------------|--------|
| 1 | **Booking target state** | Verified slip ⇒ `pending_payment → confirmed` (live hold required) | Same: `confirmed`, exactly matching manual confirmation; the dormant `pending_payment → booked` paid-event path must never be used for slips; `booked` is compatibility-only (contract §B, §G-2) | **DICTATED** — contract §G-2 asks for the owner decision to be *recorded*; this table plus release sign-off is that record |
| 2 | **Strict payment timestamp window** | `order.created_at − 30 min ≤ transfer_at ≤ app-now + 10 min`, checked app-side only | `order.created_at ≤ transfer_at ≤ min(order.expires_at, booking.hold_expires_at)`, **and** DB `now() < order.expires_at`, **and** live hold — all inside the locked DB transaction. No grace period. Genuine late verified transfers are transaction-claimed and routed to manual review (PAY-003, contract §B.8) | **DICTATED** |
| 3 | **Receiver identity verification** | Masked account/proxy string match; name check skipped when provider returns no name | Approved immutable receiver profile persisted on the order; unambiguous match required (account evidence **and** name evidence must both match); missing/ambiguous receiver evidence fails closed or routes to manual review; never auto-confirm from a masked suffix alone (RECV-007, contract §B) | **DICTATED** (mechanism) + **OWNER** (the actual profile values: canonical account matcher/fingerprint captured from EasySlip sandbox/staging fixtures with dual control — contract §Gate 0.3-0.4) |
| 4 | **EasySlip API version** | Legacy v1 `POST /api/v1/verify` | Current supported v2 contract (`/api/v2/verify` family) with strict envelope validation (RECV-007) | **DICTATED** (version) + **OWNER** (sandbox access + redacted fixtures for every bank/proxy form Mohjaew receives — contract §Gate 0.3) |
| 5 | **Transaction-claim semantics** | Partial unique index on audit rows `WHERE outcome='confirmed'` only; manual-review money not claimed; manual confirmation records no reference | Durable normalized `payment_transactions` ledger with an unconditional `(provider, tx_ref)` unique constraint; every verified-money transaction is claimed, **including manual-review outcomes**; any existing claim for a different order blocks reuse across automatic, manual-review, and manual confirmation paths (DB-004, contract §B) | **DICTATED**. Residual (documented): a slip the system never saw (pure LINE/eyeball manual confirm with no EasySlip verification) cannot be ledgered without data entry; the fallback remains, with team-owned verification duty |
| 6 | **Slip-image storage** | Images never stored; forwarded to provider and discarded | Contract §B.9 proposes private `payment-slips` storage with lifecycle; review PRIV-012 requires the owner to approve **either** short-lived private storage **or** an adequate normalized review record/UI | **OWNER** — privacy/business decision. Fail-closed default until decided: keep no-storage (strictly less data). PRIV-012 deferred (MEDIUM) |
| 7 | **Normalized evidence retention** | Indefinite retention of normalized audit evidence | Contract §Data retention: audit/transaction identity kept for the approved financial/audit period, never shorter than the replay-defense horizon; exact period must be set by legal/business owner | **OWNER** — no automated deletion is implemented until the period is approved (deleting early would be the unsafe direction) |
| 8 | **Sender-name retention** | `sender_display` (may contain sender name) stored in evidence | Contract §Data retention: never retain sender names unless explicitly approved | **DICTATED** for all *new* structures (the new `payment_transactions` ledger stores no sender identity); removal from the existing attempt-audit evidence is PRIV-012 (MEDIUM, deferred) unless the owner approves retention |
| 9 | **Feature-flag behavior** | Implicit: feature active iff `EASYSLIP_API_KEY` + `SLIP_RECEIVER_ACCOUNTS` + `BOOKING_PAYMENT_AMOUNT_THB` all set; fails closed otherwise | Contract §Rollback: explicit `SLIP_VERIFICATION_ENABLED=false` default plus provider selection flag; UI falls back to manual path | **DICTATED** (direction). Not among the six Gate B findings; the implicit fail-closed gate is kept for this remediation and the explicit flag is listed as deferred work for the next review cycle |
| 10 | **Phase 1 notification behavior** | Confirmation inserts customer `payment_confirmed` + team `payment_received` outbox rows | Contract §Notification flow: Phase 1 inserts **one team row only**; customer rows appear only in Phase 2 with a verified LINE identity (also NOTIFY-011) | **DICTATED** — applied while rewriting the confirmation RPC (new code must follow the checked-in contract; noted as resolving NOTIFY-011 in passing) |
| 11 | **LINE retry-key behavior** | No `X-Line-Retry-Key`; ambiguous timeout ⇒ possible duplicate push | One persistent LINE retry UUID per outbox delivery, sent as `X-Line-Retry-Key` on the first and every retry; LINE `409` for that key is a terminal accepted outcome (NOTIFY-008, contract §Notification flow) | **DICTATED** |

## Open owner decisions (blocking release, not blocking Gate B code remediation)

1. **Production/staging schema evidence (REL-002)** — run
   [supabase/verify_applied_schema.sql](../supabase/verify_applied_schema.sql)
   read-only against staging and production through an authorized channel and
   provide the output. Migration `0010` cannot be finalized (numbered,
   applied, or scheduled) until that output is reconciled and an
   authoritative ledger is committed.
2. **Receiver profile values (row 3)** — EasySlip sandbox/staging fixtures for
   every bank/PromptPay form the shop receives, captured with dual control,
   plus the approved canonical profile (id, account evidence, names).
3. **EasySlip v2 credentials/sandbox access (row 4)**.
4. **Slip-image storage decision (row 6)** and **retention periods (row 7)**.
5. **Contract countersignature** — product/operations/security/privacy owner
   sign-off on this table per contract §Deployment checklist.

None of these are self-approved here.
