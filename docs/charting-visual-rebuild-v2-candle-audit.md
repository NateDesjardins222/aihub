# Atlas — Candle Re-audit (V-07) + Candle Visual Style (§11)

Reopened again per the brief, with a fresh pull of live data rather than trusting
the TC-V1 audit. Instrument NQ, 1-minute, `yahoo-delayed`, market OPEN.

## Live data audit — 31 consecutive 1-minute NQ bars

Pulled from `/api/v1/marketdata/bars?symbol=NQ&timeframe=1m&limit=30` and checked
mechanically (`scratchpad/nq-bars.json`), plus the server's own integrity gate:

| Check | Result |
| --- | --- |
| Bars returned | 31 (30 closed + 1 forming) |
| Server integrity violations | **0** (`integrity.violations = 0`) |
| OHLC validity (H ≥ max(O,C), L ≤ min(O,C), H ≥ L) | **0 violations** across all 31 |
| Time spacing | **every bar exactly 60 000 ms apart**, strictly increasing |
| Missing buckets | **0** |
| Duplicate timestamps | **0** |
| Tick alignment | all O/H/L/C on the 0.25 NQ tick |
| Forming bar | last bar `closed:false`, volume 0 (Yahoo reports forming-bar volume late); open = prior close ±1 tick, as a real next-bar open behaves |
| Source | `MIXED` (history + live handoff), precision 2 |

Sample (UTC): `16:45 O30695 H30707.5 L30687.75 C30700.5 V2020` … the series is
clean and continuous.

**DATA and AGGREGATION are correct** — zero hard violations on 31 consecutive
live bars, correct 1-minute buckets, no gaps/dupes, valid tick-aligned OHLC, a
well-formed forming bar. This is a fresh, live re-confirmation of the TC-V1
conclusion, not a re-use of it.

## Classification of any residual "looks wrong"

Per the brief every mismatch is classified rather than lumped under "provider":

| Class | Finding |
| --- | --- |
| DATA | Clean (above). No wrong OHLC. |
| AGGREGATION | Clean. 1-minute buckets on the exchange clock; forming bar folds prices correctly (aggregator counters: prices in = accepted). |
| CONTRACT | NQ maps to Yahoo `NQ=F`, the **continuous front-month** series — a different instrument identity from a specific CME contract month a reference chart may show. |
| SESSION / TIMEZONE | Bars carry exchange-time buckets; axis renders in the configured zone. No off-grid buckets seen (spacing exactly 60 s). |
| FORMING BAR | Correct: `closed:false`, live close folded per price. |
| TIME SCALE | `barSpacing` 7, `rightOffset` 8; zoom-out cap widened separately (26d176c). Bar density is a render setting, not a data error. |
| BAR DENSITY | A function of the time scale above, not of missing bars — the data has no gaps. |
| RENDERING | lightweight-charts native `CandlestickSeries` (see §11). No fuzzy geometry. |
| PROVIDER LIMITATION | **The residual.** `yahoo-delayed` serves a ~600 s-delayed, Yahoo-aggregated **continuous `=F`** series. Versus a realtime CME-direct reference this differs in freshness, in exact per-bar OHLC, and in roll convention — none of which an Atlas-side change can reconcile. |

**Verdict: primarily class C (contract/provider origin), with DATA, AGGREGATION,
FORMING BAR and RENDER proven sound on live data.** What cannot be solved until
professional data is enabled: exact per-bar parity and freshness versus a
realtime CME-direct feed, because the source series itself is different
(delayed, continuous, Yahoo-aggregated). Databento remains PAUSED per the brief;
no credentials were requested. The deterministic comparison workflow
(`auditCandles` + the live `/bars` pull above) is the mechanical test: run the
Atlas series through it — zero hard violations means any remaining price/level
delta against a reference is provider origin, which is the expected state while
the pro feed is paused.

## §11 — candle VISUAL style

The renderer is lightweight-charts' native `CandlestickSeries`
(`LightweightChartsAdapter.createPriceSeries`, lines ~567–585), which owns body
width, wick width, body/wick alignment, minimum body height, doji rendering,
pixel snapping, anti-aliasing, zoom-dependent width and high-DPI scaling — a
mature, professional implementation. Atlas configures colours
(`upColor`/`downColor`/`wickUpColor`/`wickDownColor`), `borderVisible`,
`wickVisible` and `bodyVisible`; the container is sized with `devicePixelRatio`
(verified in the zoom-out work). In every V2 screenshot (Fib, Long/Short, tool
menu) the candles render sharp and readable at 1× DPR with clean bodies and
wicks — no half-pixel fuzz, no collapsed doji. No candle-renderer defect found.
