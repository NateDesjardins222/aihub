# Account State + Event Reliability V1 — completion report

**Unsanitized.** NOT RUN means not run; SIMULATED means not real separate
processes; deferred means named, not hidden.

## 1–13. Facts

1. Starting commit: `57bfd5f`.
2. Final commit: pushed to `claude/futures-trading-simulator-v8qefu` (hash in the
   push output; remote == local verified).
3–4. Local HEAD == Remote HEAD at push.
5. Working tree: clean.
6. Files changed: migration `0013_account_projection_outbox`; new
   `platform/projection.ts`, `platform/outbox.ts`, `platform/account-notify.ts`,
   `execution/provider.ts` routing; `scripts/multiprocess-reliability.ts`,
   `scripts/projection-scale.ts`; wiring in `db/schema.ts`, `db/client.ts`,
   `http/app.ts`, `http/routes/trading.ts`, `ws/gateway.ts`,
   `trading/engine.ts`, `platform/account-service.ts`, `web/src/trading/store.ts`;
   tests `platform/projection-outbox.test.ts`, `platform/account-notify.test.ts`;
   seven docs.
7. Migrations: `0013` — `account_projections` (read model), `outbox_events`
   (delivery outbox). Additive; safe.
8. Tests before: 771 (baseline `57bfd5f`, isolate runner).
9. Tests after: **783** (isolate runner) — +12 (10 projection/outbox, 2
   cross-process notify). Plus two scripted harnesses (multi-process, scale).
