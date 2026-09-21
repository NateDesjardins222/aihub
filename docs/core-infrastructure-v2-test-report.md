# Core Infrastructure V2 — completion report

**Not sanitized.** Where something was not run, it says NOT RUN. Where behaviour
was simulated rather than tested with separate OS processes, it says SIMULATED.
Where work was deferred, it says so and why.

## 1–5. Commit, hashes, tree, files

- Starting commit: `66e2aa8`.
- Final commit: recorded in the chat summary at push (remote == local, verified).
- Working tree: clean at push.
- Files changed: `packages/instruments/src/identity.ts` (+ index export);
  `apps/server/src/trading/account-lock.ts`, `engine.ts`,
  `distributed-correctness.test.ts`, `contract-identity.test.ts`;
  `apps/server/src/execution/provider.ts` + `provider.test.ts`;
  `apps/server/src/platform/account-service.ts`; `apps/server/src/db/client.ts`,
  `schema.ts`; `apps/server/src/http/app.ts`; migrations `0012_contract_identity`;
  seven `docs/*.md`.

## 6. Architecture changes

Account mutations serialize through a PostgreSQL advisory lock (engine +
account-service). Account transitions are transactional with a `FOR UPDATE`
re-read. Contract identity is a first-class model, persisted on orders/fills/
trades. An execution-provider seam exists, satisfied by the simulator.

## 7. Database migrations

`0012_contract_identity`: nullable `contract_code` on orders/executions/trades +
contract indexes. Additive and safe; existing rows keep `null`.

## 8. Contract identity

`RootInstrument` / `TradableContract` / `ContinuousSeries` / `ProviderInstrument`
+ `ContractResolver` (deterministic, listing-cycle-derived). Persisted on the
execution-bearing tables. See `contract-identity.md`.

## 9. Distributed correctness mechanism

In-process `KeyedMutex` fast path + `pg_advisory_lock(classid, objid)` on a
dedicated lock pool (engine, session form) and `pg_advisory_xact_lock` (account
-service, transaction form) on the same key. See `distributed-correctness.md`.

## 10. Remaining single-process assumptions

- WebSocket fan-out is in-process (engine callbacks). A second instance would not
  broadcast another instance's fills. **Not addressed.**
- The outbox has no delivery worker; in-process event subscribers only. **Not
  addressed.**
- Engine coalescing maps (`working`, `track`) are per-process and rebuilt from
  the DB on restart; they are optimisations, not truth.

## 11. Account read-model architecture

**Deferred / NOT BUILT.** Authoritative state is the engine's `valuation()`;
owner Trading/Risk value synchronously. Prerequisites are now in place. See
`account-state-read-model.md`.

## 12. Reconciliation results

**NOT RUN** — there is no projection to reconcile (see 11).

## 13. Provider abstraction

Market data: capability-based seam already existed; documented. Execution: new
`ExecutionProvider` + `AtlasSimulationExecutionProvider`, unit-tested. No live
provider implemented or faked. Routing all call sites through the interface is
deferred. See `provider-abstraction.md`.

## 14. Execution abstraction

`execution/provider.ts`; 3 tests (capabilities, submit+state, flatten) green.

## 15. Event reliability behaviour

Idempotency (orders, provisioning) intact; audit chain hash-linked, advisory-
locked, append-only, verifiable; account-service outbox write now transactional
with its mutation. Delivery worker, cross-process fan-out, duplicate-delivery and
consumer-restart tests: **NOT BUILT / NOT RUN** (no consumer yet). See
`event-reliability.md`.

## 16. Redis failure behaviour

N/A — Redis is not used; no financial truth depends on it. Documented, not coded.

## 17. Multi-worker race results

`distributed-correctness.test.ts`, across independent connections (SIMULATED
separate processes — advisory locks are connection-scoped, so this is the exact
cross-process condition, but genuine OS processes were not spawned):
- no lost update under a guarded racy read-modify-write;
- different accounts run concurrently;
- lock released on throw;
- exactly one of five simultaneous holds wins, four refused.
Also `admin.test.ts` (from V2): ten concurrent product publishes yield unique,
contiguous versions; concurrent holds keep the audit chain verifiable.

