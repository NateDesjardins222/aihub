# The market-data provider: what it can do, and what it cannot

The brief: *"Do not assume it is adequate simply because it returns CME-related
OHLC. Determine whether the provider can actually supply the quality and update
frequency required for a professional futures trading terminal."*

**It cannot.** This is the assessment, measured rather than assumed, and the
architecture that is in place for replacing it.

---

## What is actually being served

Atlas's development feed is Yahoo's delayed futures endpoint. Every figure
below was measured against the running platform, not read from documentation.

| Dimension | Measured | Consequence for a trading terminal |
| --- | --- | --- |
| **Observation frequency** | a new reading every **~4.9 s** during active hours, **~10.5 s** when quiet (an EWMA of real gaps, reported live at `/api/v1/marketdata/latency`) | the forming candle advances in steps, not continuously. There is no tick stream to have |
| **Latency** | **p50 603,899 ms**, p95 609,005 ms, p99 612,572 ms, exchange timestamp to the response landing (n=323) | ten minutes behind the exchange. Atlas can never be compared with a live platform at the same wall-clock instant |
| **Missing data** | null rows for every non-trading minute; **60 null minutes in a 15:00–17:00 CT window**, all of them the CME halt and maintenance break | correct, and Atlas draws a gap. But nulls and genuine no-trade minutes are indistinguishable in the payload |
| **Historical limits** | **7 days** of 1-minute history; `range=1d` resets at midnight ET | a 1-minute chart cannot scroll back further, and the intraday window shortens as the day begins |
| **Live-update limits** | OHLCV only — **no bid, no ask, no prints, no book** | no DOM, no spread, no tape. Fills are modelled from bars. Atlas renders no depth rather than inventing one |
| **Granularity** | 1m, 5m, 15m, 30m, 1h, 1d | **sub-minute timeframes cannot be built from this feed at all** |
| **Contract behaviour** | `NQ=F` tracks the front month; `NQZ26.CME` agrees to the tick, `NQU26.CME` is 303 points away | correct contract, no continuous-contract contamination — but no roll calendar is published, so the roll is Atlas's own |
| **Timestamps** | epoch seconds, on the minute, declared in `America/New_York` | usable. The exchange-vs-vendor timezone difference is the single biggest reason two charts disagree (see `p0.1-candle-audit.md`) |
| **Volume quality** | present and self-consistent; folds exactly from 1m into the vendor's own 5m | trustworthy as *relative* activity. It is not exchange-audited volume |
| **Price precision** | **32-bit floats on GC and CL** — 4388.30 arrives as `4388.2998046875` | would put candles off the tick grid. Atlas tick-snaps, recovering the true price on 1325 of 1329 GC bars |
| **Reconnect** | HTTP polling, no session. Consecutive failures back off exponentially to 60 s; an 8 s request timeout; recovery needs no state | robust, but there is no gap-fill protocol: a long outage is a hole until the next history fetch |
| **Rate limits** | unpublished and enforced | polling harder is not available as a strategy |

### The one-line verdict

A feed that is ten minutes delayed, publishes one reading every five seconds,
has no book and no tape, and cannot produce a bar shorter than a minute, is a
development feed. **The pipeline built on it is proven correct** — see
`p0.1-candle-audit.md` — and no amount of further work inside Atlas will make
it feel like a professional terminal, because Atlas's own contribution to
latency is **15 ms at p50 against the vendor's 603,899 ms**: four orders of
magnitude.

---

## What is already in place for replacing it

`apps/server/src/marketdata/provider.ts` is the **only vendor-aware interface in
the platform**. The bus, the aggregator, the WebSocket gateway, the chart, the
execution engine and the journal consume normalized types and have no knowledge
of which vendor produced them. Two implementations exist today — the delayed
vendor and the replay provider — which is what keeps the seam honest: a seam
with one implementation is a guess.

A licensed feed is a new implementation of that interface and nothing else.
What the interface already carries, and why each piece matters when the feed
changes:

* **`mode: 'DELAYED' | 'REALTIME' | 'REPLAY'`** — declared, never inferred, and
  surfaced in the terminal. Atlas must never silently present delayed data as
  real-time, and the badge reads from here.
* **`depthLevels`** — 0 for this feed. The DOM reads it to decide what it is
  *allowed* to render. A feed with real depth raises it; nothing invents a book.
* **`capabilities()`** — `providesTrades`, `providesQuotes`, `providesTopOfBook`
  and the rest, so a surface can ask rather than assume.
* **`observedAt` on every event** — the start of the half of the latency path
  Atlas controls. A provider is not obliged to measure itself, but when it does,
  `/api/v1/marketdata/latency` reports it beside Atlas's own stages.
* **Market era.** A position records the market-data source it was opened
  against, and a mark from another era does not apply to it. This is what makes
  switching providers safe at runtime rather than a way to corrupt an account.

### What a professional feed would need that is NOT built

Stated plainly, because "prepared for" is not "implemented":

* **A tick/trade ingest path.** `NormalizedTrade` exists and the replay provider
  emits them, but no live provider does, so the aggregator's trade path has
  never carried production volume.
* **Sub-minute aggregation.** `CandleAggregator` folds from a fine series and
  would extend downward, but no timeframe below 1m is exposed, and the
  timeframe union in `@atlas/contracts` would have to grow.
* **A real order book.** The DOM surface is deliberately absent, not stubbed.
  Depth types exist; nothing renders them.
* **Gap-fill on reconnect.** A session-based feed can tell you what you missed.
  Polling cannot, so nothing asks.
* **Entitlement and symbol mapping** for a licensed vendor: `providerSymbols` on
  the instrument spec is keyed by provider id and already holds `yahoo`; a
  second key is a data change, not a code change.

Candidate feeds — **Databento**, **dxFeed**, **Rithmic**, or direct licensed
CME-compatible infrastructure — differ in transport and entitlement, not in what
Atlas needs from them. Choosing one is a commercial decision, and this document
exists so that decision is not also an engineering discovery exercise.

**Nothing is fabricated while waiting.** The repository enforces it:
`packages/core/src/no-fabrication.test.ts` fails the build if a random number
generator appears in any file that can influence a price, a bar, a quote or a
fill.
