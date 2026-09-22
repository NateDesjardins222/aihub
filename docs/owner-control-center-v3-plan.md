# Owner Control Center V3 — autopsy and plan

Branch `claude/futures-trading-simulator-v8qefu`. Baseline `0be4678` (Native
Checkout & Payments V1, offline). Databento paused; Whop paused at sandbox.

Goal: make Atlas feel like software capable of **operating** a serious prop
firm — trader CRM, firm surveillance, exposure, analytics, audit explorer,
support tooling, honest system health, and scale to 10,000+ traders. This is an
owner-operations milestone. **No trader-facing features, no new products/rules,
no payments/payouts, no market-data or charting work.**

---

## What already exists (do not rebuild — extend)

The Owner Control Center is mature (Owner V1/V2). Server: `http/routes/admin.ts`
(SUPPORT to read, ADMIN/SUPER_ADMIN to mutate; every route scoped to the
caller's organisation via `organizationOf`). Web: `apps/web/src/admin/` — its
own lazy bundle, pathname router (`AdminApp.tsx`), shared components
(`shared.tsx`), api client (`api.ts`), pages under `pages/`.

| Concern | State | Where |
| --- | --- | --- |
| Nav + routing (Overview/Traders/Accounts/Trading/Risk/Funding/Products/System) | EXISTS | `admin/AdminApp.tsx` |
| Overview metrics + recent audit activity | EXISTS (money-heavy) | `admin.ts /overview` |
| Users list: search (email/name), **cursor pagination**, account count | EXISTS | `admin.ts /users`, `pages/UsersPage` |
| User detail: accounts, activity, trades | EXISTS | `admin.ts /users/:id`, `pages/UserPage` |
| Accounts list: search, status filter, cursor pagination | EXISTS | `admin.ts /accounts`, `pages/AccountsPage` |
| Account detail: summary, rules, lifecycles, orders, fills, positions, violations, trades, audit, **commercial linkage** | EXISTS | `admin.ts /accounts/:id`, `pages/AccountPage` |
| Trading surveillance: open positions/working orders/recent fills from **projection read model** (marks applied at read, unknown stays unknown) | EXISTS | `admin.ts /trading`, `pages/TradingPage` |
| Risk: nearest loss limit, largest unrealized loss, on hold, recent failures (projection-valued) | EXISTS | `admin.ts /risk`, `pages/RiskPage` |
| Funding queue + approve/decline + manual grant | EXISTS (Commercial V1) | `admin.ts /funding-queue …`, `pages/FundingPage` |
| Audit list (accountId/userId/action filters) + chain verify | EXISTS | `admin.ts /audit`, `/audit/verify` |
| Domain events list | EXISTS | `admin.ts /events` |
| System health: db, market data (honest DELAYED/DEGRADED/OFFLINE), audit chain | EXISTS | `admin.ts /system`, `pages/SystemPage` |
| Owner actions: activate/lock/unlock/disable/enable/archive/reset | EXISTS (advisory-locked, audited) | `platform/account-service.ts` |
| Durable read model: `account_projections`, `valueProjection`, `valuePositions`, `listOpenProjections` | EXISTS | `platform/projection.ts` |
| Outbox: `outbox_events`, `OutboxWorker`, `outboxStats` | EXISTS | `platform/outbox.ts` |
| Instrument registry (mini/micro multipliers) | EXISTS | `@atlas/instruments` |
| RBAC: TRADER<SUPPORT<ADMIN<SUPER_ADMIN, `requireRole(min)` | EXISTS | `http/auth-plugin.ts` |
| Hash-chained audit (`recordAudit`, `verifyAuditChain`) | EXISTS | `platform/audit.ts` |

## What is missing (net-new in V3)

- **Staff notes.** No internal per-trader notes table. → new `trader_notes`
  (append-only, authored, categorised, audited, SUPPORT+ only, tenant-scoped).
- **Trader 360 timeline.** No single chronological operational timeline. →
  synthesised from audit + qualifications + lifecycles (authoritative sources).
- **Firm exposure by symbol.** Trading shows positions but no exposure
  aggregate. → `/exposure`: gross long / gross short / net **per instrument**,
  minis and micros **never** aggregated (NQ≠MNQ), with per-symbol drilldown to
  contributing accounts.
- **Overview lifecycle metrics.** Overview is money/volume-heavy; missing active
  evaluations, passed, awaiting funding (ELIGIBLE qualifications), FUNDED_SIM
  count, failed-today, by-accountType. → extend `/overview`.
- **Audit explorer UI + richer filters.** Audit API lacks actor/subjectType/
  time-range/cursor; no web page. → extend `/audit`, add `pages/AuditPage`.
- **System V3 health.** Missing projection/outbox health, payment-config state,
  explicit `NOT_CONFIGURED`/`UNKNOWN` states. → extend `/system`.
- **Account "why locked".** Lock reason is inferable but not explicit. → add a
  computed `lockReason` to account detail.
- **Trader table enrichment + filters.** No eval/funded counts, last activity,
  or lifecycle filters on the list. → extend `/users`.
- **Scale seeding + measured perf** at 100/1k/10k. → `scripts/seed-owner-scale.ts`,
  measured route latencies in the report.

## What should NOT be duplicated

- The projection read model is the ONLY source for firm positions/valuation —
  never reintroduce per-account engine valuation loops (the reliability
  milestone removed them). Exposure and risk read `listOpenProjections`.
- Rule semantics live in `@atlas/core` + `account-rules.ts`; do not add a second
  risk engine — reuse `valueProjection`'s `remainingLossMicros`.
- Account mutation goes through `account-service.ts` (advisory-locked, audited,
  idempotent) — owner actions call it, never raw updates.
- Cursor pagination + `organizationOf` scoping already exist — reuse for every
  new list.
- Instrument multipliers come from `@atlas/instruments` — never hardcode.

## Plan (vertical slices, each backend + web + test, committed)

1. **Staff notes** — migration + `platform/notes.ts` + routes + Trader-360 UI +
   audit + role/tenant/XSS tests.
2. **Trader 360** — `/users/:id/timeline` synthesis + enriched `/users` (counts,
   filters, last activity) + UserPage timeline/notes sections.
3. **Firm exposure** — `/exposure` (per-instrument gross/net, mini/micro-correct)
   + drilldown + web section; instrument-multiplier test.
4. **Overview V3** — lifecycle metrics + time windows + activity feed extension.
5. **Account detail V3** — explicit `lockReason`.
6. **Audit explorer** — richer `/audit` + `pages/AuditPage`.
7. **System V3** — projection/outbox/payment/market honest health.
8. **Scale + perf** — seed script, measured latencies, index review.
9. **Tests + torture + isolation + regression** — `scripts/torture-owner-operations.ts`,
   tenant-isolation suite, run existing E2E/torture/offline-payment/execution
   regressions; docs `owner-control-center-v3-report.md` + `owner-operations-runbook.md`.

## Constraints carried

PostgreSQL is the only financial truth; never fabricate `$0`/`—` for unknown
marks. Do not weaken tenant isolation. Do not reduce test strictness or fake
results. No model identifiers in commits/PRs/code. Push to
`claude/futures-trading-simulator-v8qefu`; verify remote==local.
