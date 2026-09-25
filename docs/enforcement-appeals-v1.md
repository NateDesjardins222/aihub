# Enforcement Appeals (V1)

Customers may appeal eligible **final adverse decisions**. An appeal is a fresh
review layer; it never edits the original decision — both remain in history.

## Eligibility

An appeal is eligible when the case has a recorded adverse finding
(`CONFIRMED_VIOLATION` with a punitive finding/action) that policy marks appealable
and no appeal is already open for it. No-action resolutions, temporary containment,
and rule-breach outcomes (MLL, consistency, Daily progression) are **not** adverse
enforcement decisions and are not appealed through this path.

## Appeal lifecycle (`appeals`)

```
ELIGIBLE → SUBMITTED → UNDER_REVIEW → { INFORMATION_REQUESTED → UNDER_REVIEW }
        → { UPHELD | OVERTURNED | PARTIALLY_REMEDIATED } → CLOSED
```

Fields: `id`, `caseId`, `originalDecisionRef`, `customerStatement`, `status`,
`submittedAt`, `reviewerUserId?`, `decision?`, `decisionAt?`, `customerSafeExplanation?`,
`version`, audit metadata. Decisions are recorded in `appeal_decisions` (append-only).

## Independence guard (four-eyes)

Where staffing/RBAC allows, an appeal is not decided solely by the same reviewer who
made the original serious adverse decision:

- The original decider's user id is preserved on the finding/decision.
- The appeal decider's user id is preserved on the appeal decision.
- The server **blocks** a same-reviewer final appeal decision for serious
  violations unless a higher-authority (SUPER_ADMIN) override is explicitly recorded
  with a reason. The block is enforced server-side, not just in the UI.

## Decision immutability

The original decision is immutable. An overturn appends an `OVERTURNED` decision and
sets the case effective state to overturned/remediated; the original
`CONFIRMED_VIOLATION` still shows in the timeline. A `PARTIALLY_REMEDIATED` outcome
records exactly what was remediated (via ledger-safe primitives only).

## Customer experience

The trader sees: reference id, status, submitted date, customer-safe explanation,
any information request + deadline, and the final customer-safe outcome. The trader
never sees internal rationale, thresholds, evidence classified INTERNAL/LEGAL, other
customers, or reviewer identities.

## RBAC

- Submit appeal: the owning customer only (ownership-checked; no IDOR).
- Review/decide appeal: `ADMIN`; final denial of a serious violation and any
  same-reviewer override: `SUPER_ADMIN`.
