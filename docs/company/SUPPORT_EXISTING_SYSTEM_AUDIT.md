# Support Existing-System Audit (forensic trace, Review #3)

Read-only trace of the customer support/ticketing system BEFORE building UI, so Portal V2 reuses
the existing, tested backend (Milestone 12) rather than creating a second source of truth.
Everything below already exists and is covered by `apps/server/src/http/support-http.test.ts`.

## Database (org-scoped, Drizzle) — `apps/server/src/db/schema.ts`
- `support_tickets` (~L3984): `id`, `publicRef` (unique, e.g. `HT-7QK4M2`), `customerUserId`,
  `customerIdentityId`, `categoryKey`/`subcategoryKey`, `subject`, `status` (default `OPEN`),
  `priority`, `assigneeUserId`, SLA fields, resolution fields (`resolutionSummaryCustomer`),
  `csatRating`, `version` (optimistic lock), `lastCustomerAt`/`lastStaffAt`/timestamps.
- `support_messages` (~L4043): `ticketId`, `senderType` (`CUSTOMER`/`STAFF`/`SYSTEM`),
  `visibility` (`CUSTOMER`/`INTERNAL`), `body`, `idempotencyKey` (unique per ticket).
- plus `support_categories`, `support_config`, `support_sla_policies`, `support_templates`,
  `support_kb_articles`, `support_attachments`, `support_ticket_links`, `support_ticket_events`,
  `support_remediations`.

## State vocabulary — `apps/server/src/platform/support-config.ts`
`OPEN, TRIAGED, IN_PROGRESS, WAITING_ON_CUSTOMER, WAITING_ON_INTERNAL, WAITING_ON_PROVIDER,
ESCALATED, RESOLVED, CLOSED`. Terminal: `RESOLVED`, `CLOSED`. Transitions are guarded server-side.

## Categories — centralized (DB, seeded)
`DEFAULT_CATEGORIES` in `support-config.ts` (ACCOUNT, TRADING+subs, PAYOUT+subs, BILLING+subs,
RESET, LOGIN, IDENTITY, RULE_QUESTION, ACCOUNT_FAILURE, CERTIFICATE, AFFILIATE+subs, TECHNICAL,
REFUND, ENFORCEMENT, OTHER). Served by `GET /api/v1/support/categories`. **V2 does not hardcode
categories** — it fetches them.

## Customer endpoints — `apps/server/src/http/routes/support-portal.ts` (mounted `/api/v1/support`, `requireUser`)
- `GET /categories`, `GET /kb`
- `GET /me/tickets` → `{ tickets: [...] }` (own only)
- `POST /tickets` { categoryKey, subcategoryKey?, subject(3–200), body(1–8000), idempotencyKey? }
  → **201 { id, publicRef }** (authoritative create; rate-limited 10/min)
- `GET /tickets/:id` → `{ ticket, messages, attachments }` (public messages only; owner-checked)
- `POST /tickets/:id/messages` { body } → customer reply (server forces `senderType:CUSTOMER,
  visibility:CUSTOMER`; 30/min)
- `POST /tickets/:id/reopen`, `/csat`, `/attachments`, `GET /attachments/:id/download`

## Operator endpoints — EXIST — `apps/server/src/http/routes/owner-support.ts` (`/api/v1/admin/ops`, permission-gated)
Inbox, ticket workspace, staff reply, internal note, assign, priority, **status transition**,
escalate, **resolve**, reopen, link/unlink, remediation (four-eyes). Admin web UI exists
(`apps/web/src/admin/pages/SupportPages.tsx`). → Customer ticketing is **operationally complete**;
operators can read and respond today. (Owner Console is a separate workstream; Review #3 does not
build it — see PORTAL_V2_OWNER_DEPENDENCIES.md.)

## Authorization (tamper resistance) — already enforced + tested
- Customer get/reply/reopen is ownership-checked (`ownTicketOr404`): another customer's ticket → 404.
- Create/reply zod schemas accept only safe fields — no status/assignee/priority/team. A CUSTOMER
  sender cannot post a non-CUSTOMER-visibility note (server hard-blocks), and the route hardcodes
  `senderType:CUSTOMER`, so a customer cannot forge a staff reply.
- Customer-visible projections strip staff identity and INTERNAL notes.
- Links require ownership (`enforceOwnership`). Covered by `support-http.test.ts` (cross-customer
  404, RBAC, forged-visibility, etc.).

## How Portal V2 uses it (Review #3)
`apps/web/src/portal/v2/support.tsx` — a REAL container using the shared `api` client against the
exact endpoints above (identical mechanism to the proven Portal V1 `SupportPage.tsx`). Submit POSTs
an authoritative ticket and re-reads it; it never mutates local state in place of the server. In the
unauthenticated vite-only preview the list is simply empty and the form surfaces the real server
response — no fabricated ticket.

## Future chatbot seam (documented only; NOT built)
A future "Ask Happy" assistant can sit BEFORE ticket creation: suggest an answer → "still need
help?" → create a ticket seeded with the conversation. The create endpoint already accepts the
subject/body it would compose. No AI is built in this phase.
