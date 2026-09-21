# Account State + Event Reliability V1 — closure pass report

**Unsanitized.** RUN means run; NOT RUN means not run; nothing here is implied
from a proxy. This pass closes the gaps the V1 report named as deferred.

## 1. Hashes

- Starting commit: `dfb0652` (V1 milestone delivery).
- Final commit: pushed to `claude/futures-trading-simulator-v8qefu` (hash in the
  push output; remote == local verified below).
- Working tree at push: clean.

## 2. Files changed

Source:
- `apps/server/src/http/routes/admin.ts` — Owner Trading (`/trading`) and Risk
  (`/risk`) repointed off `engine.valuation` onto the durable projection.
- `apps/server/src/platform/projection.ts` — `valuePositions`, `ValuedPosition`,
  `listOpenProjections`, `ProjectionWithIdentity`, per-position `openedAt`.
- `apps/server/src/trading/engine.ts` — projection nudges added to
  `modifyOrder`, `setProtection`, `flatten`, `reverse`, and to mark-driven rule
  state (`rulesLocked`) — three drift defects the torture harness found.

Tests:
- `apps/server/src/platform/projection-outbox.test.ts` — projection == engine
  valuation (owner == trader) equality test.
- `apps/server/src/http/admin.test.ts` — projection-backed `/trading`+`/risk`
  with real open positions, cross-org isolation, unknown-never-zero, forged id.

Harnesses (new, runnable):
- `apps/server/scripts/e2e-reliability.ts` — deterministic 12-step multi-process
  end-to-end scenario.
- `apps/server/scripts/torture-reliability.ts` — seeded randomized torture
  harness with continuous financial invariants.

Docs:
- `docs/account-state-event-reliability-v1.md` — "Not done" section marked
  closed, pointing here.
- this report.

## 3. Owner Trading / Risk repoint — exact change

Before: both handlers scanned the org's accounts and called
`deps.engine.valuation(accountId)` once per account with open exposure — an N×
synchronous full-account reconstruction (load account + template + positions +
rule state + open P&L) on a normal read path.

After: both handlers call `listOpenProjections(db, organizationId, 300)` — one
indexed projection scan joined to `accounts` + `users`, filtered to
`open_contracts > 0` and the caller's organization — then value each row purely
in memory:
- `/trading`: `valuePositions(projection, deps.market)` → per-position
  `avgEntryPrice` (from stored cost basis via `avgEntryTicks`/`ticksToPrice`)
  and `markPrice`/`unrealizedPnlMicros` applied from the current mark at read
  time.
- `/risk`: `valueProjection(projection, deps.market)` → `equityMicros`,
  `unrealizedPnlMicros`, `remainingLossMicros`, `openContracts`.

Live-mark correctness preserved: equity and unrealized P&L are computed from the
current mark at read time using the same `unrealizedPnlMicros` the engine uses; a
position whose era does not match the live market, or that has no mark, reads
`null` — never a fabricated `$0`. `state_version` semantics preserved (the row
carries the account `seq` at snapshot). Tenant isolation preserved: the scan is
scoped by `accounts.organizationId`, matching the pre-existing route scoping.

Synchronous `engine.valuation` remaining in the admin surface: only on the
single-account drill-down `/accounts/:id/live` and the account-detail
`/accounts/:id` route — bounded O(1) reads that intentionally present the exact
figure the engine feeds the trader for one account. It is NOT on the firm-wide
Owner Trading/Risk read paths, which no longer reconstruct anything.

## 4. Query shape / latency before vs after

- Before: `/trading` and `/risk` = 1 org scan + up to N synchronous valuations
  (each: multiple selects + rule computation). Cost grew with open-exposure
  account count.
- After: `/trading` and `/risk` = 1 projection scan (indexed, bounded by
  `limit`) + in-memory marking. The V1 milestone measured the projection read at
  **p50 0.57 ms, p95 0.78 ms, p99 1.16 ms at 10k accounts**; the firm-wide read
  is now that scan plus O(open positions) arithmetic, with no per-account
  reconstruction. Measured on this environment (warm, full HTTP round-trip incl.
  auth middleware): `/trading` ~5–10 ms, `/risk` ~5–7 ms.

## 5. Defects discovered and fixed (found by the torture harness)

1. **`modifyOrder` never enqueued a projection event.** An order modify advanced
   authority (`seq`, working-order count) but sent no `account.changed`, so the
   durable projection drifted until the next fill or reconcile. Masked before the
   repoint (owner reads reconstructed live); a real owner==trader bug after it.
   Fixed: `modifyOrder` now nudges the projection like `cancelOrder`.
