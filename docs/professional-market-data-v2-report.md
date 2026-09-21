# Professional Market Data V2 — report

**Unsanitized.** RUN means run; NOT RUN means not run; PENDING KEY means built
and offline-tested but awaiting `DATABENTO_API_KEY` for authenticated
validation; REQUIRES VENDOR/CME CONFIRMATION is labelled as such. This milestone
reached the **offline completion gate** (Phase 91): the provider-independent
core and the Databento adapter are built and tested with no key, no network, and
recorded/synthetic data. Live authenticated validation (Phases 93–96) is the
next step and needs the key — see §54 and the handoff at the end.

## 1–5. Commits, branch, tree

1. Starting commit: `338f832` (Account State + Event Reliability V1 closure, the
   locked reliability checkpoint).
2. Final commit: pushed to `claude/futures-trading-simulator-v8qefu` (hash in the
   push output).
3. Branch: `claude/futures-trading-simulator-v8qefu`.
4. Remote == local: verified at each push.
5. Working tree: clean at each push.

## 6. Provider architecture

Unchanged in shape and deliberately so: `apps/server/src/marketdata/provider.ts`
remains the ONLY vendor-aware interface. Databento is a new implementation of it
(the third, after yahoo and replay), which keeps the seam honest. Config gained
`MARKET_DATA_PROVIDER=databento` (deliberate selection; a present key never
auto-switches), `DATABENTO_API_KEY`, `DATABENTO_DATASET`, and
`MARKET_DATA_REDISTRIBUTION` posture. `bootstrap.ts` selects it; a missing key is
a fail-fast, never a silent fallback under a professional label.

## 7. Databento adapter

`apps/server/src/marketdata/providers/databento{,-http,-normalize}.ts`. Databento
types are contained in these three files. **Mode: DELAYED, via the Historical
HTTP API** — the lighter licensing path (§9). Historical bars via
`timeseries.get_range` (continuous front-month symbology `<root>.c.0`,
`encoding=json`), a delayed-poll live experience emitting new 1m bars + marks,
source-level `era()`, capability metadata, and a full connection lifecycle. The
realtime raw-TCP/DBN live path is future work behind the same class (§15).

## 8. Credential handling

`DATABENTO_API_KEY` is server-side only. Read once by `DatabentoHttp` into a
Basic-auth header (key as username, empty password); **never logged, never
returned from an API, never sent to the browser, never in an error body** (error
bodies are truncated to 300 chars and the tests assert the raw key never appears
in the clear or in `ConnectionStatus`). A 4xx (bad/expired key) surfaces
immediately with bounded backoff — no reconnect storm.

## 9. Licensing status

Category 1 (development/historical) only. See `market-data-licensing-gate.md`.
VERIFIED: historical/delayed redistributable after 24h; real-time external needs
an exchange ILA (months). Atlas is **NOT** cleared to redistribute real-time CME
data to end users, and nothing in this milestone claims otherwise. The
`MARKET_DATA_REDISTRIBUTION` posture (default `none`) is surfaced in Owner System
Health as a visible, deliberate declaration.

## 10. Contract model changes

`positions` gained `contract_code` (migration 0014); orders/executions/trades
already carried it (0012). The `packages/instruments` contract model (root /
tradeable contract / continuous series / provider instrument, roll rules, active
-contract resolver) was already present and is used, not rebuilt.

## 11. DB migration

`0014_position_contract_code.sql`: nullable `contract_code` on `positions` + a
contract index. Additive, non-destructive, **no back-fill** — legacy rows stay
`NULL` = "root only", never a wrong contract. Registered in the drizzle journal;
applied to the test DB and verified. (The drizzle *snapshot* for 0014 was not
regenerated — `drizzle-kit generate` needs a TTY — so a future `generate`
should be run interactively once; the migrator itself needs only the SQL +
journal, which are present and tested.)

## 12. Continuous vs tradeable behaviour

The chart draws Databento's continuous front-month series (`<root>.c.0`); an
order/position resolves and persists the actual tradeable contract (NQZ26). The
resolver is the boundary. Separation is modelled and enforced.

## 13. Roll behaviour

Deterministic front-month resolution from the exchange listing cycle + per-root
roll rule (`contracts.ts`, unchanged). **Open-position contract lock (Phase 17)
is implemented and tested:** a position stamps its contract at open, never
re-resolves it to a later front month, and — once the root feed's front month
has rolled past it — reads UNKNOWN rather than being marked by the new contract
(never a wrong mark, never a silent roll, never a fabricated zero). Enforced
identically in the engine and the owner projection, proven consistent to the
micro-dollar (§42). Continued marking of an off-the-run open contract by its own
feed is documented future work (needs live data spanning a roll).

