# 01 — Support, Disputes & Resolution architecture

Happy Trader's support system (Milestone 12) is the operational backbone that
connects a customer's stated problem to the authoritative facts across every
domain — accounts, trading, orders/executions, purchases, resets, payouts,
identity, enforcement, affiliates and incidents — and, when a remedy is
warranted, routes it through the canonical domain service that already owns that
money or state. This document is the map; the numbered documents that follow go
deep on each part.

## The one rule that shapes everything

**Support investigates and requests remediation; it never directly mutates money,
balances, executions, P&L, payouts, commissions, or refund state.** Every money
or state-changing action is dispatched to the same canonical engine an operator
would use:

| Remediation | Canonical service |
| --- | --- |
| Account balance credit/debit | `applyAdminAdjustment` (`account-ops.ts`) |
| Courtesy / technical reset | `createResetOrder` (`account-reset.ts`) |
| Purchase refund | `handleRefund` (`commerce-refund.ts`) |
| Payout / trading / certificate / access corrections | performed by the authorized role in its own console (`MANUAL_ACTION_REQUIRED`) |

Each of those services carries its own authorization, audit and idempotency.
Support's remediation layer adds a four-eyes approval gate on top and records the
canonical service's real result — never a fabricated one.

## The investigation backbone

```
CUSTOMER
  └─ SUPPORT REQUEST (ticket, HT-XXXXXX)
       ├─ CUSTOMER 360 context snapshot (accounts, purchases, payouts, tickets)
       ├─ typed LINKS to real objects
       │     ACCOUNT · TRADING · ORDERS/EXECUTIONS · POSITION · PURCHASE ·
       │     RESET · PAYOUT · IDENTITY · ENFORCEMENT · AFFILIATE · COMMISSION ·
       │     CERTIFICATE · INCIDENT
       ├─ diagnostics "What Happened?" (deterministic facts + reason codes)
       ├─ investigation TIMELINE (canonical ops-events / audit)
       └─ RESOLUTION
            ├─ explanation / education (no money moves), or
            └─ REMEDIATION request → approve (four-eyes) → execute (canonical service)
  → everything recorded in the append-only ticket record and the AUDIT stream
```

Nothing in this chain is invented. Diagnostics read server-authoritative facts;
the timeline is drawn from the canonical event/audit streams; remediation results
come back from the real engines.

## Design goals

1. **Money safety by construction.** Support has no write path to money. It can
   only *request* a remediation, which a second authorized actor must approve
   before the canonical service executes it.
2. **Auditable and append-only.** Messages, evidence and ticket lifecycle events
   are append-only at the database level (a `BEFORE UPDATE OR DELETE` trigger
   raises). Money is always integer micros.
3. **Deterministic diagnostics.** The "What Happened?" panel reports recorded
   facts and reason codes, never a generated guess presented as truth.
4. **Privacy between customer and staff.** Internal notes never leak to a
   customer; staff identities are shown to customers only as "Happy Trader
   Support".
5. **Exactly-once remediation.** Approval and execution are guarded by advisory
   locks, status claims and idempotency keys, so two approvers or two workers can
   never double-apply.
6. **Truthful health.** System Doctor and the integrity checks report real SLA
   pressure, real four-eyes compliance and the real storage backend — nothing is
   faked green.

## Module map

| Concern | Module |
| --- | --- |
| Program config, enums, lifecycle, priority suggestion | `platform/support-config.ts` |
| Ticket lifecycle + messaging | `platform/support-tickets.ts` |
| Object linking, evidence, context, timeline | `platform/support-links.ts` |
| Deterministic diagnostics + refund eligibility | `platform/support-diagnostics.ts` |
| Controlled remediation (request → approve → execute) | `platform/support-remediation.ts` |
| Attachments (storage seam, signed downloads) | `platform/support-attachments.ts` |
| Inbox, SLA derivation, analytics, assembled views | `platform/support-inbox.ts` |
| Customer HTTP (`/api/v1/support`) | `http/routes/support-portal.ts` |
| Owner HTTP (`/api/v1/admin/ops/support`) | `http/routes/owner-support.ts` |
| Customer web | `web/src/portal/pages/SupportPage.tsx` |
| Owner web | `web/src/admin/pages/SupportPages.tsx` |

## Data model

13 tables in migration `0034_support.sql` (see doc 02): `support_config`,
`support_categories`, `support_sla_policies`, `support_templates`,
`support_kb_articles`, `support_tag_defs`, `support_tickets`, `support_messages`,
`support_attachments`, `support_evidence`, `support_ticket_links`,
`support_ticket_events`, `support_remediations`.

## Integration with the existing platform

- **Owner OS Command Center** surfaces support KPIs and attention items
  (`command-center.ts`).
- **Global search** groups `support_ticket` and `support_remediation`
  (`search.ts`); the **object explorer** resolves `support_ticket`
  (`object-explorer.ts`).
- **Customer 360** gains a read-only Support tab (`owner-customer.ts`
  `customerDetail`, web `CustomersPage.tsx`).
- **Data integrity** adds two support invariants (`integrity.ts`); **System
  Doctor** adds `support` and `support_storage` probes (`system-doctor.ts`).
- **RBAC** adds the `support.*` permission group; the front line requests and the
  admin tier approves (see doc 11).
- **Audit**: every staff action and lifecycle event is written via `recordAudit`
  (`SUPPORT_TICKET` / `SUPPORT_REMEDIATION` subjects).
