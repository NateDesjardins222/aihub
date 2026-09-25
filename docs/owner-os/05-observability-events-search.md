# Owner OS — Observability: Events, Correlation & Search

Everything the platform does is observable from one place, built on the existing
authoritative surfaces (`audit_log`, `domain_events`, `outbox_events`) rather than
a parallel logging system.

Module: `apps/server/src/platform/ops-events.ts`, `search.ts`
Routes: `/api/v1/admin/ops/events`, `/correlation/:id`, `/search`

## Unified event timeline

`queryOpsEvents(db, org, filter)` presents one timeline over the existing tables,
classified into four **streams**:

- **AUDIT** — operator actions from `audit_log` (the default admin activity).
- **SECURITY** — staff/access/impersonation/reauth-class actions.
- **ACTIVITY** — customer/business domain events.
- **TECHNICAL** — jobs, deliveries, provider/reconciliation events.

Filters: `stream`, `accountId`, `userId`, `subjectType`, `subjectId`,
`correlationId`, `since`, `until`, `limit` (≤500). Results are newest-first.
Requires `audit.read`.

## Correlation trace

`correlationTrace(db, org, id)` pulls every event tied to a correlation id,
oldest-first, so an operator can follow one logical flow (a checkout →
provisioning → funding, say) across subsystems. An unknown id yields an empty
trace, never an error.

## Global search

`globalSearch(db, org, q, perGroup=8)` matches one query against the identifying
columns of the major objects and groups the results by type:

- customer (email / name / uuid, `role = TRADER`)
- staff (email / name / uuid, `role <> TRADER`)
- account (public id `SIM-nnnnnn` / uuid)
- payout / order / commercial_order (uuid)
- enforcement_case (public ref / uuid)
- certificate (public id / exact verification token / uuid)
- incident (public ref `HT-INC-xxxx` / uuid, org-scoped)

A query shorter than two characters returns nothing. Every result carries a typed
`{ type, id }` the console turns into an Object Explorer / 360 route. Each group's
query is wrapped so one failing table never breaks the whole search.

Authorization: search requires `customers.read`; the event timeline requires
`audit.read`.