## 18. Scale-test results

No new scale test this milestone. The V2 scale work (1k/10k trader fixtures,
keyset pagination, measured list/search latency) stands. Projection/read-model
scale: **NOT RUN** (not built).

## 19. Latency p50/p95/p99

Measured this milestone: **advisory-lock acquire+release** (reserve + lock +
unlock), 300 runs against Postgres — **p50 0.35 ms, p95 0.52 ms, p99 1.44 ms**.
This is the per-mutation cost the cross-process lock adds; sub-millisecond.
Order-mutation end-to-end, market-normalization, WebSocket-publication and
projection latency: **NOT MEASURED this milestone** (owner-read latency was
measured in the V2 report).

## 20. Torture-test operations completed

No new dedicated infrastructure torture harness was built this milestone.
**NOT RUN.** The V2 execution torture (40-op combined run, 0 invariant failures)
stands as the most recent completed run.

## 21. Financial invariant results

The full suite exercises the financial invariants (P&L reconciliation per
instrument, position/fill consistency, drawdown, market-era pricing, no
cross-account/tenant bleed). **771 tests green** (see 23). No invariant
regression from the lock or contract-identity changes.

## 22. Security / isolation results

No new hostile isolation pass this milestone; the V2 isolation results stand
(cross-user/cross-org reads and mutations refused 404/403; forged tokens 401).
Contract identity and the account lock add no new cross-tenant surface — the lock
is keyed by account id and org scoping is unchanged. Dedicated re-test:
**NOT RUN**.

## 23. Existing regression suite results

`pnpm -s test` (monorepo, isolate mode): **45 files, 771 tests, green.** +15 over
the 756 baseline (5 distributed-correctness, 7 contract-identity, 3 execution-
provider). One timing-sensitive adversarial test is **intermittently flaky** under
the 42-worker parallel run (fails ~1 run in 3, passes 3/3 in isolation); it
exercises the no-lock engine path unchanged by this milestone — parallel-runner
DB contention, not a regression. Both typechecks clean.

## 24. Browser / manual acceptance

**NOT RUN this milestone** (backend/infrastructure only; the terminal and Owner
Control Center were not modified). UI compatibility rests on the unchanged REST/
WS contracts and the green server suite.

## 25–27. Defects: discovered / fixed / unresolved

- Discovered + fixed: a non-transactional `account-service.transition()` with a
  TOCTOU read-modify-write and a non-transactional outbox write (both fixed by
  the transactional, advisory-locked transition). A stray untracked
  `apps/server/dist` that vitest double-ran (removed; confirmed gitignored).
- Unresolved (deferred, not defects introduced): no outbox worker, no read-model
  projection/reconciliation, no cross-process WS fan-out.

## 28. Explicitly deferred work

Read-model projection + reconciliation; outbox delivery worker + cross-process
fan-out; dedicated infrastructure torture harness at 1k/10k with **separate OS
processes**; deliberate failure injection (kill worker mid-commit, restart,
reorder); the end-to-end acceptance scenario; routing all execution call sites
through the `ExecutionProvider` interface; back-filling contract identity on
historical rows; per-contract position identity across rolls; freshness-policy
configurability beyond the existing stale-feed order gate.

## 29. Ready for a professional provider adapter?

**Market data: yes** — the capability-based seam exists; an adapter is a new
implementation. **Execution: the seam exists and the simulator satisfies it**,
but call sites are not yet routed through the interface, so a live execution
adapter also needs that (mechanical) wiring. Contract identity is in place so an
adapter can map its instrument symbols to Atlas contracts. Distributed
correctness means a second instance can be added without account corruption —
though cross-process event fan-out is still required for a true multi-instance
deployment.

## 30. Recommended next milestone

**The account-state read model + outbox delivery worker.** Together they unblock
owner-dashboard scale, cross-process WebSocket fan-out, and reconciliation — the
largest remaining gaps this milestone deliberately left, now with their
prerequisites (contract identity, transactional outbox, account lock, state
version) in place.
