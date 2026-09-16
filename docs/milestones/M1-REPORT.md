# Milestone 1 — status report

**Scope:** repository architecture, database, instrument registry, authentication, terminal shell.

## What works

| Capability | Evidence |
| --- | --- |
| pnpm workspace, TS strict, Vitest | `pnpm typecheck` and `pnpm test` pass |
| Instrument registry for all 8 Phase 1 products | 47 tests; tick/point/multiplier verified per product |
| Tick + micro-dollar integer arithmetic | round-trip and P&L tests across NQ/ES/GC/CL |
| Exchange session calendar (DST, holidays, early closes, overnight) | tests assert Globex boundaries in exchange-local time |
| Contract roll calendar (front month per listing cycle) | NQU26 → NQZ26 roll asserted; energy and metals cycles differ |
| PostgreSQL schema, 17 tables, generated migration | `db:migrate` applied against PostgreSQL 16 |
| Configurable prop rule templates | 6 seeded products incl. 3 distinct drawdown types |
| Registration / login / refresh rotation / logout / me | verified end to end over HTTP |
| scrypt password hashing, constant-time verify | `auth/password.ts` |
| Instruments + accounts REST API | verified end to end |
| Terminal shell: header, drawing rail, chart region, right panel, activity panel | rendered in Chromium, screenshot captured |
| Resizable + collapsible panels that remember their size | localStorage-backed, drag verified |
| Session restore across refresh | refresh token persisted, `boot()` restores |

## What is deliberately not implemented yet

Every one of these is rendered as a labelled placeholder naming its milestone, never as a
control that looks live and does nothing:

- Market data feed, quotes, candles (M2)
- Chart engine, timeframes, scales, crosshair (M3)
- Drawings, indicators, saved layouts (M4)
- Execution engine, orders, positions, P&L (M5)
- Order submission, chart trading, drag-to-modify (M6)
- DOM / price ladder (M7)
- Live risk, drawdown and consistency evaluation (M8)

## What remains mocked

Nothing is mocked. Numbers shown are real database values; fields the engine does not yet
compute (open P&L) are explicitly `0` with the feature labelled, not filled with fiction.

## Known issues

1. `nextOpen()` scans forward a minute at a time. Correct but O(minutes); it should use a
   coarse-then-fine scan before it is called on a hot path.
2. The holiday calendar covers 2025–2027 only. `holidayCalendarCoverage()` exposes the range;
   a staleness check should be added before it is relied on in production.
3. Rate limiting is registered but not yet applied per-route to order endpoints (no order
   endpoints exist yet — this is M5 work).
4. The Practice 100K product has a `$0` drawdown floor because its configured max loss equals
   its account size. Correct given the configuration, but worth a validation rule.

## Required before Milestone 2

- Nothing blocking. The `MarketDataProvider` interface is specified in contracts and the
  normalization/bus/store layers can be built directly on it.
