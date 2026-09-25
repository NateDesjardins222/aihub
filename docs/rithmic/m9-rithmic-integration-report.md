# Milestone 9 — Rithmic Test Integration + Real Market Data + Test Execution V1

**Final report.** This is the first real external futures-infrastructure integration
for Atlas. It replaces the development-only delayed-market-data path with a real,
provider-neutral **Rithmic Test** integration wired through the existing provider
architecture: authenticate, discover systems, maintain distinct plant connections,
discover instruments / accounts / trade routes, receive real market data and
historical bars, submit / modify / cancel test orders, observe the authoritative
order and execution lifecycle, reconcile Atlas state against Rithmic, and expose
provider health on the owner surface.

> **Rithmic Test is NOT production live capital.** Everything here targets the
> Rithmic **Test** environment (`system_name = "Rithmic Test"`, gateway Orangeburg,
> `wss://rituz00100.rithmic.com:443`). External live trading stays globally disabled
> (`EXTERNAL_LIVE_ENABLED=false`). The simulation engine, the provider abstraction,
> and the Yahoo / dev delayed feed are all retained. Nothing in this milestone
> routes real customer capital to a live exchange.

---

## 1. Git

- **START HEAD:** `5cdea07` (`test(payouts): isolate two torture batch tests to a fresh org`)
- **BRANCH:** `claude/futures-trading-simulator-v8qefu`
- **COMMITS (M9, oldest → newest):**
  1. `df7112e` — protocol layer (framing / codec / registry / router) + env flags + architecture doc
  2. `542c492` — transport + plant connection model (discovery / auth / heartbeat / reconnect)
  3. `0dc6ded` — market data (instruments / reconciliation, normalization, freshness, historical bars, provider)
  4. `a35f403` — execution (accounts, trade routes, order lifecycle, executions, P&L adapter)
  5. `2a606aa` — reconciliation, schema / migration 0029, observability metrics, owner health
  6. `eecd9d7` — `rithmic:generate` / `rithmic:verify` scripts + torture tests
  7. *(this commit)* — 10 docs incl. this report, browser acceptance suite, remove stray debug scratch file
- **FINAL HEAD:** the report commit above (tip of `claude/futures-trading-simulator-v8qefu`).
- **LOCAL == REMOTE:** verified after push (see §15).
- **CLEAN TREE:** verified after commit (see §15).

## 2. Files

48 files across commits 1–6 (`git diff --stat 5cdea07..<c6>` → 48 files changed,
+4943 / −108), plus the docs + browser suite + debug-file removal in the final commit.
Principal additions:

**Protocol (`apps/server/src/rithmic/protocol/`)**
`framing.ts`, `codec.ts`, `registry.ts`, `router.ts`, `__fixtures__/atlas-rithmic-min.proto`.

**Transport + plants (`apps/server/src/rithmic/transport/`, `.../plants/`)**
`transport.ts`, `ws-transport.ts`; `plant.ts`, `discovery.ts`, `connection-manager.ts`,
`market-data-service.ts`, `order-service.ts`, `pnl-service.ts`.

**Domain (`apps/server/src/rithmic/domain/`)**
`instruments.ts`, `market-normalize.ts`, `freshness.ts`, `bar-compare.ts`,
`order-normalize.ts`, `reconcile.ts`.

**Observability** `apps/server/src/rithmic/metrics.ts`.

**Provider wiring (reused M4 seams — not duplicated)**
`marketdata/providers/rithmic.ts` (real `MarketDataProvider`),
`execution/providers/rithmic-execution.ts` (real `ExternalExecutionAdapter`),
`infra/rithmic-config.ts` (`resolveRithmicConnection`), `marketdata/bootstrap.ts`,
`infra/health.ts`, `config/env.ts`.

**Schema** `db/schema.ts` (+3 tables), `drizzle/0029_rithmic_provider.sql`, journal idx 29.

**Scripts** `scripts/rithmic-generate.ts`, `scripts/rithmic-verify.ts`, `package.json` scripts.

**Web** `apps/web/src/admin/pages/InfraPage.tsx`, `apps/web/src/admin/types.ts`.

