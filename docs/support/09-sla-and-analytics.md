# 09 — SLA & analytics

The support inbox, its SLA colouring and the overview KPIs are all derived from
authoritative ticket timestamps — no stored "SLA state" that could drift, no
fabricated numbers, and no unbounded payloads. The derivation lives in
`support-inbox.ts`; the SLA clock arithmetic lives in `support-tickets.ts`.

## The SLA clock

Default targets (`DEFAULT_SLA` in `support-config.ts`) are per-priority minutes:

| Priority | First response | Resolution |
| --- | --- | --- |
| URGENT | 60 min | 480 min |
| HIGH | 240 min | 1440 min |
| NORMAL | 1440 min | 4320 min |
| LOW | 2880 min | 10080 min |

Policies are stored rows (`support_sla_policies`) so they are configurable per org;
`DEFAULT_SLA` is the `STANDARD` policy seeded on first use. Business hours are
carried on the policy (`timezone`, `days`, `start`, `end`, `observeHours`).

### `addSlaMinutes(from, minutes, businessHours)`

Computes a due date. When `observeHours` is off (the default), it is simple elapsed
time. When on, it counts **only working minutes**: it walks forward, skipping
non-business days and hours, until the target minutes are consumed. On ticket
creation, `computeSlaDue` sets `first_response_due_at` and `resolution_due_at` from
the policy and the ticket's priority.

### Pause / resume on waiting

When the policy `pauseOnWaiting` is set, entering a `WAITING_*` status stamps
`sla_paused_at`; leaving it computes the paused duration and pushes both due dates
forward by that amount (the first-response due date only if the first response
hasn't happened yet). This accounting happens inside `transitionStatus` under the
per-ticket advisory lock, so the clock can't be corrupted by concurrent edits.

## `slaState` — pure derivation

`slaState(ticket, now)` returns one of `NONE | ON_TRACK | DUE_SOON | BREACHED |
PAUSED | MET` from the ticket's timestamps alone:

- terminal ticket → `MET` if it resolved on/before its resolution due date,
  otherwise `BREACHED` (or `MET` when there was no due date);
- `sla_paused_at` set → `PAUSED`;
- no `resolution_due_at` → `NONE`;
- past due → `BREACHED`; within 4 hours of due → `DUE_SOON`; else `ON_TRACK`.

Because it is a pure function of stored timestamps, the same value is computed
identically in the inbox, the overview KPIs and System Doctor.

## Inbox — `listInbox`

Server-side filtered and **keyset-paginated** (by `updated_at`, newest first). It
supports named views — `ALL`, `UNASSIGNED`, `MINE`, `URGENT`, `WAITING_CUSTOMER`,
`WAITING_INTERNAL`, `WAITING_PROVIDER`, `ESCALATED`, `RESOLVED`, `REOPENED` — plus
filters on category, priority, team, assignee, status and incident, and a short
text search over public ref and subject. Page size is clamped (default 40, max
100); it fetches `limit + 1` to compute `nextCursor`. Each returned ticket carries
its derived `sla` state.

## Overview KPIs — `supportOverview`

Aggregate metrics for the Command Center and the Support page, computed in one set
of parallel queries: open count, unassigned, SLA breached and due-soon (derived
with `slaState` over the active set), urgent count, waiting-on-customer /
-provider / -internal counts, escalated count, resolved-today, reopened count,
CSAT average and count, pending remediation approvals, and per-category /
per-status breakdowns. The active-ticket scan for SLA is bounded (limit 2000) to
keep the query cheap.

## Assembled views

- **`ticketWorkspace(db, org, ticketId)`** — the full staff payload in one call:
  the ticket (with `sla`), the customer record, the complete thread
  (`includeInternal: true`), links, evidence, attachments (`includeInternal:
  true`), remediations, the investigation timeline, and the customer context
  snapshot. Scoped to the organization.
- **`customerTicketView(db, org, customerUserId, ticketId)`** — the customer-safe
  view: ownership re-checked, public messages and attachments only, and a minimal
  ticket shape (subject, status, priority, timestamps, the customer resolution
  summary, CSAT). See doc 04.
