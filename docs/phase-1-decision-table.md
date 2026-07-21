# Mohjaew Phase 1 owner decision table

Date: 2026-07-13

Companion documents:

- [Recovered implementation contract](phase-1-2-implementation-contract.md),
  preserved byte-for-byte from Git object `ca5c86a`.
- [Production schema verification runbook](phase-1-production-schema-verification-runbook.md).
- [Read-only schema verification SQL](../supabase/verify_applied_schema.sql).

This record does not approve any owner, financial, privacy, vendor, or
production decision. “Required position” records the safe boundary from the
independent security review; it is not a substitute for the approval named in
the final column.

Classification meanings:

- **Already dictated by the independent security review** — a security or
  integrity boundary that remediation must satisfy; it is not open to being
  weakened during Phase 1.
- **Requires owner approval** — product, operations, finance, privacy, legal,
  or vendor ownership must explicitly choose or countersign the position.
- **Requires production evidence** — the decision cannot be completed from the
  repository; authorized read-only environment evidence is required.

| # | Decision item | Classification | Required position / safe pending state | Exact approval or evidence still required |
|---|---|---|---|---|
| 1 | **Production migration baseline** | **Requires production evidence** | Treat the applied staging and production schema as unknown. Reconciliation migration `0010` may be scheduled only after migrations `0001`–`0009` are reconciled against authorized read-only output and the owner approves the baseline; slip-verification migration `0011` remains blocked until that reconciliation completes and is verified. | Complete output from `supabase/verify_applied_schema.sql` for staging and production; reconciliation signed by the production owner; committed authoritative migration ledger. |
| 2 | **Automatic booking target state** | **Requires owner approval** | Security review recommendation: a successfully verified Phase 1 payment should produce the same trusted state as manual confirmation, `pending_payment -> confirmed`; the dormant `-> booked` paid-event path must not be used for slips. Until approved, automatic confirmation remains disabled. | Product/operations owner must explicitly approve `confirmed`, compatibility treatment of existing `booked` rows, and the manual-review fallback. |
| 3 | **Strict payment timestamp window** | **Requires owner approval** | Security review safe policy: `order.created_at <= transfer_at <= min(order.expires_at, booking.hold_expires_at)`, plus database `now() < order.expires_at` and a live hold, with no grace period. A genuine late transfer is claimed and routed to manual review, never auto-confirmed. Until finance approves, automatic confirmation remains disabled. | Finance/product owner approval of the exact inclusive/exclusive boundaries, timestamp source/timezone handling, late-payment handling, refund/manual-review policy, and customer wording. |
| 4 | **Verified transaction claim semantics** | **Already dictated by the independent security review** | Every provider-verified transaction reference must be normalized and globally claimed once, including verified money routed to manual review. A claim for another order must block reuse across automatic and assisted verification paths. | Security remediation must supply PostgreSQL concurrency and rollback evidence. Owner acknowledgement is part of release sign-off but cannot weaken the one-transaction/one-payment invariant. |
| 5 | **Receiver identity profile** | **Requires owner approval** | Never auto-confirm from a masked suffix alone. Persist an immutable receiver profile on the order and require unambiguous provider evidence; missing or ambiguous evidence fails closed. | Dual-controlled canonical profile ID, account/proxy evidence and approved names; redacted provider fixtures for every receiving form; finance/operations approval of rotation and effective dates. |
| 6 | **EasySlip API version** | **Requires owner approval** | Do not release against the unverified legacy adapter. Pending approval, verification remains disabled. The preferred candidate is the current supported API contract with strict envelope/error validation and receiver/amount matching. | Vendor/account owner confirmation of the supported API version and plan, endpoint and authentication contract, sandbox/staging access, quota behavior, and redacted response fixtures. |
| 7 | **Slip image storage** | **Requires owner approval** | Two acceptable designs require approval: private short-lived storage with lifecycle/fencing, or no image retention with an adequate normalized manual-review record and UI. Pending decision, do not add storage and do not enable automatic confirmation. | Privacy/business decision, access model, manual-review evidence needs, storage location, deletion schedule, legal-hold process, and incident-access procedure. |
| 8 | **Evidence retention duration** | **Requires owner approval** | Transaction identity must remain at least as long as the replay-defense horizon; all other evidence must follow an approved minimization and deletion schedule. No duration is approved by this record. | Finance/legal/privacy owner must specify retention for accepted, rejected, technical-error, and manual-review evidence, plus deletion and legal-hold rules. |
| 9 | **Sender-name retention** | **Requires owner approval** | Safe pending state: do not retain sender names in new evidence or logs. Existing `sender_display` persistence remains an unresolved finding and must not be treated as approved. | Privacy/legal owner must either prohibit sender-name retention and authorize removal/migration, or document purpose, access, and duration for an explicit exception. |
| 10 | **Feature flag** | **Already dictated by the independent security review** | Use an explicit server-only Phase 1 feature flag that defaults off. Provider selection and notification delivery must fail closed independently; missing or malformed configuration must not enable the feature. | Regression evidence that default/missing/invalid states are off and that rollback disables new verification without removing audit/replay data. |
| 11 | **Phase 1 team notification** | **Requires owner approval** | Security boundary if enabled: one durable team outbox intent per outcome, no send inside the payment transaction/request, fixed minimal payload, idempotent delivery, and a default-off worker kill switch. | Operations owner must approve destination, event set, message content, escalation ownership, backlog handling, monitoring, and enablement timing. |
| 12 | **Phase 1 customer notification** | **Already dictated by the independent security review** | No customer LINE outbox row or delivery in Phase 1 without a verified `line_user_id`. Customer delivery remains Phase 2 scope. | Regression evidence that Phase 1 creates no customer delivery intent. Any future customer delivery requires the separately approved Phase 2 identity contract. |
| 13 | **LINE retry-key behavior** | **Already dictated by the independent security review** | Persist one retry UUID per outbox delivery, send it as `X-Line-Retry-Key` on the first and every retry, and treat LINE `409` for that key as already accepted. | Behavioral test for accepted-then-timeout, stable retry key, `409`, lease loss, and retry completion. |

## Exact unresolved owner decisions

1. Approve or reject `confirmed` as the automatic target state and define
   compatibility treatment for `booked`.
2. Approve the strict timestamp boundaries and financial handling of genuine
   late payments.
3. Approve the canonical receiver profile, its effective dates, and rotation
   process after reviewing provider fixtures.
4. Select and approve the supported EasySlip API version/account contract.
5. Choose private short-lived slip storage or no-storage with adequate review
   evidence.
6. Set normalized evidence retention and legal-hold periods.
7. Prohibit sender-name retention or approve a documented exception.
8. Approve Phase 1 team destination, payload, escalation, monitoring, and
   enablement timing.
9. Countersign the recovered contract and this decision record through the
   project’s product, operations, finance, security, and privacy owners.

## Exact production evidence still required

1. Full read-only schema report from staging and production.
2. Supabase migration-ledger rows, if the ledger exists; otherwise explicit
   evidence that no ledger is present.
3. Object-level reconciliation for migrations `0001`–`0009`, including the
   replaced-function definitions and the `0009` data-only cutover result.
4. Current status constraints, function owners/definitions, function ACLs,
   table ACLs, RLS state, and policies.
5. Confirmation whether any `0011` slip-verification objects already exist or were partially
   created.

None of these decisions or evidence requirements is self-approved here.
