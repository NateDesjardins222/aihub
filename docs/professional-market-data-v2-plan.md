# Professional Market Data V2 — plan and autopsy

Baseline `338f832` (Account State + Event Reliability V1 Closure, LOCKED).
Branch `claude/futures-trading-simulator-v8qefu`.

This builds on the Phase-0 autopsy in `professional-market-data-plan.md` (still
accurate) and the provider decision in `market-data-provider-evaluation.md`
(Databento first). It records what V2 actually changes, and — as the brief
demands — what it must **not** touch.

---

## 1. The reliability spine is locked

`338f832` is the checkpoint: execution engine, account state, P&L, rule engine,
event/outbox architecture, projections, owner read model, journal. Market data
plugs **into** this. The only spine-adjacent change V2 makes is **additive
contract identity** (a nullable column + a stamp at open), which is required by
Phase 9/17 and is proven non-regressive by re-running the 338f832 reliability
harnesses (deterministic E2E + torture) after the change.

Everything else in V2 lives in `apps/server/src/marketdata/**`,
`packages/instruments/**`, a new Databento adapter, new fixtures, and new tests.

---

## 2. Autopsy: the path a price takes today (confirmed against the code)

```
providers/{yahoo,replay}.ts   ← ONLY vendor-aware files (provider.ts is the seam)
  → normalize.ts (tick snapping, float-noise recovery)
  → MarketEventBus (bus.ts): per-symbol monotonic seq, drops regressing ts,
       drops byte-identical dups, PriceIntegrity quarantine, LatencyRecorder
  → QuoteStore (quote-store.ts): freshness FRESH/STALE/MARKET_CLOSED/NO_DATA,
       blocksOrderEntry consumed by the rule engine
  → CandleAggregator (@atlas/core): folds a 1m base series upward
  → BarService (bar-service.ts): history + cache + integrity
  → ws gateway: md.bar.SYM.TF / md.quote.SYM frames
  → browser MarketStream → ChartAdapter (RAW/SMOOTH visual only) → canvas
  → TradingEngine marks positions (MarketView.markPrice + era())
```

Already right (keep, do not rebuild): the provider seam, sequencing/dup/
regression handling, market-era position protection, freshness→order-entry gate,
subscription reference counting, integer ticks / micro-dollar money, latency
recording in both halves, the replay provider proving the seam twice.

### Confirmed gaps V2 closes

1. **Live path fed `bar` events only.** `ProviderEvent` has trade/quote/bar/
   depth but no live provider ever emitted a real trade or top-of-book. V2 makes
   the Databento adapter emit `trade` and `quote` (MBP-1 BBO) and drives the
   candle engine from **trades**, not vendor bars.
2. **`expectedDelayMs` hard-coded** in `service.ts` (`DELAYED ? 600_000 : 0`).
   Delay/freshness thresholds move onto the provider as declared capability.