**Docs** `docs/rithmic/` (10 files, §12). **Browser** `tests/browser/rithmic-acceptance.spec.mjs`.

**Config** `.gitignore` (vendor + generated), `.env.example` (placeholders only), `pnpm-lock.yaml` (protobufjs).

## 3. Protocol authority & version

- **Authority:** the official `RProtocolAPI.0.90.0.0` package is the protocol
  authority for template IDs, enum values, field numbers, and message framing.
- **Package-authority-at-runtime design.** The official `.proto` files are loaded
  at runtime from a **gitignored** `apps/server/vendor/rithmic/proto/` (or
  `RITHMIC_VENDOR_DIR`); the template-id ↔ message registry is **derived** from the
  schema itself (each message's `template_id` field default; field number `154467`)
  — never hardcoded. `pnpm rithmic:generate` binds the official protos into a
  gitignored manifest; `pnpm rithmic:verify` runs live acceptance.
- **Deterministic tests** run against a committed **test-double** proto
  (`__fixtures__/atlas-rithmic-min.proto`) built from public R|Protocol shapes —
  labelled proto2, `template_id` defaults, `user_msg` correlation on every request.
- **If the package and our code disagree, the official package wins:** because IDs
  and enums are derived from the loaded schema, dropping in the official package and
  running `rithmic:generate` re-binds them with no source edits.
- **Framing:** R|Protocol `[4-byte big-endian uint32 length][protobuf body]` per
  binary WebSocket message, with `MAX_FRAME_BYTES` guarding hostile lengths.

## 4. Connection model

- **Discovery** via `RequestRithmicSystemInfo` → verify `"Rithmic Test"` is present
  before any login (`RithmicSystemDiscoveryService`, bounded cache, typed
  `RithmicDiscoveryError`: `ENDPOINT_UNAVAILABLE` / `MALFORMED_RESPONSE` / `TIMEOUT` /
  `SYSTEM_ABSENT`).
- **Distinct plants** — `RithmicConnectionManager` maintains separate connections per
  plant: `TICKER`, `ORDER`, `HISTORY`, `PNL`, `REPOSITORY`. Each is its own
  `RithmicPlant` with an independent auth + heartbeat lifecycle.
- **Auth** — login with `system_name = "Rithmic Test"`; errors mapped to canonical
  codes (`mapLoginError`), never surfacing raw credentials.
- **Heartbeat + liveness** — the server dictates the heartbeat interval; a liveness
  watchdog (reusing M4 `HeartbeatWatchdog`) detects silence.
- **Reconnect** — bounded exponential backoff + jitter (`BackoffPolicy`,
  `backoffDelayMs`, `mayRetry`); a hard auth failure transitions to `FAILED` and does
  **not** reconnect (guarded in `onClose`).

## 5. Discovery / instruments (launch roots)

- **Launch roots:** NQ, MNQ, ES, MES, GC, MGC, CL, MCL.
- Reference data fetched (`RequestReferenceData`) and reconciled against the Atlas
  canonical `@atlas/instruments` spec (`reconcileReferenceData` →
  `MATCHED` / `DISCREPANCY` / `INCOMPLETE`), across all 8 roots in the test matrix.
- Exchange mapping via `rithmicExchange`; canonical scaling via
  `tickSizeScaled` / `pointValueMicros` / `pricePrecision`.

## 6. Market data

- `RithmicMarketDataService` subscribes on the `TICKER` plant with a schema-derived
  update-bits mask (`RequestMarketDataUpdate`, `SUBSCRIBE` / `UNSUBSCRIBE`).
- `LastTrade` and `BestBidOffer` are normalized to the canonical `NormalizedTrade` /
  `NormalizedQuote` contracts; timestamps via `rithmicTsToMs`, aggressor via
  `normalizeAggressor`.
- **Freshness:** `FreshnessTracker` — an open socket is *not* fresh; status is
  `CONNECTED` / `STALE` / `RECONNECTING` / `DISCONNECTED` based on message-rate windows.

## 7. Historical bars

- `getHistoricalBars` on the `HISTORY` plant (`RequestTimeBarReplay`), collecting
  `ResponseTimeBarReplay` frames until the `rp_code` terminator; normalized to
  `NormalizedBar` (`normalizeTimeBar`, `timeframeToRithmicBar`).
- `compareBars` / `validateBarSeries` provide exact OHLCV diffing and series sanity
  (ascending time, non-negative volume) for history↔live handoff (`mergeHistoricalWithLive`).

## 8. Accounts / trade routes / orders

- `RithmicOrderService.discoverAccounts` (`RequestAccountList`) and
  `discoverTradeRoutes` (`RequestTradeRoutes`); `routeFor` resolves the route per order.
- **Submit** (`RequestNewOrder`, `quantity_64`, schema-derived
  `TransactionType` / `Duration` / `PriceType` / `OrderPlacement`) →
  `SUBMITTED` / `REJECTED` / `SUBMISSION_UNKNOWN`.
- **Modify / cancel** (`RequestModifyOrder` / `RequestCancelOrder`) with a
  working-order cache.

## 9. Execution lifecycle & unknown-state safety

- Order updates come from **authoritative** `RithmicOrderNotification` and
  `ExchangeOrderNotification` (mapped via `mapRithmicNotification` /
  `mapExchangeNotification`) — acknowledgement is treated as distinct from fill.
- **Execution reports** are deduped by `executionDedupKey` (`basket|trade|fill|ts`);
  duplicate executions are ignored and counted.
- **Unknown state is first-class.** A submit whose outcome is unconfirmed yields
  `SUBMISSION_UNKNOWN` / `ExternalOrderState.UNKNOWN` — **surfaced, never silently
  treated as success and never thrown away**. A hard reject throws
  `ExternalExecutionError('REJECTED')`. This matches the M4 `ExternalExecutionAdapter`
  contract (ack ≠ fill, `UNKNOWN` state, `ExecutionReport`, reconciliation snapshots).

## 10. P&L & reconciliation

- `RithmicPnlService` consumes `InstrumentPnLPositionUpdate` /
  `AccountPnLPositionUpdate` (`RequestPnLPositionUpdates`). It is **observational**:
  it never overwrites the Atlas authoritative ledger.
- `reconcile.ts` — `reconcileOrders` / `reconcilePositions` / `summarize` produce
  verdicts `MATCHED` / `MISMATCH` / `UNKNOWN` / `REQUIRES_REVIEW`. Forward-only state
  transitions are auto-resolvable; anything else is flagged for review. Snapshots
  persist to `provider_reconciliation_runs`.

## 11. Risk integration & safety

- Real execution is gated behind the existing `externalExecutionGate`
  (`RITHMIC_EXECUTION_ENABLED` plus the global external-live gate, which stays off).
- The provider only reaches the real transport when `RITHMIC_ENABLED=true` **and**
  the relevant sub-gate is on **and** credentials resolve; otherwise it reports an
  honest `UNCONFIGURED` posture.
- Simulation infrastructure, the provider abstraction, and the Yahoo / dev delayed
  feed are all retained. `EXTERNAL_LIVE_ENABLED` stays `false`.

## 12. Docs (10)

Under `docs/rithmic/`:
`rithmic-architecture-v1.md`, `rithmic-protocol-notes.md`,
`rithmic-connection-lifecycle.md`, `rithmic-market-data.md`,
`rithmic-instrument-mapping.md`, `rithmic-execution-lifecycle.md`,
`rithmic-reconciliation.md`, `rithmic-local-setup.md`,
`rithmic-test-acceptance.md`, and this `m9-rithmic-integration-report.md`.

## 13. Tests & validation

- **Deterministic tests:** **107 pass** (target ≥100), across 7 files —
  protocol 19, connection 14, market-data 21, execution 14, reconcile (9 static /
  parametrized) , metrics 4, torture (19 static / parametrized over 8 launch roots).
  All use real `protobufjs` encode/decode against the test-double schema with a
  `MockRithmicTransport` + `FakeScheduler`; no live Rithmic.
- **M9-adjacent regression:** rithmic + infra + execution + marketdata → **223 pass**
  (19 files).
- **Broader regression:** the `src/trading` suite passes **227 / 227 when run
  serialized** (`--no-file-parallelism`) and every file passes individually. Under
  heavy *parallel* file execution the shared `atlas_test` DB shows non-deterministic
  cross-file contention (fail count varied 9→11→16 across runs) — a **pre-existing**
  characteristic of the shared test pool (the last pre-M9 commit itself addressed
  "shared-pool determinism"), not an M9 regression: M9 adds only new tables and a new
  module and touches no `src/trading` code.
- **Typecheck:** server `tsc --noEmit` clean; web `tsc --noEmit` clean.
- **Prod builds:** server `tsc -p tsconfig.build.json` clean; web `vite build` clean.
- **Migration:** `0029_rithmic_provider.sql` applied to `atlas` and `atlas_test`
  (`provider_discovered_accounts`, `provider_connection_events`,
  `provider_reconciliation_runs`).
- **Browser acceptance:** `tests/browser/rithmic-acceptance.spec.mjs` — **6 / 6 pass**
  (owner Infrastructure page truthfully shows the Rithmic R|Protocol posture, the
  environment / enabled state, the market-data provider selection; **no credential
  value on the owner surface**; no console errors). Registered in `run.mjs` after
  `payout-ops-acceptance`.

## 14. Live acceptance

- Live Rithmic Test acceptance is **not** run in this environment: the official
  `RProtocolAPI` package and real Rithmic Test credentials are not present here, and
  the constraints forbid committing either.
- **`pnpm rithmic:verify`** is provided for a credentialed operator. It runs a safe
  live acceptance — discovery, plant auth, account / trade-route discovery, market
  data (a closed market is reported `BLOCKED`, not `FAIL`), and historical bars — and
  **never prints a credential**. Order submit / cancel is left to a supervised run
  (`VERIFY_SUBMIT=1`, one small far-from-market limit order, then cancel). When
  unconfigured it prints the exact setup steps and exits 0 (non-blocking).

## 15. Security / secret audit

- **No real credentials** anywhere: source, tests, fixtures, docs, seeds,
  `.env.example`, logs, browser bundle, git history, or this report.
  `.env.example` has empty placeholders (`RITHMIC_USER=`, `RITHMIC_PASSWORD=`).
- Transport errors are sanitized (`sanitizeTransportError` strips credentials from
  URLs / query / `password=` / tokens); the owner surface shows only redacted posture
  (`credentials=present`, never a value) — proven by the browser check.
- **Model identifier:** the assistant model identifier appears in **no** committed
  artifact (verified across the full `5cdea07..HEAD` diff and the new files — the
  grep for the identifier literal returns nothing).
- **Package redistribution decision:** the proprietary Rithmic package is **not**
  committed — no `Reference_Guide.pdf`, no samples, no ZIP, no private URLs. Only the
  minimal, hand-written **test-double** `.proto` is committed
  (`__fixtures__/atlas-rithmic-min.proto`); `apps/server/vendor/rithmic/` and the
  generated manifest are gitignored. The official package is bound at runtime by the
  operator via `rithmic:generate`.
- The stray debug scratch file `apps/server/dbg.mjs` (accidentally committed in
  `542c492`; contained only fake `u`/`p`, no secret) is **removed** in the final commit.

## 16. Known limitations & market-closed blockers

- Live acceptance depends on the operator supplying the official package + Rithmic
  Test credentials and running `rithmic:verify`; until then the deterministic
  test-double schema is in force.
- Market data and historical bars can only be confirmed live when the market is open
  and the account carries the relevant data entitlement; `rithmic:verify` reports
  these as `BLOCKED` rather than fabricating success.
- Order submit / cancel against live Rithmic Test is intentionally gated behind a
  supervised `VERIFY_SUBMIT=1` run and is not auto-executed.
- The shared-test-pool parallel contention in `src/trading` (§13) is orthogonal to
  M9 and remains a test-infra follow-up.

## 17. Next milestone

With the first real external futures integration in place (provider-neutral,
deterministic-first, credential-safe), the natural next step is a supervised live
Rithmic Test acceptance run (bind the official package, run `rithmic:verify`, then a
single supervised submit/cancel), followed by promotion of the provider-health and
reconciliation surfaces into the owner operations console for continuous monitoring.

---

*Rithmic Test is a non-production test environment. This milestone does not enable
live external trading; the global external-live gate remains disabled.*
