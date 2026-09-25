# Enforcement Case Lifecycle (M7)

An enforcement case tracks an investigation. It is **separate** from account
lifecycle status — a customer/account can have an open case without being failed,
locked or terminated.

## Case states

```
OPEN → TRIAGED → UNDER_REVIEW → { AWAITING_CUSTOMER | ESCALATED }
     → RESOLVED_NO_ACTION | RESOLVED_REMEDIATED | CONFIRMED_VIOLATION
CONFIRMED_VIOLATION → APPEALED → APPEAL_REVIEW → { OVERTURNED | FINALIZED }
```

| State | Meaning |
|---|---|
| `OPEN` | Case created (from a correlated signal or an operator). |
| `TRIAGED` | An operator has set severity/category and (optionally) assigned it. |
| `UNDER_REVIEW` | Active investigation. |
| `AWAITING_CUSTOMER` | An information request is outstanding. |
| `ESCALATED` | Raised for higher authority (e.g. serious violation / termination). |
| `RESOLVED_NO_ACTION` | Reviewed; no violation. Temporary holds released. |
| `RESOLVED_REMEDIATED` | Platform/payment error remediated in the customer's favour. |
| `CONFIRMED_VIOLATION` | Evidence-supported finding recorded by an authorized reviewer. |
| `APPEALED` | Customer submitted an eligible appeal. |
| `APPEAL_REVIEW` | Appeal under independent review. |
| `OVERTURNED` | Appeal overturned the original decision (history preserved). |
| `FINALIZED` | Terminal state; no further routine transitions. |

Transitions are validated server-side; an invalid transition is rejected. Every
transition is audited with actor, reason code, and before/after.

## Severity (operational urgency, NOT guilt)

`INFO` `LOW` `MEDIUM` `HIGH` `CRITICAL` — derived from explicit signal/reason
categories, never a black-box score. Examples: new device → INFO/LOW; identity
mismatch → MEDIUM/HIGH; credible account takeover → CRITICAL; confirmed payout
duplication → HIGH/CRITICAL.

## Signals → case correlation

Not every low-level signal opens a case. Signals are ingested idempotently
(unique `(source, sourceRef, kind)`), then correlated to an existing OPEN/active
case for the same subject+family where safe, or opened as a new case. Correlation
is deterministic; a duplicate provider event does not create a second case.

## Signal vs finding

A **signal** may warrant attention (new device, IP change, KYC mismatch,
chargeback, correlated pattern). A **finding** is an evidence-supported conclusion
(`*_CONFIRMED`). A signal can never, by itself, terminate a customer — termination
requires a finding + an authorized action.

## Containment before finding

High-confidence safety actions (revoke sessions, step-up, temporary holds) may be
applied before guilt is established when credible money/security risk exists. This
is containment, not a conviction, and does not set `CONFIRMED_VIOLATION`.

## Decision immutability

Findings and no-action decisions are never deleted. Corrections are appended
(e.g. original `CONFIRMED_VIOLATION` + appeal `OVERTURNED`); the effective state
becomes overturned/remediated while both remain in history for audit.
