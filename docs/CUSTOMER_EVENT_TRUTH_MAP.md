# Customer Event Truth Map

Material business events, their producer, durability, idempotency, and operator
visibility. Events flow through `events.publish` (writes a `domain_events` outbox row,
then in-process subscribers) — see `apps/server/src/platform/events.ts`.

| Event | Producer | Idempotency | Consumers | Operator visibility |
|---|---|---|---|---|
| purchase verified | `markOrderCompleted` (webhook) | provider-event id + order idem key | fulfillment | Owner purchases / audit |
| account provisioned | `provisionAccount` | `provisioning_requests_key`, entitlement consume | Portal, Atlas, Dashboard | Owner account 360 / audit |
| provisioning blocked/failed | `setProvisionState` | status guard | recovery sweep, `entitlement.provisioning_*` events | Owner + `INV_STRANDED_PURCHASE` |
| evaluation passed | `commerce.ts` certifyEvaluation → `evaluation.qualified` | qualification unique (account,lifecycle) | funding, recognition (cert/achievement), goals reconcile | Owner / audit |
| funded account created | `approveFunding` | `fund:<qualId>` | Portal, Atlas, recognition | Owner / audit |
| payout requested | `requestPayout` | one request row | owner payout queue | Owner `/admin/payouts` |
| payout approved (debit) | `approvePayout` | ledger unique (request, DEBIT) | ledger, cycle | Owner / ledger |
| payout paid | `markPaid` → `payout.paid` | SETTLEMENT marker, idempotent | recognition (PAYOUT cert, FIRST_PAYOUT, PAID_*, clubs), goals reconcile, lifetime-paid | Owner / audit / reconciliation |
| account completed (5th cycle) | `markPaid` → `account.completed` | status guard | recognition (ACCOUNT_COMPLETED, FIVE_PAYOUT_CLUB) | Owner / audit |
| certificate issued | `recognition.ts` | `(org, dedupeKey)` | Certificate vault, notification | Owner certificates |
| support created | `submitTicket` | — | owner support inbox | Owner `/admin/ops/support/inbox` |
| support replied | `addMessage` | append-only | customer thread | Owner workspace |
| affiliate applied | `submitApplication` | per-user dedup | owner applications queue | Owner `/admin/ops/affiliates/applications` |
| achievement unlocked | `issueAchievement` | `(org, dedupeKey)` | Progress, notification | (derived from achievements) |

## Guarantees

- **Exactly-once**: certificates & achievements via unique `(org, dedupeKey)` +
  `onConflictDoNothing`; payout debit via unique `(request, entry_type)`; orders via
  idem key; provisioning via `provisioning_requests_key`.
- **Replay-safe**: duplicate/replayed verified-payment events converge to one
  account (proven in `commerce-chaos.test.ts`); duplicate lifecycle events do not
  unlock an achievement twice.
- **Deferred subscribers** (`recognition.ts`, notifications) run after the
  originating transaction commits (`setTimeout(0)`), swallow their own errors, and
  are idempotent — a subscriber failure never corrupts the originating event. A
  read-time reconcile (progress, tracked goals) is the recovery net.
