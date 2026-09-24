# Production Trading Infrastructure V1 — architecture, debt, target, migration

**Milestone 4.** Move Atlas toward provider-neutral production trading
infrastructure so it can eventually connect to professional futures
infrastructure (Rithmic the likely primary path; Databento a market-data option)
without rewriting the terminal, risk engine, account system, or copy-trading
system.

> **No credentials, no fake connectivity, no live-trading claim.** This milestone
> builds the REAL seams and adapters so credentials/providers connect later
> without architectural surgery. Professional providers ship **UNCONFIGURED**.
> Default execution stays **SIMULATION**.

Starting HEAD: `2fe08f6` (Milestone 3 — Copy Trading V1 closure).

---

## 1. Authoritative principle

Atlas owns the domain; providers are adapters. Nothing downstream of an adapter
knows whether market data came from Yahoo / replay / Rithmic / Databento, or
whether execution went to the Atlas simulator or an external venue. Business
logic depends on Atlas-owned normalized contracts; provider-specific objects
terminate at adapter boundaries.

Market data and execution are **separate concerns** with **separate provider
seams** — never one "BrokerProvider". It must be possible to run any combination
(e.g. Databento MD + Rithmic execution, Rithmic MD + Atlas sim) without changing
terminal components.

---

## 2. Current architecture (what already exists — reuse, do not duplicate)

Prior milestones ("Professional Market Data V2", "Core Infrastructure V2",
"Contract Identity") already built a great deal of this. Verified present:

### 2.1 Market-data provider seam ✅ (mostly M4-C)
- `apps/server/src/marketdata/provider.ts` — `MarketDataProvider` is the ONLY
  vendor-aware interface. `mode: DELAYED|REALTIME|REPLAY`, `depthLevels`,
  `connect/disconnect/subscribe/unsubscribe/getHistoricalBars/getQuote/getTrades/
  getDepth/getConnectionStatus/era/on`. `DescribableProvider.capabilities()`
  returns `ProviderCapabilities` (providesTrades/Quotes/TopOfBook/Depth/Ohlcv +
  per-timeframe `history`).
- Implementations: `providers/yahoo.ts` (DELAYED dev feed), `providers/replay.ts`
  (REPLAY), `providers/databento{,-http,-normalize}.ts` (DELAYED, historical HTTP).
- Selection: `config/env.ts MARKET_DATA_PROVIDER` (`yahoo-delayed|replay|databento`),
  chosen in `marketdata/bootstrap.ts` — **deliberate**, fail-fast on a missing
  Databento key, never a silent fallback under a professional label.

### 2.2 Normalized market contract ✅ (mostly M4-B)
- `packages/contracts/src/marketdata.ts`: `NormalizedQuote` (exchangeTs, bid/ask/
  last + sizes, seq, synthesizedBook), `NormalizedTrade` (exchangeTs, price, size,
  seq, aggressor), `NormalizedBar` (open-time exchangeTs, OHLCV, closed),
  `NormalizedDepth`/`DepthLevel`, `ConnectionStatus` (state, mode, delaySeconds,
  declaredDelaySeconds, lastEventAt, lastMessageAt, error?, reconnectAttempts),
  `HistoricalBarsRequest`, `Timeframe`.
- Provenance is honest: exchange clock only (never server/browser), `seq` for
  ordering/dedupe, `synthesizedBook` flag, source `era()` stamped on positions,
  `marketDataMeta`/`historicalBars.provider` persisted.

### 2.3 Market-data integrity + aggregation ✅ (mostly M4-J/K)
- `bus.ts` (per-symbol monotonic clock; drops out-of-order + duplicate),
  `price-integrity.ts` (ACCEPT/QUARANTINE/REJECT corroboration; never
  interpolates), `candle-integrity.ts` (`auditCandles`, hard vs soft GAP),
  `@atlas/core` aggregation is exchange-time/bucket based (never arrival time),
  `errors.ts` taxonomy (AUTH/NETWORK/PROVIDER/MAPPING/CONTRACT/STALE/GAP/
  INVALID_DATA/INTERNAL) + `MarketDataObserver` coarse lifecycle log.

### 2.4 Staleness / trading safety ✅ (mostly M4-L)
- `quote-store.ts freshness()` → `FRESH|STALE|MARKET_CLOSED|NO_DATA` judged
  against **declared** delay (catches a frozen feed whose own clock still reads
  open). `blocksOrderEntry` flows into `trading/risk.ts` which returns structured
  `MARKET_DATA_UNAVAILABLE|MARKET_CLOSED|MARKET_DATA_STALE`. RAW observations
  authoritative; SMOOTH is presentation-only elsewhere.

### 2.5 Execution provider seam ✅ (partial M4-M)
- `apps/server/src/execution/provider.ts` — `ExecutionProvider` (capability-based:
  submit/cancel/cancelAll/modify/flatten/reverse/getAccountState) +
  `AtlasSimulationExecutionProvider` (thin faithful delegation to `TradingEngine`;
  the only implementation, none faked). Wired directly in `app.ts` as `execution`.