3. **`baseTimeframe = 1m`** (Yahoo's floor). A tick feed makes the base
   `trades`; 1s/1m are aggregated, higher frames derived.
4. **Contract identity stops at orders/executions/trades.** Migration `0012`
   stamps those; **`positions` still keys on `(account, root)`** with no
   per-contract identity — the open-position contract lock (Phase 17) gap.
5. **Continuous == tradeable.** The chart's continuous series and the tradeable
   contract are one object; V2 separates display symbol from tradeable contract.
6. **No provider-declared session/status.** Session/holiday knowledge is in
   `@atlas/instruments`; Databento `status`/`definition` become validation input.

---

## 3. Databento facts this build relies on (VERIFIED Sept 2026)

- Historical HTTP: base `https://hist.databento.com/v0`,
  `GET /v0/timeseries.get_range`, HTTP Basic auth (API key `db-…` as username,
  empty password), streaming response; encodings `dbn|csv|json`; schemas
  `trades`, `mbp-1`, `ohlcv-1s|1m|1h|1d`, `definition`, `statistics`, `status`;
  `stype_in` includes `raw_symbol`, `continuous`, `parent`, `instrument_id`;
  symbology via `/v0/symbology.resolve`, metadata via `/v0/metadata.*`.
- Live: raw TCP binary (DBN) with CRAM challenge-response auth on
  `live.databento.com`; there is **no official JavaScript/TypeScript client**
  (only Python/Rust/C++), so Atlas speaks the HTTP and TCP protocols directly.
- Dataset `GLBX.MDP3` = CME Globex MDP 3.0 (covers CME/CBOT/NYMEX/COMEX, i.e.
  all eight Atlas instruments). Nanosecond PTP timestamps, up to four per event.
- Redistribution: most datasets redistributable after 24h; real-time external
  needs an exchange ILA. **Development/historical only** for this milestone —
  see `market-data-licensing-gate.md`.

Wire-format details (exact DBN struct layouts, CRAM handshake bytes) are
confirmed against the first authenticated run; until then they are implemented
from the public schema docs and exercised with recorded fixtures, and any
residual uncertainty is labelled REQUIRES VENDOR CONFIRMATION in the report.

---

## 4. Work plan (provider-independent core first, Databento as an adapter)

**A. Provider-neutral core (no Databento).**
- Extend the provider seam with declared freshness/delay + capability metadata
  and contract-aware subscription (subscribe by tradeable contract, not only
  root). Remove the hard-coded `expectedDelayMs`.
- Normalized event model: ensure `trade`/`quote` carry sequence + exchange time
  + receive time + instrument identity; add `definition`/`status`/
  `symbol_mapping` normalized events. Keep them provider-neutral.
- Time model: name and thread exchange-event / provider-receive / ingest /
  publish times in UTC; presentation tz stays separate.

**B. Contract identity (additive, spine-adjacent, re-tested).**
- Migration: nullable `contract_code` on `positions` (root kept for querying).
- Stamp the resolved tradeable contract on a position at open; **lock it** — an
  open position, its orders/stops/targets/fills/P&L stay on that contract across
  any front-month roll. Mark only by the position's own contract/era.
- Roll transition state (current / next / candidate / effective-time / reason)
  as a domain model; manual contract override supported in the model (no UI).
- Provider symbol mapping: Atlas instrument ↔ contract ↔ provider raw symbol ↔
  provider instrument id, with mappings allowed to change.

**C. Databento adapter (behind the seam, types contained).**
- Historical HTTP client (JSON encoding first: no DBN decode needed) for
  `timeseries.get_range`, `symbology.resolve`, `metadata`. Bounded backoff,
  never logs the key.
- Live DBN/CRAM connection lifecycle (CONNECTING/CONNECTED/DEGRADED/
  RECONNECTING/STALE/DISCONNECTED) with a minimal DBN decoder for the schemas
  used. Exercised offline with recorded fixtures.

**D. Candle engine + handoff.**
- Aggregate trades → 1s → 1m; derive 3m/5m/15m/30m/1h. Forming-bar from live
  trades (first qualifying trade sets open); closed-bar immutability; empty
  intervals not invented.
- History/live handoff: load history → establish live → identify overlap →
  dedupe → merge → continue forming, with the startup race (live arriving during
  history load) buffered, and reconnect gap backfill.

**E. State + gating.**
- Session engine + market status from session + provider status; freshness
  thresholds per session state; execution gate refuses stale/unknown-contract/
  disconnected/unresolved-roll unless an explicit simulation mode allows it.

**F. Distribution + performance.**
- Measure ws fanout; coalesce **visual** updates only (never execution
  evidence); reference-counted subscriptions; multi-chart/multi-user.

**G. Testing.**
- Recorded fixtures; `scripts/torture-market-data.ts` with market-data
  invariants; candle audit vs source; roll/restart/network/reconnect tests;
  re-run 338f832 reliability harnesses; execution torture on professional-style
  streams; memory/soak/cpu; the five previously-stalled live-feed browser suites
  under the new provider/test mode.

**H. Offline gate → key → live.**
- Everything above is built and tested with fixtures/mocks/historical-shaped
  data. Only the first **authenticated** run needs the key; at that point the
  report states exactly what test runs and what entitlement it needs.

---

## 5. Provider selection is deliberate (Phase 68/89)

`MARKET_DATA_PROVIDER = legacy | databento | replay` chooses the provider — a
present `DATABENTO_API_KEY` never auto-switches. `MARKET_DATA_REDISTRIBUTION`
declares posture (default `none`). Both are surfaced in Owner System Health. The
legacy (Yahoo) provider stays as dev/fallback, honestly labelled, and never
masquerades as real-time.

---

## 6. What V2 will not do

No DOM/L2/MBO UI, footprint, heatmaps, order-flow, alerts, backtesting, new
drawings/indicators, news, payments. This milestone is market data. The success
condition is a professional, **provider-independent** futures market-data core
with Databento as the first adapter — not "Databento returns data".
