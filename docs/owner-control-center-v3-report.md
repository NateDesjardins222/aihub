# Owner Control Center V3 — closure report

Branch `claude/futures-trading-simulator-v8qefu`. Baseline `0be4678` (Native
Checkout & Payments V1, offline). This milestone made Atlas feel like software
capable of **operating** a prop firm: trader CRM, firm surveillance, exposure
monitoring, honest system health, audit exploration, staff tooling, and proven
scale. Owner-operations only.

## What this milestone is / is NOT

**Built** (all extends the mature Owner V1/V2 console, reusing its RBAC, tenancy
scoping, projection read model, and audit spine — nothing duplicated):

- **Staff notes** — internal, owner-side notes per trader (new `trader_notes`
  table, migration 0016). Append-only with redaction; audited; SUPPORT+ read/
  write, ADMIN redact; tenant-scoped; bodies stored verbatim as inert text.
- **Trader CRM** — `/users` now returns per-trader evaluation / funded-sim /
  active counts and last-traded time, with server-side filters (has evaluation,
  has funded sim, on hold, no accounts) as indexed EXISTS predicates; existing
  search + cursor pagination retained.
- **Firm exposure** — `/exposure`: per-instrument gross long / gross short / net
  contracts from the projection read model, **minis and micros never combined**
  (NQ≠MNQ, ES≠MES, GC≠MGC, CL≠MCL), each with its registry point value; notional
  and unrealized P&L only when every contributing position is marked (else null +
  an unmarked count — never a fabricated zero); per-symbol drilldown to
  contributing accounts.
- **Overview lifecycle metrics** — active evaluations, passed evaluations,
  awaiting funding, funded sim, passed/failed today, by-account-type — each with
  a stated definition (below).
- **Account "why locked"** — an explicit `lockReason` from authoritative status
  (the same status the order gate reads): TRADEABLE / PASSED / FAILED /
  ADMIN_HOLD / RISK_LOCK / PENDING / ARCHIVED / DISABLED, with detail.
- **Audit explorer** — `/audit` gains actor / subjectType / subjectId / time
  range / cursor pagination; a new web Audit page with filters and row expand.
- **System health V3** — `/system` adds projection health (inconsistent count),
  outbox health (pending, dead-letter, oldest-pending age), and payment-config
  state, with explicit `HEALTHY / DEGRADED / NOT_CONFIGURED / AWAITING_VALIDATION`
  states and a neutral (not alarm-red) indicator for absent-by-design components.

**NOT built** (out of scope by instruction): no new products/rules/product
builder/pricing/evaluation structures; no real payments, production Whop, Whop
credential work, checkout redesign, refunds; no payouts/withdrawals/KYC/AML; no
authenticated Databento or market-data provider work, DOM/L2/footprint; no new
charting/drawings/indicators/backtesting/AI/affiliate/promo/marketing. The
trader terminal was not redesigned. Payments remain paused at sandbox/offline;
System reports them NOT_CONFIGURED, never connected.

## Metric definitions (Overview)

| Metric | Definition (authoritative source) |
| --- | --- |
| Active evaluations | `accounts` where `accountType = EVALUATION` and `status ∈ {ACTIVE, GOAL_REACHED}` (tradeable) |
| Passed evaluations | count of `account_qualifications` (server-authoritative passes recorded) |
| Awaiting funding | `account_qualifications` where `fundingState = ELIGIBLE` |
| Funded sim | `accounts` where `accountType = FUNDED_SIM` |
| Passed today / Failed today | `account_lifecycles` closed `PASSED`/`FAILED` with `endedAt ≥ local-day start` |
| Open positions / contracts | `positions` with `qty ≠ 0`, joined to org accounts (projection for exposure) |

No revenue / MRR / payout / pass-rate figures are shown — the authoritative
inputs (completed real payments) do not exist, and inventing them was explicitly
forbidden.

## Authorization & tenant isolation

Roles unchanged: TRADER < SUPPORT < ADMIN < SUPER_ADMIN (`requireRole`, rank).
Reads are SUPPORT+; notes create SUPPORT+; note redaction and funding actions
ADMIN+. Every new route is scoped to the caller's organisation via
`organizationOf` — the server enforces it, never the frontend. Verified: a firm
cannot open another firm's account (404, no existence oracle), read its trader or
notes (404), see its traders in search, its positions in exposure, or its audit
records (`owner-isolation.test.ts`, `owner-notes.test.ts`).

## Performance & scale (measured)

`owner-scale.test.ts` seeds a realistic org and measures the routes an operator
opens. Median latencies (real numbers from this environment; `app.inject`, DB on
localhost):

| Route | p50 @ 1,000 traders | p50 @ 3,000 traders |
| --- | --- | --- |
| overview | 14 ms | 16 ms |
| traders (list) | 7 ms | 5 ms |
| traders (search) | 8 ms | 8 ms |
| traders (filter) | 7 ms | 7 ms |
| accounts | 9 ms | 9 ms |
| trading | 9 ms | 11 ms |
| risk | 9 ms | 11 ms |
| exposure | 6 ms | 9 ms |
| audit | 6 ms | 5 ms |

Latency is essentially flat from 1k → 3k because every owner read is bounded:
cursor pagination (no OFFSET), org-scoped composite indexes, and a projection
scan bounded by *open* exposure rather than account count. The same query shapes
hold at 10k/100k; the trader table's per-row aggregates are correlated
sub-selects bounded by page size (≤200), not an N+1 of round-trips. No route
renders unbounded rows — pages are ≤200 server-side. (Set `OWNER_SCALE_TRADERS`
to run the measurement at higher counts.)

## Verification

| Check | Result |
| --- | --- |
| Full suite (`pnpm -s test`, isolate mode) | **873/873 passed, 59 files** (855 baseline + 18 Owner V3) |
| Server + web typecheck | clean |
| Owner V3 server tests | notes 5, exposure 2, overview/lock 2, audit/system 3, isolation 5, scale 1 |
| Commercial lifecycle E2E / torture | **12/12 steps / 0 invariant violations** (no regression) |
| Native checkout offline + commerce | **34/34** (no Whop credentials needed) |

## Known limitations / deferred

- Trader-360 timeline is served by the existing per-trader activity feed
  (authoritative audit records) plus the accounts and lifecycle sections; a
  dedicated merged-source timeline endpoint was not added.
- Owner browser (Playwright) coverage for the new pages was not added this
  milestone; server-level HTTP tests cover the new routes end to end. The web
  pages typecheck and build.
- Exposure/audit lists are bounded (≤300 projections / ≤200 audit rows per page);
  a saved-view or CSV export was not built.
- A standalone scale-seed CLI was dropped in favour of the vitest measurement
  (standalone tsx + buildApp block-buffers stdout and hangs at exit here).