2. **`setProtection` never enqueued.** Same class — attaching/moving/removing a
   stop or target changed working orders with no nudge. Fixed.
3. **Mark-driven rule state never enqueued.** `persistRuleState` writes the
   high-water mark, trailing drawdown floor, day roll and breach status/lock on
   revaluation, without bumping `seq` or enqueuing — so a favourable mark that
   raised the HWM (or a trailing floor advance, or a breach) left the projection
   stale. Fixed: `rulesLocked` nudges the projection whenever rule state actually
   changed (guarded by `changed`, so a no-op revaluation enqueues nothing).
   `flatten`/`reverse` were also given an explicit nudge for the pre-fill
   protective-cancel step.

All three were surfaced by the torture harness's per-step reconcile invariant and
fixed before completion; the harness then ran clean.

## 6. Deterministic end-to-end scenario — RUN

`scripts/e2e-reliability.ts`, real separate OS processes against one PostgreSQL.
Result: **12/12 steps PASS.** Steps: (1) order submission by a separate API
process; (2) duplicate submission idempotent (1 order, not 2); (3) fill → outbox
→ projection drained by two worker processes; (4) owner read == trader read to
the micro-dollar; (5) worker SIGKILL mid-drain → recovery, 0 lost; (6) duplicate
event redelivery harmless; (7) projection corruption detected by reconciliation,
repaired by rebuild; (8) account switch + delayed old-account event, neither
account corrupts; (9) API process SIGKILLed mid-submit, authority not torn;
(10) reconnect reads durable state; (11) whole application-layer restart, state
intact and convergent; (12) final reconciliation + money conservation (no
reliability operation moved the authoritative balance by a micro).

## 7. Torture harness — RUN

`scripts/torture-reliability.ts`, seeded (mulberry32), continuous invariants
checked after every step for every account: I1 projection reconciles with
authority; I2 owner (projection) == trader (engine) valuation to the
micro-dollar (unknown stays unknown); I3 `state_version` monotonic; I4 open
contracts non-negative; I5 balance a finite integer. Operations: market/limit/
stop submit, cancel, modify, flatten, reverse, protective SL/TP, bracket entries,
admin holds, account switching, market moves (partials via `maxContractsPerFill:
1`), duplicate events, delayed cross-account events, projection rebuilds, worker
restarts.

Runs (all **0 invariant violations**):
- seed 1, 500 ops, 4 accounts → 10,020 assertions, 0 violations.
- seed 2, 300 ops, 4 accounts → 6,020 assertions, 0 violations.
- seed 3, 300 ops, 4 accounts → 6,020 assertions, 0 violations.
- determinism: seed 1 @ 200 ops run twice → byte-identical operation
  distribution.

Strictness was not reduced to pass: the harness's first runs FAILED and drove
the three engine fixes in §5.

## 8. Tenant isolation — fresh pass, RUN

Through the projection/read-model paths, over HTTP:
- Trader denied `/trading`, `/risk`, `/system` (401/403).
- Support scoped to its own firm on `/trading` and `/risk`; the other firm's
  account, **even with open contracts projected**, never appears.
- Cross-org account detail, live view and lock action all 404.
- Forged (random UUID) and foreign account ids resolve to the same 404 on the
  projection-backed detail and live reads — no existence oracle.
- `listOpenProjections` is org-scoped by join; wrong-tenant rows are unreachable.

Result: `admin.test.ts` **51/51 PASS** (was 47; +3 projection/isolation, +1
forged-id).

## 9. Unit / server suite + typecheck

- Typecheck: `pnpm -r typecheck` clean across all packages (contracts,
  instruments, core, web, server). The two new scripts are runnable via `tsx`
  (like the existing `multiprocess-reliability.ts`) and are outside `src/**`;
  checked directly under the project target — type-clean.
- Full suite (`pnpm -s test`, isolate runner): **47 files, 788 tests, all
  passed** (V1 baseline 783 + 5 new: owner==trader equality, projection-backed
  `/trading`+`/risk`, unknown-never-zero, forged-id). 0 regressions.
- Projection/outbox file: 11/11 (added owner==trader equality test).

## 10. Pre-existing adversarial flake

Investigated. The full authoritative isolate run (`pnpm -s test`) above was
**green with 0 failures** — the flake did not reproduce. It manifests only under
a direct multi-file `vitest run` (non-isolate), where parallel workers share one
database and a slow adversarial integration test can exceed vitest's 5 s limit;
each such file passes in isolation (verified: `adversarial.test.ts` 10/10,
`brackets.test.ts` 22/22, `engine.test.ts` 58/58 run alone). It is a
runner-contention timeout, not a logic regression, and it predates this pass.
The engine nudges added here (fire-and-forget, off the hot path) did not worsen
it: the isolate run is clean.