### 2.6 Instrument + contract identity ✅ (partial M4-G/H)
- `packages/instruments` — `InstrumentSpec` (root, exchange, tick/point economics,
  session windows, maintenance windows, rollRule, providerSymbols, isMicro,
  fullSizeRoot). 8 instruments (NQ/MNQ/ES/MES/GC/MGC/CL/MCL).
- `ContractResolver` — `RootInstrument`/`TradableContract` (NQZ26)/`ContinuousSeries`
  (NQ.c.0)/`ProviderInstrument`; deterministic `resolveActiveContract` from
  listing cycle + per-root roll rule; `contractCode` returns null (never wrong)
  when unresolvable. `contract_code` persisted on orders/executions/trades
  (migrations 0012/0014); position contract lock at open (no silent roll).

### 2.7 Session / calendar ✅ logic (partial M4-I)
- `packages/instruments/session.ts getMarketState(spec, epochMs)` →
  `OPEN|CLOSED|MAINTENANCE|PRE_OPEN`; Luxon exchange-local, Globex windows,
  maintenance break, `holidays.ts` (CME table 2025–2027, FULL vs EARLY).

### 2.8 Realtime + reliability ✅
- `ws/gateway.ts MarketDataGateway` pushes `md.*` and `acct.*` channels
  (never polled); per-stream seq + snapshot/resume. `platform/outbox.ts` +
  `account-notify.ts` LISTEN/NOTIFY fan-out; account-state reconciliation via
  projection + outbox already exists.

### 2.9 Latency ✅ (partial M4-U)
- `marketdata/latency.ts LatencyRecorder` splits vendor vs Atlas halves; p50/p95/
  p99 per stage over a rolling window; timing carried out-of-band via WeakMap.

### 2.10 Licensing posture ✅ (foundation for M4-S)
- `MARKET_DATA_REDISTRIBUTION` env (`none` default) + `market-data-licensing-gate.md`
  (five access categories; technical access ≠ redistribution rights).

---

## 3. Architectural debt / provider coupling / missing production seams

What this milestone must ADD or HARDEN:

| Gap | Detail | Milestone item |
|---|---|---|
| No execution provider **registry / routing** | `execution` is a single `AtlasSimulationExecutionProvider` wired directly; no `EXECUTION_PROVIDER` env, no per-account routing. | M4-F |
| No **execution modes** | Nothing models SIMULATION vs EXTERNAL_PAPER vs EXTERNAL_LIVE, and nothing makes EXTERNAL_LIVE server-only/impossible-from-browser. | M4-F/Q |
| No **Rithmic** adapters | No `RithmicMarketDataProvider` / `RithmicExecutionProvider` scaffolds; no connection lifecycle/heartbeat/reconnect framework for a professional provider. | M4-D |
| No first-class **UNCONFIGURED** provider | Databento fail-fasts; there is no graceful "declared but not configured" provider that reports UNCONFIGURED without breaking boot. | M4-D/F |
| No **canonical symbology service** | `providerSymbols` is one-directional and Yahoo-only; no bidirectional multi-vendor contract-aware mapping, no validation preventing NQ↔MNQ / wrong-expiry / wrong-exchange mismatches. | M4-G |
| No **stateful rollover engine** | Roll is a pure on-demand function; no roll state (front/next/prev), no roll events, no boundary tests as a unit. | M4-H |
| No centralized **session authority service** | `getMarketState` is a pure fn re-invoked at 6+ sites with inconsistent clocks; no HALTED/UNKNOWN; no single service. | M4-I |
| No **external order state machine / linkage** | Nothing persists external order lifecycle (PENDING_SUBMIT…FILLED/UNKNOWN), Atlas↔provider id linkage, or external execution events. | M4-N |
| No **execution reconciliation** | Account-state reconciliation exists; external order/position reconciliation (UNKNOWN / RECONCILIATION_REQUIRED) does not. | M4-O |
| No **account↔provider mapping** | Nothing maps an Atlas account to a provider/environment/execution-mode. | M4-P |
| No **external execution safety gate** | The pre-trade risk gate is account/market-scoped; there is no gate that also validates execution mode + provider mapping + connection before an order could leave Atlas. | M4-Q |
| No **market-data entitlement domain** | The licensing posture is a single env value; there is no per-user/exchange/data-level entitlement domain. | M4-S |
| Partial **provider health / owner console** | System Health shows market-data provider; there is no unified provider-health service across MD+execution, and no owner "Infrastructure" page. | M4-T/Z |
| No **professional test providers** | `ScriptedMarket` exists for the engine, but there is no `ScriptedMarketDataProvider`/`ScriptedExecutionProvider` implementing the provider seams with disconnect/gap/stale/late-fill/lost-ack behaviors. | M4-W |
| Missing structured reject reasons | No `MARKET_DATA_DISCONNECTED`, `CONTRACT_EXPIRED`, `EXECUTION_PROVIDER_UNAVAILABLE`. | M4-L/M |

