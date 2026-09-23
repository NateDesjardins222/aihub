# Atlas — Market Motion Investigation (V-06)

Why the visible price "feels stationary." Reopened per the milestone brief with
a full trace and live measurements, NQ first. Measured on the running dev stack
against the live `yahoo-delayed` provider, market OPEN.

## The pipeline, end to end

```
Yahoo REST poll  →  provider republish watermark  →  bus (order + dedupe + integrity gate)
  →  candle aggregator (emits on every accepted price)  →  WS gateway (synchronous fanout)
  →  browser MarketStream  →  motion/easing layer  →  lightweight-charts
```

Files: `apps/server/src/marketdata/providers/yahoo.ts`, `…/bus.ts`,
`…/price-integrity.ts`, `packages/core/src/candles/aggregator.ts`,
`apps/server/src/ws/gateway.ts`, `apps/web/src/market/stream.ts`,
`apps/web/src/panels/ChartPanel.tsx`, `apps/web/src/chart/motion.ts`.

## Measured (live, NQ, market OPEN)

From `/api/v1/marketdata/latency` and `/api/v1/marketdata/diagnostics`:

| Metric | Value | Source |
| --- | --- | --- |
| Provider observed cadence | **~5.3–6.9 s** between new prices (`observedCadenceMs`) | `/latency` `poll` |
| Poll seed (`MARKET_DATA_POLL_MS`) | 5 000 ms | `/latency` `pollIntervalMs` |
| Vendor delay behind exchange | **~601 s** (`ageMs` ≈ 606 584, threshold 720 000) | `/diagnostics` freshness |
| Bus published events | 45 188 | `/diagnostics` busStats |
| Dropped — duplicate `exchangeTs` | 539 (**1.19 %**) | busStats.droppedDuplicate |
| Dropped — integrity quarantine | 70 (**0.15 %**) | busStats.droppedQuarantined |
| Dropped — out of order | 22 (0.05 %) | busStats.droppedOutOfOrder |
| Aggregator NQ prices in / accepted / refused-unchanged | 15 / 15 / 0 (sample window) | `/latency` aggregators |

**Update frequency ≠ delay.** They are two different provider properties, both
measurable above: cadence (~6 s: how often a new price appears) and delay
(~600 s: how far behind the exchange each price is). The "stationary" complaint
is the cadence.

## The concrete answer

> **The chart feels slow because the free Yahoo feed only publishes a new price
> about every 5–10 seconds** (measured `observedCadenceMs` ≈ 5.3–6.9 s), so for
> most of each interval there is genuinely no new observation to draw — the last
> price is unchanged because the provider has nothing newer. On top of that the
> client's SMOOTH easing spreads each arrival over up to `maxCatchUpMs = 1 200`
> ms, which turns those ~6-second-apart steps into a slow drift.

**Atlas's own pipeline is not the bottleneck**, proven by the numbers:
- No time-based throttle, rAF gate or batching in the bus or the WS gateway —
  every accepted event is published synchronously.
- The candle aggregator emits on **every** accepted price, not only on 1-minute
  bucket rolls (`ingestPrice` → `emitTimeframe`); its counters show 15/15 prices
  accepted, 0 refused-unchanged in the sample.
- The suppression gates drop only ~1.3 % of events combined (duplicate 1.19 %,
  quarantine 0.15 %, out-of-order 0.05 %), and each is correct: a duplicate
  `exchangeTs` carries no new information, the quarantine holds a single >0.5 %
  outlier for one observation until a second corroborates it (anti-bad-print),
  and out-of-order drops a regressed timestamp.

## What could be changed, and what cannot

- **Cannot** (provider-bound): the ~6 s cadence and the ~600 s delay are
  properties of the free Yahoo `=F` continuous feed. No Atlas change makes Yahoo
  publish faster or fresher. The professional Databento feed (a separate, PAUSED
  milestone) is what closes both; per the brief, no Databento credentials were
  requested here.
- **Atlas-side lever, client only**: the SMOOTH easing (`motion.ts`
  `DEFAULT_MOTION.maxCatchUpMs = 1 200`, `smoothing = 0.55`). Lowering it makes a
  genuine print settle faster (less drift) at the cost of a slightly less smooth
  glide; `RAW_MOTION` disables easing entirely and snaps to each real print. This
  changes only how a **real** observation is animated between frames — fills,
  candles, P&L, stops, targets and risk remain on real observations, never
  interpolated. It does not, and cannot, close the ~6 s gaps between prints.

The dominant cause is provider cadence; the honest fix is professional data.