## 14. Symbol mapping

Continuous symbology is used for history/live; `providerInstrument` maps
Atlas↔contract↔provider symbol. Databento numeric instrument-ids and
`symbol_mapping` messages are consumed on the realtime path (PENDING KEY).

## 15. Live schemas used

Realtime (raw TCP / DBN): trades, mbp-1, ohlcv-1s, definition, status,
symbol_mapping — **the DBN binary decoder and CRAM handshake are future work**
(PENDING KEY; wire format REQUIRES VENDOR CONFIRMATION on the first
authenticated run). The delayed mode shipped here uses ohlcv-1m over HTTP.

## 16. Historical schemas used

`ohlcv-1s|1m|1h|1d` (native), 1m folded in-adapter to 2/3/5/10/15/30m; trades and
mbp-1 normalization implemented and unit-tested. Encoding: JSON (NDJSON stream).

## 17. Trade semantics

`tradeToNormalized`: fixed-point price → tick-snapped decimal, size, exchange
time (BigInt ns→ms), aggressor from side. No invented prints.

## 18. BBO semantics

`mbp1ToQuote`: real top of book from `levels[0]`, `synthesizedBook: false`,
all-null frames dropped. No DOM built (Phase 90).

## 19. Mark-price semantics

Unchanged: `QuoteStore.markPrice` prefers `last`, falls back to mid only with a
real bid AND ask, never manufactures a book. The delayed Databento mode marks
from the bar close (last), honestly.

## 20. Candle engine

`CandleAggregator` already aggregates trades (`ingestTrade`) and bars
(`ingestBar`) into a base series and derives coarser frames; verified present and
exercised by the market-data torture harness. Base can be `1s`.

## 21–25. History/live handoff, gap recovery, reconnect, session, status

Existing `BarService` (cache + provider fallback + repair) and `service.getChartBars`
(merges cached history with the forming bar using the exchange clock) provide the
handoff; session/status/holiday logic lives in `@atlas/instruments` and the
quote store's freshness. **Offline handoff tests added** (`handoff.test.ts`, 5,
RUN): history→live with no duplicate/reset/gap, overlapping re-sent bar is a
revision (no volume double-count), the startup race (a live bar arriving during
the historical load survives the seed), gap resume without inventing the missing
interval, and higher-timeframe derivation across the handoff. Full handoff and
gap backfill against a **real streaming feed** remain PENDING KEY.

## 26. Freshness thresholds

`QuoteStore.freshness` judges against `declaredDelaySeconds + tolerance`;
`blocksOrderEntry` gates order entry. Provider-declared delay flows via
`ConnectionStatus`. The market-data torture harness exercises stale detection.

## 27. Execution gating

Unchanged and intact: stale/closed/no-data marks block order entry through the
rule engine; the contract lock additionally makes an unresolved-contract position
read unknown.

## 28. Market-era behaviour

Preserved. `era()` stays source-level (protects against provider/replay
contamination); the contract lock (contract_code) is the new, orthogonal
per-contract protection. Both verified by the reliability harnesses and the
contract-lock test.

## 29–31. WebSocket fanout, backpressure, event rates

Unchanged this milestone (root-keyed fanout, ref-counted subscriptions). Real
professional event-rate measurement, backpressure/coalescing tuning, and
multi-user fanout under a live burst are PENDING KEY (they need the live feed).
The market-data torture harness exercises bursts through the bus/aggregator in
process.

## 32. Latency