10. Existing regressions: none. One adversarial test occasionally times out under
    the parallel runner (a slow integration test exceeding vitest's 5 s limit);
    it passes in isolation and predates this milestone. Not a logic regression.
11. New defects discovered: the outbox is a global table, so a naive test asserted
    globally and every engine test now writes outbox rows — fixed by scoping
    workers/stats to an aggregate id (also a real sharding feature). Projection
    `organization_id` had to be nullable to mirror `accounts`.
12. Defects fixed: both of the above, before commit.
13. Unresolved: none introduced.

## ACCOUNT STATE

- Authoritative model: Postgres columns (balance, realized, fees, positions,
  orders, drawdown, status, `seq`). Equity/UPL are DERIVED at read time; nothing
  derived is truth. Full inventory in `account-state-read-model.md`.
- Projection: `account_projections`, recompute-from-authority, idempotent,
  monotonic `state_version` (guarded upsert). Rebuildable.
- Stale state: a position that cannot be marked (no price / wrong `market_era`)
  reads unknown, never a fabricated zero; a stale client frame is dropped.
- Trader/owner consistency: both read authoritative state; the client applies
  live frames only for the current account and only if newer.

## OUTBOX

- Delivery: at-least-once + idempotent consumers.
- Claiming: `FOR UPDATE SKIP LOCKED`; handler + delivery mark commit atomically.
- Retry: backoff via `available_at`; dead-letter after `maxAttempts`.
- Crash: mid-tick death rolls back; rows reclaim (proven with real SIGKILL).
- Backlog: 5,000 events drained at 272 events/sec at 10k accounts; 0 lost.

## RECONCILIATION

- Checks: stateVersion, balance, realized, fees, HWM, drawdown floor, status,
  admin hold, rule status, open contracts, working-order count.
- Corruption tests: a wrong balance + version is detected; rebuild-from-authority
  repairs it; a missing projection reports as drift.
- Rebuild: touches no financial truth. 10,070 accounts reconciled: **0 drift**.

## MULTI-PROCESS (real, not simulated)

`scripts/multiprocess-reliability.ts`, actual separate OS processes:
- [1] SKIP LOCKED: 4 worker processes / 200 events → 200 processed, 200 distinct,
  0 pending, ~1.8 s.
- [2] Crash recovery: a worker SIGKILLed mid-drain → 120/120 delivered once.
- [3] Advisory lock: 3 processes × 50 increments → counter 150 (no lost update).
Races covered here and in the unit suite: duplicate delivery, worker-vs-worker
claim, hold-vs-order/reset-vs-order (V2 admin suite + account lock). Not
assembled as one scripted 50-step scenario (see below).

## FAILURE INJECTION

Real: worker SIGKILL mid-drain (recovered). By design + per-mechanism proof:
commit-then-die (outbox transactional), projection delete (rebuild), Redis down
(N/A — unused). NOT RUN as scripted scenarios: API-process kill with live trader
failover; whole-application-layer restart with post-restart verification.

## SCALE

- Accounts: 10,070 (real fixtures). Active load exercised: 5,000 outbox events +
  1,000 projection reads. (A sustained live-trading subset of ~1,000 was not run
  as a separate load generator; the outbox drain is the throughput proxy.)
- Projection read: **p50 0.57 ms, p95 0.78 ms, p99 1.16 ms**.
- Rebuild: 263 accounts/sec. Backlog drain: 272 events/sec. Reconcile: 0 drift.

## TORTURE

No dedicated randomized deterministic-seed torture harness was built this
milestone (**NOT RUN**). Its invariants are covered piecewise: idempotency,
SKIP-LOCKED exactly-once, reconciliation, crash recovery (multi-process harness),
and the V2 execution torture. Named here rather than implied.

## SECURITY / TENANT ISOLATION

The projection and outbox add **no new HTTP surface** (the projection is internal;
owner reads still go through the existing org-scoped admin routes). The projection
row carries `organization_id`/`user_id` for future scoping. A fresh hostile pass
through a projection-backed endpoint was **NOT RUN** because no such endpoint was
exposed this milestone; V2 isolation results stand.

## EXECUTION PROVIDER

Migrated to the seam: submit, cancel, cancel-all, modify, flatten, reverse (the
`/api/v1/orders` + position routes). Still on the engine directly (by design, not
a venue's concern): marking, valuation, rule enforcement, bracket/SL/TP
protection.

## REDIS

Not used. PostgreSQL transactional outbox + SKIP LOCKED + LISTEN/NOTIFY + durable
projection meet every requirement here. Introducing Redis would add a second
store that could disagree with the database. It would be justified only by a
demonstrated need Postgres cannot meet; Atlas is not there.

## UI

Trader/owner terminals were not modified except the client store's
monotonic/account-switch guards. Full browser UI regression: **NOT RUN** this
milestone. The order path (now routed through the provider) was validated by the
783-test suite and a live REST end-to-end: an order → 2 outbox events delivered
(0 pending) → projection at the account's current `state_version`.

## LATENCY

Measured: projection read p50 0.57 ms; advisory-lock overhead p50 0.35 ms (V2).
NOT MEASURED end-to-end this milestone: request→commit, commit→outbox-available,
outbox→projection, projection→WS publication as a single instrumented budget
(the components' latencies are the read and drain figures above).

## Completion gate

- [x] durable operational projection  [x] trader & owner consume consistent state
- [x] projection stateVersion  [x] reconciliation  [x] corruption detected
- [x] projection rebuild  [x] outbox worker  [x] multi-worker safe
- [x] duplicate delivery harmless  [x] worker crash recovery (real SIGKILL)
- [x] cross-process distribution  [x] actual separate-process test
- [x] execution routing audited/completed (order flow)  [~] account-switch stale
  race (client guard added; browser test NOT RUN)
- [x] 1K test  [x] 10K test  [x] active-account load (via backlog+reads)
- [x] failure injection (worker; others deferred)  [ ] torture harness (NOT RUN)
- [ ] scripted 50-step e2e (NOT RUN; pieces proven separately)
- [~] tenant isolation (no new surface; fresh pass NOT RUN)  [x] financial
  invariants (suite)  [ ] browser regression (NOT RUN; REST e2e + suite instead)
- [x] typecheck  [x] working tree clean  [x] remote == local

## A–J

- **A. Two instances on one account safely?** Yes — advisory lock proven across
  real processes; transactional writes; outbox SKIP LOCKED. (Cross-process WS
  fan-out via NOTIFY is built; a full two-instance live-socket scenario is
  covered piecewise, not as one scripted run.)
- **B. Outbox worker die without losing state?** Yes — proven with a real SIGKILL;
  the claim's transaction rolls back and another worker finishes.
- **C. Event delivered twice without duplicate effect?** Yes — idempotent
  recompute-from-authority; proven by test.
- **D. Projection destroyed and rebuilt?** Yes — `rebuildAllProjections` from
  authority; proven; 0 drift after rebuild at 10k.
- **E. Trader UI and Owner converge on the same truth?** Yes — both derive from
  the same authoritative state / projection; consistency is by construction. The
  owner route repoint to the projection is deferred (still correct via valuation).
- **F. 10k accounts without per-request synchronous reconstruction?** Yes — the
  projection read is p50 0.57 ms; owner reads can hit it instead of N valuations
  (the repoint of the specific handlers is the remaining wiring).
- **G. Tradable contract identity preserved through execution and projection?**
  Yes — `contract_code` on orders/executions/trades (V2); the projection keys and
  positions carry symbol/era; identity is not lost.
- **H. Ready for a professional market-data provider?** Yes — the capability-based
  seam already exists (V2); unchanged and intact.
- **I. Ready to BEGIN a Rithmic/CQG execution adapter without rewriting the API?**
  Yes — order flow now routes through `ExecutionProvider`; a new adapter
  implements the interface. (Bracket/protection routes would also need the seam
  extended when a live venue supports them.)
- **J. Largest remaining infrastructure risk?** The owner Trading/Risk read
  handlers still recompute synchronously — the projection exists and is fast but
  is not yet the path those endpoints use, so the 10k-owner-read win is proven in
  measurement but not yet wired into the product surface. Repointing them (with a
  browser regression pass) is the highest-value next step.
