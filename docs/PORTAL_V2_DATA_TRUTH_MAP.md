# Portal V2 — Data Truth Map (Experience Layer additions)

Where each new/affected Portal V2 surface gets its data. (Prior surfaces documented in
PORTAL_V2_DATA_TRUTH_MAP history / PORTAL_V2_BILLING_ARCHITECTURE etc.)

## Progress & Achievements

| UI | Production source | Dev-review source |
|---|---|---|
| Hero (member since, lifetime paid, funded, evals, milestones, current/next club) | `GET /api/v1/portal/progress` → `progressForUser` | `FIXTURE_PROGRESS` / `FIXTURE_PROGRESS_EMPTY` |
| Timeline nodes | achievements + member-since + next club | fixture milestones |
| Trader clubs | `CLUB_MILESTONES` vs lifetime PAID trader-share | fixture clubs |
| Personal goals | `GET /api/v1/portal/goals` (+ CRUD) | local React state over fixture |
| Current focus | pinned ACTIVE goals | same |

All production values are authoritative server records scoped by `customerIdentityId`. The
dev harness never persists customer business data and no production container imports
fixtures.

## Dashboard "Your journey" strip

Production: derived from the same `progress` projection. Dev-review: `data.progress`
fixture. Shows lifetime paid + current club + remaining-to-next + milestones earned, links
to `/portal-v2/progress`.

## Clubs money definition (authoritative)

`lifetimePaidTraderShareMicros = sum(payout_requests.trader_share_micros) WHERE
state='PAID'`. Micro-dollars, integer. Formatter: `apps/web/src/portal/v2/format.ts`
(`formatMoney`). No float, no `$NaN`.

## Ownership / isolation

Goals and achievements are read/written only through `customerIdentityId` resolved from the
authenticated user; any cross-customer id resolves to `NOT_FOUND`. Verified in
`personal-goals.test.ts`.
