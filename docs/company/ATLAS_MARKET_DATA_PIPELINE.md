# ATLAS MARKET DATA PIPELINE

**Engineering Phase A, STEP 1.** One NQ 1-minute bar traced from origin to pixels, every stage with
its input/output format, timezone, timestamp semantics, and the transformation / loss / duplication it
can introduce. Traced from source (`file:line` cited inline in the two audit passes; summarized here).
Dev provider is **Yahoo delayed OHLCV**; production would set `MARKET_DATA_PROVIDER` to `databento`
or `rithmic` (same downstream path).

## The stages

| # | Stage | Input | Output | TZ / timestamp | Transform / loss / dup |
|---|---|---|---|---|---|
| 1 | **Provider selection** — `marketdata/bootstrap.ts`, `config/env.ts` | `MARKET_DATA_PROVIDER` env (default `yahoo-delayed`) | a `MarketDataProvider` | — | Deliberate; databento/rithmic fail-fast if unconfigured (never a silent fallback). `NODE_ENV` does not switch it. |
| 2 | **Symbol → contract** — `providers/yahoo.ts:vendorSymbol`, `packages/instruments/registry.ts` | Atlas root (`NQ`) | Yahoo ticker (`NQ=F`) | — | Root→`spec.providerSymbols['yahoo']`. **All 8 map to continuous `=F` front-month; micros share the mini series** (NQ,MNQ→NQ=F; ES,MES→ES=F; GC,MGC→GC=F; CL,MCL→CL=F). See ATLAS_CONTRACT_POLICY.md. |
| 3 | **Provider response** — Yahoo `/v8/finance/chart` | HTTP GET (`interval=1m&range=1d&includePrePost=true` live; `period1/period2` history) | `chart.result[0]{meta, timestamp[], indicators.quote[0].{o,h,l,c,v}[]}` | **epoch SECONDS**, exchange-absolute | Native 1m (finest). Parallel arrays. `null` OHLC for minutes with no data. Trailing row = live price (off-grid, volume 0). |
| 4 | **Timestamp normalization** — `marketdata/normalize.ts:normalizeBar` | raw row `{tsSeconds,o,h,l,c,v}` | `NormalizedBar{time(ms),o,h,l,c,volume,closed}` | `time = tsSeconds*1000`; **OPEN-time** (bucket start); no UTC↔local shift of the number | Tick-snaps prices; re-derives extremes so `low≤o,c≤high`. **Drops** a row with any null/non-finite/inconsistent OHLC (counted, never interpolated). Plausibility guard rejects unit mix-ups. |
| 5 | **Session filter** — (none) | — | — | — | **No server-side RTH/ETH bar filtering.** `includePrePost=true` keeps ETH. Session windows affect only coarse-TF bucket alignment, never keep/drop. |
| 6 | **Provider dedupe / cache** — `providers/yahoo.ts:newBars`; `marketdata/bar-service.ts` (Postgres `historicalBars`); `service.ts` `CandleAggregator` | normalized bars | de-duplicated stream + persisted closed bars | ms, open-time | `newBars` re-emits only a newer bucket or a signature revision of the newest. Cache keyed `(symbol,timeframe,barTime)`, **closed bars only**, upsert **revises never duplicates**; read `desc(barTime)` then reversed → ascending. |
| 7 | **Server aggregation** — `bar-service.ts:foldBars`, `packages/core/candles/fold.ts` | 1m bars | requested-TF bars | ms, open-time bucket boundary | **1m→5m/15m/… folded SERVER-SIDE** (open=first, high=max, low=min, close=last, volume=sum). Client never folds. |
| 8 | **Server API** — `http/routes/marketdata.ts` `GET /api/v1/marketdata/bars` | `symbol, timeframe, limit(≤20000), before(exclusive)` | `{symbol,timeframe,bars[],hasMore,nextCursor,source,integrity,provider,mode,pricePrecision,barCloseInSeconds}` | ms | Cursor/limit pagination (walks backward from now — no arbitrary from/to). Forming bar merged onto the newest page only, live bucket chosen on the **exchange** clock. |
| 9 | **Client fetch** — `apps/web/market/api.ts:fetchBars`; `ChartPanel.tsx` | `{limit,before}` | server bars | ms | Initial `limit=1200`; scroll-left pages `limit=1000, before=<oldest>`. Live bars via WS `md.bar.${symbol}.${timeframe}` + `md.quote.${symbol}`. |
| 10 | **Client normalization** — `chart/LightweightChartsAdapter.ts` | server bars | `this.bars` | ms, open-time | `applyHistory` now runs **`orderBarsAscendingUnique`** (Phase A fix): ascending + de-duplicated before render. `prependHistory` dedupes by time + sorts. Forming bar's close/high/low updated from `md.quote`. **No aggregation, no tz shift, no gap-fill, no session filter, no smoothing of history.** |
| 11 | **Motion (RAW/SMOOTH)** — `chart/motion.ts` | forming bar | eased forming bar | ms | SMOOTH eases **only the forming bar's close** between prints; closed bars drawn exactly; never alters historical OHLC, timestamps, fills, P&L, or triggering. RAW snaps to genuine close. |
| 12 | **Chart series** — lightweight-charts `setData`/`update` | ordered bars | canvas | **unix SECONDS** at the library boundary (`Math.floor(ms/1000)`) | Full replace on history/redraw; incremental `update` for the newest live point. Throws on unordered/duplicate times → the reason STEP 10's guard exists. |
| 13 | **Rendered bar** | series points | pixels | — | lightweight-charts canvas; timezone affects **axis labels only**, not bar X-positions. |

## Key semantics (audited)

- **Units:** vendor epoch **seconds** → internal **ms** (×1000, once) → library **seconds** (÷1000, once). Consistent; no double conversion found.
- **Bar timestamp = OPEN time** (bucket start) end-to-end. A reference platform that labels candles by **close** time shows every candle shifted one interval — a labeling convention, not a data error (see ATLAS_CANDLE_TRUTH_REPORT.md Q23).
- **Timezone** is a *display* concern only (axis + legend). Bar positions are raw epoch; no offset is ever applied to the data.
- **Aggregation is server-side** from an authoritative 1m base; the client requests a timeframe and a distinct live stream.
- **Gaps are real:** a minute the provider returns as `null`/absent stays absent. Nothing fabricates OHLC. See the gap classification in ATLAS_CANDLE_TRUTH_REPORT.md.

## Where bars can legitimately change count (documented, not bugs)

- Vendor `null` minutes dropped in normalization (Yahoo free-feed sparsity — the dominant cause of visible gaps / fewer bars than a pro-fed reference).
- Trailing live-price row dropped (it is the current price, not a completed minute).
- Duplicate/out-of-order page rows collapsed by `orderBarsAscendingUnique` (client) / cache upsert (server).
- Client initial paint capped at 1200 bars; older history loads on scroll-left.

## Diagnostic

`scripts/bar-truth.ts` reproduces stages 3–4 against the live vendor and classifies every minute
(MATCH / VALUE_MISMATCH / MISSING / DUPLICATE) with bar-count parity. Run:
`NODE_USE_ENV_PROXY=1 pnpm --filter @atlas/server exec tsx ../../scripts/bar-truth.ts NQ 1m 72`.
