# 03 — Ticket lifecycle

The lifecycle is server-authoritative. The web mirrors the labels, but every
transition, priority change and resolution is validated in `support-tickets.ts`
against the constants in `support-config.ts`. Nothing is destructively deleted —
merge and reopen preserve full history.

## Statuses

`TICKET_STATUSES` (`support-config.ts`):

```
OPEN · TRIAGED · IN_PROGRESS ·
WAITING_ON_CUSTOMER · WAITING_ON_INTERNAL · WAITING_ON_PROVIDER ·
ESCALATED · RESOLVED · CLOSED
```

- `WAITING_STATUSES` = `WAITING_ON_CUSTOMER`, `WAITING_ON_INTERNAL`,
  `WAITING_ON_PROVIDER`. In these the SLA clock pauses when the policy opts in.
- `TERMINAL_STATUSES` = `RESOLVED`, `CLOSED`.

### Allowed transitions

`canTransitionTicket(from, to)` consults an explicit adjacency table. Highlights:

- `OPEN` / `TRIAGED` → any working, waiting, `ESCALATED`, or `RESOLVED` state.
- `IN_PROGRESS` → any waiting state, `ESCALATED`, `RESOLVED`, or back to `TRIAGED`.
- each waiting state → `IN_PROGRESS`, `ESCALATED`, `RESOLVED`, or `TRIAGED`.
- `ESCALATED` → back to working/waiting, or `RESOLVED`.
- `RESOLVED` → `CLOSED` or `IN_PROGRESS`.
- `CLOSED` → nothing (terminal).

Reopen (`RESOLVED`/`CLOSED` → `OPEN`) is **not** in this table; it has its own path
(`reopenTicket`) because it enforces the customer reopen window.

## Priorities, teams, resolution & root cause

- `PRIORITIES`: `LOW`, `NORMAL`, `HIGH`, `URGENT`.
- `SUPPORT_TEAMS`: `GENERAL_SUPPORT`, `TRADING_OPERATIONS`, `PAYOUT_OPERATIONS`,
  `BILLING`, `RISK_ENFORCEMENT`, `TECHNICAL_OPERATIONS`, `AFFILIATES`.
- `RESOLUTION_CODES`: `EXPLANATION_ONLY`, `CUSTOMER_EDUCATION`,
  `REMEDIATION_COMPLETED`, `PROVIDER_ISSUE`, `INCIDENT_RESOLVED`,
  `NO_PLATFORM_ERROR_FOUND`, `DUPLICATE`.
- `ROOT_CAUSE_CATEGORIES`: `EXPECTED_BEHAVIOR`, `CUSTOMER_EDUCATION`,
  `HAPPY_TRADER_SOFTWARE`, `MARKET_DATA`, `EXECUTION_PROVIDER`, `PAYOUT_PROVIDER`,
  `COMMERCE_PROVIDER`, `IDENTITY_PROVIDER`, `BILLING_ERROR`, `CONFIGURATION`,
  `UNKNOWN`.

## Suggested priority — never escalates on tone

`suggestPriority(categoryKey, defaultPriority, signals)` produces a conservative
suggestion from the category's default priority plus **concrete** signals only:

- `LOGIN*` category or a `securityConcern` → at least `HIGH`.
- `tradingBroken`, `duplicateCharge`, `payoutUnknown` → at least `HIGH`.
- a funded account affected *and* (trading broken or payout unknown) → `URGENT`.

It reads no free text and reacts to no tone; an angry message alone never raises
priority. The suggestion is stored as `suggested_priority`; the authoritative
`priority` starts equal to it and is always staff-settable afterward.

## Creation — `submitTicket`

1. Validate the category (and subcategory belongs to it).
2. Compute `suggested_priority` from the category default + signals; set the
   authoritative `priority` to it.
3. Resolve the team from the category (default `GENERAL_SUPPORT`).
4. Compute SLA due dates from the default policy (see doc 09).
5. Allocate a unique `HT-XXXXXX` reference (retried on collision).
6. Insert the ticket, the customer's opening message (idempotent
   `create-<ticketId>` key), any auto-links, a `CREATED` event and an audit entry.

`findRecentDuplicate` flags an open ticket by the same customer, same
(sub)category, inside the configured `duplicateWindowMinutes` — a suggestion only;
it never auto-closes anything.

## Assign / prioritise / tag

- `assignTicket` sets `assignee_user_id` and optionally the team; logs `ASSIGNED`.
- `setPriority` changes the authoritative priority; logs `PRIORITY_CHANGED`.
- `setTags` normalises (trim, dedupe, cap 20 × 40 chars); logs `TAGS_CHANGED`.

## `transitionStatus` — locked + optimistic

`transitionStatus` runs in a transaction that first takes a per-ticket advisory
lock (`pg_advisory_xact_lock` under lock class `'SUPP'`), then:

- checks `expectedVersion` against the row's `version` (raises `STALE_TICKET` on
  mismatch);
- validates `canTransitionTicket(from, to)` (raises `INVALID_TRANSITION`);
- bumps `version`, records the SLA pause/resume accounting (see doc 09), stamps
  `resolved_at` / `closed_at` where relevant;
- writes a `STATUS_CHANGED` event and an audit entry.

## Escalate

`escalateTicket` sets `status = ESCALATED`, reassigns the team, optionally raises
priority, bumps `version`, logs an `ESCALATED` event, and — if a note is supplied —
posts it as an **internal** message. It records an audit entry with the reason.

## Resolve — a customer summary is mandatory

`resolveTicket` requires a non-empty `customerSummary` (raises
`RESOLUTION_SUMMARY_REQUIRED`), supports `expectedVersion`, and persists the
`resolution_code`, the customer-safe summary, the separate internal notes and the
root-cause category. It stamps `resolved_at`, bumps `version`, logs a `RESOLVED`
event and an audit entry. (The integrity check `INV_RESOLVED_TICKET_HAS_SUMMARY`
watches for any resolved ticket missing this summary — see doc 12.)

## Reopen — window-enforced for customers

`reopenTicket` only acts on a terminal ticket. When `byCustomer` is true it
enforces the configured `reopenWindowDays` from `resolved_at`/`closed_at` (raises
`REOPEN_WINDOW_CLOSED` past the window) and reopens to `OPEN`; a staff reopen goes
to `IN_PROGRESS` with no window. It clears `resolved_at`/`closed_at`, bumps
`version`, logs `REOPENED`.

## Merge & split

- `mergeTickets` closes the secondary, points its `merged_into_ticket_id` at the
  primary, and logs `MERGED` on the secondary + `MERGE_RECEIVED` on the primary.
  Both tickets keep their full append-only history; nothing is deleted. Only two
  tickets from the **same customer** can be merged.
- `splitTicket` creates a new ticket for an unrelated issue found in the same
  thread and sets its `follow_up_to_ticket_id` back to the parent; logs `SPLIT`.

## CSAT

`submitCsat` accepts a 1–5 integer rating (plus optional comment) from the
ticket's own customer, only once the ticket is terminal. It records an audit entry.
