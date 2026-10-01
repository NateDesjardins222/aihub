# Progress — Event & Truth Map

Every figure on the Progress surface, with its single authoritative source. Nothing is
computed in the client; nothing is fabricated.

| Surface value | Authoritative source | Notes |
|---|---|---|
| Member since | `customer_identities.created_at` | null → hero shows generic subtitle |
| Lifetime paid (hero, clubs, tracked payout goal) | `sum(payout_requests.trader_share_micros) WHERE state='PAID'` via `cumulativeTraderShareMicros` | PAID only; trader share, not gross |
| Funded accounts | `count(account_qualifications WHERE funding_state='FUNDED')` joined to caller's `accounts` | |
| Evaluations passed | `count(account_qualifications)` for the caller's accounts | one immutable row per pass |
| Milestones earned | `count(achievements)` for the identity | |
| Current / next club | `CLUB_MILESTONES` vs lifetime paid | inclusive threshold |
| Timeline nodes | `achievements.earnedAt` (+ member-since start node + NOW + next-club "ahead") | |
| Club achieved-at | the club achievement row's `earnedAt` | |

## Event flow (derivation)

```
commerce / payouts / lifecycle services
  → events.publish(domainEvents row, then in-process subscribers)
    → recognition.ts (deferred setTimeout(0), idempotent, error-swallowing):
        evaluation.qualified → EVALUATION_PASSED cert; reconcilePersonalGoals
        account.funded       → FUNDED cert+achievement; reconcilePersonalGoals
        payout.paid          → PAYOUT cert; FIRST_PAYOUT; PAID_* ; club achievements+certs; reconcilePersonalGoals
        account.completed    → ACCOUNT_COMPLETED + FIVE_PAYOUT_CLUB
```

All achievement issuance is exactly-once via `(organizationId, dedupeKey)`. Duplicate or
replayed events converge; a crash between event and subscriber is recovered because
`progressForUser` / `listPersonalGoals` reconcile tracked goals at read time too.

## Determinism / idempotency guarantees

- Achievements: unique dedupe index + `onConflictDoNothing`.
- Tracked goals: `reconcilePersonalGoals` completes via `UPDATE ... WHERE status='ACTIVE'`,
  so a goal is stamped COMPLETED exactly once regardless of how many events/reads fire.
- Clubs: pure function of PAID trader-share; recomputable, no stored drift.

## Owner dependency (deferred)

Progress/club truth is already visible to operators through existing achievement and
payout-ops surfaces. A dedicated owner "customer journey" view is **deferred** (out of
scope this phase); no Owner Console changes were made.
