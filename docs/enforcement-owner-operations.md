# Enforcement — Owner Operations (M7)

The owner **Enforcement** workspace (admin app) is where staff triage signals,
investigate cases, place/release holds, record findings and actions, and decide
appeals. It matches the premium owner UI; it is not a flashy fraud dashboard.

## Navigation

`Enforcement` with views: **Review Queue**, **Cases**, **Appeals**, **Holds**,
**Signals**, and a small **Summary**.

## Review Queue

Columns: case id, customer, affected accounts, severity, category, status, opened,
age, current holds, payout exposure (if relevant), assigned reviewer, evidence count.
Filters: severity, category, status, hold type, assigned reviewer, payout-involved,
date.

## Case detail

Sections: Summary · Timeline · Signals · Evidence · Affected accounts ·
Payments/Payouts · Holds · Customer communication · Internal notes · Decisions ·
Appeals · Audit.

Reviewer actions (each audited): assign case; change review state; request
information; add internal note; add/remove hold; record finding; resolve no action;
resolve remediation; confirm violation (authorized only); record enforcement action;
review appeal (separately authorized).

## RBAC / four-eyes

| Capability | Minimum role |
|---|---|
| View cases / queue / signals | `SUPPORT` |
| Investigate: assign, note, state change, information request | `ADMIN` |
| Place / release temporary holds | `ADMIN` |
| Record finding, resolve no-action / remediation | `ADMIN` |
| Confirm serious violation | `SUPER_ADMIN` |
| Account / customer termination | `SUPER_ADMIN` |
| Decide appeal (uphold/overturn) | `ADMIN` |
| Final denial of serious violation; same-reviewer override | `SUPER_ADMIN` |

The server enforces every one of these (`requireRole(...)`), not the UI. The
same-reviewer appeal-independence guard is enforced server-side.

## Signals view

Lists ingested signals with source, kind, occurredAt, correlation to a case, and
idempotency status. Opening a case from a signal is explicit; not every signal
auto-opens a case.

## Holds view

Lists effective and historical holds with scope, capability, reason, case, created/
released metadata, and expiry. Release requires a reason and is audited.

## Observability

Metrics/logs: cases opened/resolved/aging, holds placed/released, payouts held,
appeals submitted/overturned/upheld, signals by category, high-severity security
events, duplicate/idempotent ingestion, and unauthorized admin attempts. No secrets,
raw identity documents, or payment credentials are ever logged.

## Audit

Every meaningful mutation records actor, action, target, case, before/after (or an
immutable event), timestamp, reason, and correlation id. Hold placement/release,
findings, terminations, appeal decisions and remediations are especially clear.