---

## 4. Target architecture

```
                    ┌───────────────────────── Atlas domain (provider-neutral) ─────────────────────────┐
  MARKET DATA       │  MarketDataProvider seam ── registry(env) ── MarketDataService ── bus ── gateway   │
   adapters ────────┤     yahoo | replay | databento | rithmic(scaffold) | scripted(test)                │
                    │                                                                                    │
  REFERENCE DATA    │  Instrument registry · Symbology service · Contract resolver · Rollover engine ·   │
                    │  Session authority service (OPEN/CLOSED/MAINTENANCE/PRE_OPEN/HALTED/UNKNOWN)       │
                    │                                                                                    │
  EXECUTION         │  ExecutionProvider seam ── registry(env + per-account mode/mapping)                │
   adapters ────────┤     atlas-sim | rithmic(scaffold) | scripted(test)                                │
                    │        ▲                                                                           │
                    │        │  External Execution Safety Gate (server-only): auth · ownership ·        │
   Copy trading ────┼────────┘  lifecycle · mode · mapping · connection · contract · freshness ·        │
   (unchanged) ─────┤           session · risk · idempotency · lock                                     │
                    │                                                                                    │
  DURABLE STATE     │  provider_account_mappings · external_orders · external_execution_events ·        │
                    │  reconciliation_state · market_data_entitlements · provider_ops_events            │
                    │                                                                                    │
  OPERATIONS        │  Provider health service · latency · reconnect/recovery · Owner Infrastructure    │
                    └────────────────────────────────────────────────────────────────────────────────┘
```

**Execution modes.** `SIMULATION` (default), `EXTERNAL_PAPER`, `EXTERNAL_LIVE`.
An account's mode lives in a durable `provider_account_mappings` row; default is
SIMULATION. `EXTERNAL_LIVE` requires (all, server-side): configuration permits
it, provider configured + connected, account explicitly mapped, account lifecycle
permits, risk permits. The browser can express intent only; it can never select a
mode or a provider — provider name, mode, provider account id, entitlement and
contract mapping are never trusted from the client.

**Copy-trading compatibility.** Copy trading continues to operate on Atlas
account IDs: leader intent → copy intent → independent child Atlas order intents
→ normal Atlas risk → each account's configured `ExecutionProvider`. The provider
behind each account may differ in future (leader sim, follower external paper)
**without** a separate copy-trading execution path. Mixed live/sim copying is NOT
enabled for customers in this milestone; only architectural compatibility is
preserved.

---

## 5. Migration strategy

1. **Contracts first** (additive types): execution modes, provider kinds,
   external-order states, entitlement enums, new reject reasons, data-mode.
2. **Reference-data services** (symbology, session authority, rollover) as thin
   layers over the existing pure `@atlas/instruments` functions — no behavior
   change, just a single authority + validation + tests.
3. **Provider registries + UNCONFIGURED providers + Rithmic/Scripted scaffolds** —
   boot-safe, default unchanged.
4. **Durable schema** (one additive migration) + domain services (mapping,
   external-order store, reconciliation, entitlements, ops events).
5. **External execution safety gate** composing the existing risk gate.
6. **Reconnect/recovery + 30-case torture suite** using the scripted providers.
7. **Owner Infrastructure page + terminal data-mode UX**.
8. **Browser acceptance (deterministic) + final validation + docs**.

Every migration is additive and safe; existing simulation and copy-trading paths
are never altered in behavior (proven by regression suites).

---

## 6. What remains simulation-only / requires external dependencies

- **Real fills** remain the Atlas simulator. No external venue is contacted.
- **Rithmic** adapters are honest scaffolds: config validation, lifecycle state
  machine, reconnect/heartbeat framework, structured errors, redacted
  diagnostics — but the official R | Protocol / dev-kit wire integration is a
  marked seam that cannot be exercised without the dev kit, credentials, a
  broker/FCM relationship and conformance. State is UNCONFIGURED until then.
- **Databento** stays an optional market-data adapter (delayed historical HTTP);
  realtime DBN path remains future work; UNCONFIGURED without a key.
- **CME real-time redistribution / entitlements** are unresolved and unclaimed;
  the entitlement domain is software only (see `market-data-entitlements-v1.md`).
- **EXTERNAL_PAPER / EXTERNAL_LIVE** cannot be reached in this milestone because
  no external provider is configured; the modes, mappings and gate exist so they
  can be reached later by server configuration + admin action only.

See `docs/rithmic-integration-readiness-v1.md` for the exact
implemented-vs-required breakdown, and `docs/provider-contracts-v1.md` for the
seam contracts.
