# LINE Chat v2 — code handoff (5 Oct 2026)

Base: origin/main at 542e32b. Branch: feat/mohjaew-line-chat.
Worktree: C:\GitHub\_worktrees\mohjaew-line-chat-ready

Implemented:
- Existing signed webhook keeps campaign postbacks and UAT pairing; adds opt-in direct text ingestion.
- Transactional service-role-only queue, event deduplication, per-user serialization and generation leases.
- Six sent turns of per-customer memory, bounded context, booking link and price from server configuration.
- n8n v2 workflow with authenticated ingress, per-item processing and failure callback.
- Backend handles LINE delivery; reply-token expiry has explicit push fallback, stable push retry keys.
- Ambiguous replies become manual-review jobs and block later jobs for that conversation.
- Recovery workflow every minute, bounded retries, expired lease recovery and terminal-message retention.
- Protected /admin/chat page and server actions to pause/resume one conversation.
- Default kill switch off, test-account allowlist, environment scope isolation.
- Beginner connection guide: n8n/README.md.

Validation:
- npm test: PASS (existing suite plus new chat/core, webhook and workflow transformation coverage).
- npm run test:chat:db: PASS on disposable embedded PostgreSQL 18.4; no external DB touched.
  Checks RLS/privileges, security-invoker RPCs, duplicate enqueue, one-owner claims, ordered processing,
  scope isolation, late callbacks, pause/resume, retry bounds and delivery recovery.
- npm run typecheck: PASS.
- eslint on changed TypeScript paths: PASS.
- npm run build: PASS.
- git diff --check: PASS.
- Build emits an existing Supabase dependency/Edge Runtime compatibility warning; new chat endpoints use Node.js.

Connection work still required:
- Install the new database migration in the intended environment and deploy reviewed code.
- Import both n8n workflows, choose Credentials, set environment-specific callback URLs.
- Set Vercel chatbot URL/secret and one test user's allowlist.
- Activate recovery, point LINE webhook to the app, and test a real LINE conversation.

Not yet verified: import/execution inside a live n8n instance, real OpenAI calls, real LINE reply/push, authenticated admin UI in a connected environment.
No production deploy, live database migration or customer messages were performed.

Operational limits:
- LINE OA manual replies are not observable here; admin must pause first.
- An already-in-flight send cannot be recalled.
- Manual review is required after an ambiguous reply result.
- Push fallback/retries consume the OA's message quota.
- Chatbot does not query bookings/payments or create bookings.