Not re-measured end-to-end this milestone (the delayed HTTP path's latency is
dominated by the provider's own delay, as with yahoo). The two-half latency
recorder is intact. Live segmented latency is PENDING KEY.

## 33–35. Candle audit, independent comparison, roll test

Candle audit vs Databento source and an independent reference are PENDING KEY
(need historical pulls). The contract lock/roll behaviour is tested
deterministically offline (§13, §42).

## 36–39. Restart, network, sleep/wake, provider outage

Provider-outage handling: connect() failure → ERROR (diagnosable, no key leak),
bounded backoff, poll failure → RECONNECTING; unit-tested. Restart/reconnect of
the full stack against a live feed is PENDING KEY.

## 40. Market-data torture results — RUN

`scripts/torture-market-data.ts`, seeded, drives the real bus + aggregator +
quote store with duplicate/late/out-of-order/missing/burst/disconnect/reconnect/
contract-change/session-close-reopen/bad-price/off-grid/stale events. Invariants
(monotonic closed-bar time, valid OHLC, volume≥0, tick-aligned prices,
duplicate-suppression, stale-detection) held: **seed 1 (500 ops), seed 2 (800),
seed 7 (800) — 0 violations.** Out-of-order and duplicate events dropped by the
bus; wild outliers quarantined by the integrity gate.

## 41. Execution torture results — RUN (regression)

The 338f832 seeded execution/reliability torture was re-run after the contract
identity changes: **0 invariant violations** (seed 1 × 300 ops × 3 accounts =
4515 assertions). Owner==trader held throughout.

## 42. Account reliability regression — RUN

Deterministic E2E scenario: **12/12** after contract identity. The contract-lock
test proves owner==trader agreement to the micro-dollar in both the marked and
the locked-unknown (post-roll) cases. No projection drift, no owner/trader
disagreement, no money moved by projection machinery.

## 43–45. Memory, soak, CPU

NOT RUN this milestone (they are most meaningful against a live feed; PENDING
KEY). The delayed poll and in-process torture showed no unbounded growth in the
runs performed, but no dedicated long soak was run — stated honestly, not
claimed.

## 46. Five previously stalled browser suites

NOT RE-RUN under a professional feed yet (PENDING KEY): the delayed dev feed's
slow order round-trip was the cause; the Databento delayed mode should not remove
it (still delayed), and a realtime feed is what would. To be re-run once live
data is available; increasing timeouts alone was explicitly rejected.

## 47. Security results

The key never appears in logs, API responses, the browser bundle, or errors
(unit-tested). System Health exposes provider/mode/posture/contracts — no
secret. `no-fabrication.test.ts` still guards against RNG in price paths.

## 48. Owner System Health changes

`/admin/system` marketData now reports: provider, mode, connection state,
measured + declared delay, reconnect attempts, last quote time, age,
blocksOrderEntry, **redistribution posture**, and **current front-month contract
per root**. No secret exposed; admin suite 51/51.

## 49–50. Defects discovered / fixed

- The pipeline was entirely root-keyed and `positions` lacked contract identity
  (autopsy) → migration 0014 + stamp + lock.
- `env.test.ts` fixture needed the new config fields → updated.
- No functional defects in the reliability spine were introduced (harnesses
  green).

## 51. Incomplete (this milestone)

Realtime DBN/TCP live path (decoder + CRAM), live history/live handoff + gap
backfill against a stream, live candle audit + independent comparison, live
latency/event-rate/backpressure/multi-user/soak, and the five browser suites —
all PENDING KEY. Drizzle 0014 snapshot not regenerated (TTY).

## 52. Requires Databento/vendor confirmation

Exact DBN struct layouts and CRAM handshake bytes; exact JSON field names for
each schema (implemented from public docs, confirmed on first authenticated
run); continuous-symbology roll rule vs Atlas's own.

## 53. Requires CME/venue licensing

Everything in category 2–5 of `market-data-licensing-gate.md`: internal display,
non-display classification, external real-time distribution, per-user
entitlement. None resolved; none claimed.

## 54. What I would NOT trust in production yet

The realtime path (unbuilt/unvalidated). Any claim of real-time data or external
redistribution. The exact Databento JSON/DBN field names until a real payload
confirms them. Everything offline-tested here I trust to the extent an offline
test can carry — the authenticated run is the next gate.

## Second offline pass — additions (Phases 38–40, 80, 82–83)

Deepening offline coverage before the key, per Phase 91:
- **History/live handoff tests** (`marketdata/handoff.test.ts`, 5): no duplicate/
  reset/gap across the join, overlapping bar = revision (no double-count), the
  startup race, gap resume without invention, higher-timeframe derivation.
- **Error taxonomy + observability** (`marketdata/errors.ts` + 7 tests): the
  AUTH/NETWORK/PROVIDER/MAPPING/CONTRACT/STALE/GAP/INVALID_DATA/INTERNAL
  classifier and a coarse structured lifecycle observer, wired into the Databento
  adapter (never per-tick, never a credential). `observability()` for health.
- **Storage/retention doc** (`market-data-storage-retention.md`): what is
  persisted (closed bars, contract identity, latest op state, recorded sessions)
  vs in-memory only (ticks/quotes/forming bars), growth bounds, and the storage
  licensing constraint.

## Test totals

- Full suite: **821 tests, 51 files, all pass** (isolate runner; 788 baseline →
  821, +33: 18 Databento adapter, 3 contract-lock, 5 handoff, 7 error taxonomy).
- Typecheck: `pnpm -r typecheck` clean.
- Reliability E2E 12/12; reliability torture 0 violations; market-data torture 0
  violations across 3 seeds.

## The offline gate → the key (Phases 91–93)

**AUTHENTICATED DATABENTO ACCESS IS NOW REQUIRED** to go further. See the
handoff section in the closure message: what to set, what runs first, and what
entitlement it needs. Nothing beyond this point is fabricated while waiting.
