# Portal Metric Truth Map

Production customer portal is **V1** (`apps/web/src/portal`). Every dashboard/metric
derives from an owner-scoped `/api/v1/portal/*` endpoint; none is a React business
counter and none reads fixtures.

| Metric | Source endpoint | Derivation | Unit | State filter | Zero | Error |
|---|---|---|---|---|---|---|
| Active accounts | `/api/v1/portal/accounts` | `activeSlotsUsed` / `maxActiveSlots` (server) | count | consumes-slot (PENDING/ACTIVE/GOAL_REACHED/LOCKED) | "No active accounts" + CTA | error banner + retry (fixed) |
| Funded | `/api/v1/portal/accounts` | count FUNDED_SIM, non-completed | count | funded | 0 | via accounts fetch |
| Total accounts | `/api/v1/portal/accounts` | list length | count | all owned | empty vault | via accounts fetch |
| Payouts (count) | `/api/v1/portal/certificates` | count payout certs | count | issued | 0 | **degrades to 0 (KNOWN_ISSUE CPI-2)** |
| Account balance / P&L | `/api/v1/portal/accounts` + analytics | server `balance_micros`, engine P&L | micro-$ | per account | truthful | per-surface catch→err |
| Portfolio performance | `/api/v1/portal/accounts/:id/analytics` + trades | real executions; ranges slice real history | micro-$ | per/aggregate | honest empty | setErr |
| Payout lifetime/available/eligibility | `/api/v1/payouts/eligibility` | `payout-core.ts` server-authoritative | micro-$ | funded/eligible | 0 | setErr |
| Certificates | `/api/v1/portal/certificates` | real records only | — | owned | empty | setErr |
| Progress clubs (V2) | `/api/v1/portal/progress` | cumulative PAID trader-share | micro-$ | state='PAID' | truthful zeros | — |

## Semantics clarified

- **Money** is integer micro-dollars end to end; formatter `format.ts`/server never
  float. No `$NaN`/`-0`.
- **Net P&L** headline and the "Cumulative realized P&L" chart both read realized
  P&L from authoritative executions/account history.
- **Error vs zero** (spec §68/§182): the top-level accounts fetch now distinguishes
  a connection failure (error banner + retry) from a legitimate empty customer.
  Most page-level fetches already did (`setErr`). Remaining gap: the dashboard
  payout-count badge still shows 0 on fetch error — logged as CPI-2 (P2), not a
  fixture/ownership defect.
