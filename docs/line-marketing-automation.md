# LINE Marketing automation boundary

Core transactional behavior stays in Next.js and Supabase: LINE webhook handling, booking, payment, segment persistence, UAT push, and any future live broadcast. n8n is intentionally not in their critical path.

n8n can be added later for failure-tolerant, non-critical automation such as a 72-hour campaign recap, exports or syncs to Sheets/Notion/Slack, scheduled internal reports, and non-critical CRM follow-up orchestration. Those workflows should consume stored audit data, avoid holding LINE credentials where possible, and must not bypass the backoffice confirmation and feature gates.
