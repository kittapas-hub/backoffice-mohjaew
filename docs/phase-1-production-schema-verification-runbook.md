# Mohjaew Phase 1 production schema verification runbook

## Purpose and authorization

This runbook accompanies `supabase/verify_applied_schema.sql`. The script is an evidence-collection tool for reconciling the schema actually applied to the Mohjaew Supabase project with repository migrations `0001` through `0009`.

Only an authorized project owner or database operator may run it. Run it in the Supabase Dashboard SQL Editor for the intended project, or through an approved read-only PostgreSQL connection. Confirm the selected project and environment before opening the script. Production execution requires the owner's explicit authorization.

Do not run any migration as part of this procedure. The reconciliation migration `0010` may be considered only after this evidence is complete, all drift is explained, and the owner has approved the production baseline. The slip-verification migration `0011` remains blocked until reconciliation has completed and been verified.

## Before running

1. Open `supabase/verify_applied_schema.sql` from the reviewed repository revision.
2. Confirm that it contains only catalog inspection and read-only reporting queries.
3. Confirm the active Supabase project name and environment with the owner.
4. Use an account permitted to inspect catalog metadata and function definitions. Do not broaden privileges merely to obtain output.
5. Record the repository commit, execution environment, execution date and operator name outside the SQL output.

## Running and exporting the results

The script produces multiple numbered result sets. In the Supabase SQL Editor, run one numbered section at a time so each complete result grid can be exported without truncation. If an approved read-only PostgreSQL client is used, enable full, untruncated output and preserve all result sets in order.

Export every numbered result set, including empty result sets. Name each export with the environment and section number, for example `production-03-migration-ledger.csv`. Do not substitute screenshots for complete tabular exports. Preserve database notices and errors separately; an error is evidence that the corresponding inspection could not be completed, not permission to alter the database.

Before sharing evidence, remove connection metadata and review the export for secrets or customer information. Never include:

- database URLs, passwords, certificates or connection strings;
- Supabase service-role or anonymous keys;
- EasySlip, LINE or other API credentials;
- authorization headers, cookies, session tokens or signed URLs;
- customer names, phone numbers, LINE identifiers or booking/payment rows;
- slip images, face images, notification bodies or other customer-provided content.

The reviewed script is intended to return catalog metadata, definitions, privilege information, aggregate counts and storage bucket metadata—not application row contents. Stop and redact the export if unexpected customer data appears.

## Reconciliation against migrations 0001–0009

Compare the complete output with the migration files in repository order. For every object, record `exact match`, `explained drift`, `unexplained drift`, `absent`, or `could not verify`, with the evidence section and owner disposition.

| Migration | Required comparison |
|---|---|
| `0001` | Core booking tables, keys, constraints, indexes, RLS state/policies, and the private booking-face storage bucket metadata. |
| `0002` | Slot/status schema, booking functions, function signatures and privileges, constraints, indexes and RLS changes. |
| `0003` | Face-upload support and the resulting `create_booking` identity arguments and full definition. |
| `0004` | Slot lease columns, lease constraints/indexes and lease-related functions. |
| `0005` | Payment-order/payment-event/audit/outbox schema; payment, booking and notification status constraints; functions, privileges and policies. |
| `0006` | The replaced `get_open_slots` definition, including confirmation that it no longer performs expiry as a read-path side effect. |
| `0007` | Notification lease columns, status constraints/indexes, and outbox claim/complete functions and privileges. |
| `0008` | `transition_slot_booking` identity arguments and full definition, including the `hold_expired` transition behavior. |
| `0009` | Canonical booking-session data outcome and aggregate evidence for remaining open hourly slots. Do not export booking rows. |

Reconcile both the migration ledger and the actual object definitions. A ledger row alone does not prove that the expected definition is present, and a matching definition without the expected ledger history is still drift that requires explanation. Compare function identity arguments as well as names because PostgreSQL privileges and replacements apply to a specific signature.

Record the final reconciliation in the project's migration-ledger evidence record. The owner must approve all unexplained differences or require remediation before any later migration is considered.

## Stop conditions

Stop and escalate to the owner without changing the database if:

- the project or environment cannot be identified with certainty;
- the migration ledger is missing, unreadable or inconsistent with the object definitions;
- any result suggests slip-verification migration `0011` is already present or partially applied;
- an expected `0001`–`0009` object is absent or has unexplained definition, owner, privilege, RLS or constraint drift;
- the script returns customer rows or secrets;
- obtaining a result would require a write, privilege change or mutating function call.

Do not clean up, repair, replay or mark any migration from this runbook. The reconciliation migration `0010` requires explicit approval after this evidence; slip-verification migration `0011` remains blocked until reconciliation completes and is verified.