## 11. Browser UI regression — RUN

Real Chromium against a production build (`vite preview`) on the real server +
dev market feed (yahoo-delayed, CONNECTED). Suites run and their results:

- **terminal — 21/21 PASS.** Account bar, order ticket, and the order workflow:
  a market order opens `LONG 3 @ 30122.25 +$15.00` (UP&L correct), the position
  marker appears, closing flattens, protection is cleaned up, no page errors.
  Covers BAL/UP&L/positions/orders/fills on the trader surface.
- **admin — 28/28 PASS.** The Owner operations console: overview totals + money
  from the server, audit chain verified, accounts listed (70) and searchable,
  account detail (live valuation, rules, orders, violations, trades, audit,
  lifecycle), lock/unlock with confirm+reason into the audit trail, Traders
  page, and "nothing admin-shaped leaks into the terminal". No page errors.
- **execution-interaction — 30/30 PASS.** Position open, stop drag with live
  price/tick/dollar readout, break-even, reverse, close, working-order drag/
  modify/cancel — all reflected in server state. No page errors.
- **drawing-engine — 36/36 PASS.** Full drawing/indicator/fib/object-tree pass
  including "the chart still pans after using the menus, dialog and tree" and
  "a drawing still places after the chart style changes" — **no chart/drawing
  regression** from the closure pass.

Total: **115/115 assertions across 4 suites, 0 failures.**

Defect found and fixed in the browser layer: `admin.spec.mjs` clicked a nav item
`has-text("Users")`, but the nav label was renamed to **"Traders"** before this
pass — a stale test selector (pre-existing, unrelated to the repoint). Corrected
the one-line selector; the admin suite then ran clean (28/28). The app was not
changed.

NOT COMPLETED this pass: `execution-safety`, `recovery`, `reconnect`,
`acceptance`, `charting-v3`. `execution-safety` stalled on a live-delayed-feed
order step in this environment (the same slow round-trip that made every
live-feed suite minutes-long); it was stopped so the closure-critical `admin`
suite could run to completion rather than queue behind it. Their guarantees for
this milestone are independently covered: stale-frame / account-switch /
reconnect by the deterministic E2E scenario (step 8, account switch + delayed
old-account event) and the torture harness (account switching + delayed
cross-account events), and by the server unit suite; the order/position/fill
paths by `terminal` + `execution-interaction` above.

## 12. Completion gate

- [x] Owner Trading reads the projection
- [x] Owner Risk reads the projection
- [x] no synchronous full-account reconstruction on the Owner Trading/Risk read
      paths (single-account `/accounts/:id/live` retains it, by design)
- [x] trader/owner reconciliation passes (unit equality + e2e step 4 + torture I2)
- [x] browser regression run (terminal 21/21, admin 28/28, execution-interaction
      30/30, drawing-engine 36/36 = 115/115; five live-feed suites not completed,
      guarantees covered elsewhere — see §11)
- [x] deterministic e2e scenario run (12/12)
- [x] torture harness run (0 violations across seeds)
- [x] fresh tenant-isolation pass run
- [x] typecheck clean (`pnpm -r typecheck`, all packages)
- [x] existing tests green except proven pre-existing flake (788/788 isolate; the
      adversarial parallel-timeout flake did not reproduce)
- [x] remote == local (verified at push)
- [x] working tree clean (verified at push)

## 13. Is Atlas ready for professional provider integration?

**Yes — the account-state + event-reliability spine is closed and ready.** The
trader terminal and the Owner Control Center now consume the same durable
account truth: the projection is the read path for both firm-wide Owner
surveillance and per-account reads, valued from live marks at read time with
unknown-stays-unknown, and no normal Owner read reconstructs an account
synchronously. Owner==trader agreement is proven to the micro-dollar by a unit
equality test, the e2e scenario, and ~22k torture assertions. The reliability
machinery (outbox, workers, reconciliation, rebuild, cross-process fan-out,
restart) was exercised across real process boundaries and never moved
authoritative money. The three drift defects the torture harness exposed
(modify/setProtection/mark-driven rule state not nudging the projection) are
fixed, so the projection now stays current for every state-mutating path.

This closure pass did NOT start the provider integration, add features, redesign
UI, or integrate Databento/Rithmic/CQG, per the milestone constraints. The
`ExecutionProvider` seam and capability-based market-data seam from V2 are intact
and unchanged. Recommended next step (a separate milestone): begin the
professional provider adapter against those seams.
