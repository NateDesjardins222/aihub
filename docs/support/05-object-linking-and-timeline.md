# 05 — Object linking, evidence & timeline

A ticket is only useful when it points at the **real** objects behind the
complaint. `support-links.ts` turns free-text descriptions into typed, verified
links, curates evidence, snapshots the customer's context, and draws an
investigation timeline from the canonical event streams — never fabricated.

## Linkable object types

`LINKABLE_OBJECT_TYPES` (`support-config.ts`):

```
account · order · execution · position · purchase · reset · payout ·
payout_operation · enforcement_case · appeal · certificate · affiliate ·
commission · incident · job · webhook · agreement · session
```

A subset, `CUSTOMER_LINKABLE`, is what a customer may link to their own ticket:
`account`, `order`, `execution`, `position`, `purchase`, `reset`, `payout`,
`certificate`, `affiliate`, `commission`. Org-level types (`incident`, `job`,
`webhook`, `agreement`, `session`, `payout_operation`, `enforcement_case`,
`appeal`) are staff-linkable only.

## `resolveObject` — ownership and existence

Before any link is written, `resolveObject(db, org, objectType, objectId)` looks
the object up in its own table and returns `{ ownerUserId, label, exists }`. It
resolves the owning user through the object graph (order → account → user;
commission → affiliate → user; etc.) and scopes every lookup to the organization.
Org-level objects resolve with `ownerUserId: null`.

## `linkObject` — a customer cannot forge a link

`linkObject` validates the type is linkable and the object exists, then:

- If `enforceOwnership` is set (the path customers take), it requires the type to
  be in `CUSTOMER_LINKABLE` **and** `resolved.ownerUserId` to equal the ticket's
  customer — otherwise it refuses (`That object does not belong to you.`). This is
  what stops a customer linking another customer's account to their own ticket.
- Staff links (from `POST /support/tickets/:id/link`, `support.respond`) are not
  ownership-restricted but are still existence-checked and audited.

The insert is idempotent on `(ticket_id, object_type, object_id)`; a duplicate
returns the existing link. `unlinkObject` removes a link (audited). `listLinks`
returns a ticket's links newest-first.

The customer create flow (`support-portal.ts`) auto-links any customer-selected
objects with `enforceOwnership: true`, swallowing individual failures so an
unlinkable object never blocks ticket creation.

## Evidence

`markEvidence` records a curated piece of case evidence into the append-only
`support_evidence` table: `sourceType` (`ATTACHMENT` | `OBJECT` | `EVENT`),
`sourceRef`, optional `objectType` and `description`. `listEvidence` returns it
newest-first. Because the table is append-only, an evidence entry can never be
quietly removed or altered. The staff route is `POST /support/tickets/:id/evidence`
(`support.evidence.manage`).

## Customer context snapshot

`customerContextSnapshot(db, org, customerUserId)` assembles a read-only 360
snapshot for the workspace: the customer's accounts (id, public id, type, status,
admin hold), recent purchases (`commercial_orders`), recent payouts (resolved via
the customer's accounts), recent tickets, and an `activeAccounts` count. It exposes
no raw secrets — no email/KYC/payment detail — only what staff need to navigate.

## Investigation timeline — canonical, never fabricated

`investigationTimeline(db, org, ticketId)` merges events from the canonical M10
ops-event stream via `queryOpsEvents`:

- customer-wide events for the ticket's customer, plus
- events for every linked **account** on the ticket,

deduped by event id, sorted chronologically, and capped (default 60, max 200). Each
row is `{ at, stream, type, summary, actor, accountId, correlationId }`. Nothing is
invented — the timeline shows exactly what the platform recorded. The staff route
is `GET /support/tickets/:id/timeline`.

## Reverse lookup

`ticketsForObject(db, org, objectType, objectId)` answers "which tickets reference
this object?" by joining `support_ticket_links` to `support_tickets`. It is the
building block for object-centric impact views.

> Note: `ticketsForObject` is implemented and unit-tested but is not yet wired into
> an owner route or the object explorer in this milestone; the object explorer's
> `support_ticket` view uses `listLinks` for a ticket's outbound links.
