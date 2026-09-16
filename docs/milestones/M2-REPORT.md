# Milestone 2 — status report

**Scope:** real delayed market data, normalization, event bus, historical bars, candle
aggregation, WebSocket distribution, a working chart, and recorded-session replay.

---

## 1. Exact market-data source in use

`YahooDelayedProvider` (`apps/server/src/marketdata/providers/yahoo.ts`) reading the public
Yahoo Finance chart endpoint (`query1.finance.yahoo.com/v8/finance/chart/…`) for the
continuous front-month series of each product:

| Instrument | Vendor symbol | Exchange reported |
| --- | --- | --- |
| NQ, MNQ | `NQ=F` | CME |
| ES, MES | `ES=F` | CME |
| GC, MGC | `GC=F` | COMEX |
| CL, MCL | `CL=F` | NYMEX |

This is **genuine exchange-derived OHLCV**. Nothing is generated. `Math.random` does not
appear anywhere in the repository.

It is the **only** file in the platform that knows this vendor exists. Everything downstream
consumes normalized types through `MarketDataProvider`.

## 2. Is it delayed, and by how much?

**Yes — approximately 10 minutes.** Measured, not assumed:

```
sample 1: delay 601.3s      sample 4: delay 602.4s
sample 2: delay 601.5s      sample 5: delay 602.8s
sample 3: delay 600.9s
```

The exchange timestamp advances in real time between samples, so it is a genuine streaming
delayed feed rather than a periodically refreshed snapshot. The provider recomputes the delay
on every poll and publishes the measured value; the UI badge reads **`DELAYED 10m`** and the
tooltip states the exact figure. There is no code path that can label this feed real-time.

## 3. What does it provide?

| | |
| --- | --- |
| OHLCV bars | **Yes** |
| Last traded price | **Yes** |
| Bid / ask (top of book) | **No** |
| Level 2 depth | **No** |
| Individual trade prints | **No** |

`getDepth()` returns `null` and `depthLevels` is `0`. The DOM panel renders the banner
**"MARKET DEPTH UNAVAILABLE"** and draws no ladder rows. `NormalizedQuote.bid` and `.ask` are
`null` rather than a spread synthesized around the last price.

## 4. Update frequency

The provider polls every 5 seconds (`MARKET_DATA_POLL_MS`). Instruments sharing an underlying
series are fetched once and fanned out, so eight subscribed instruments cost four requests.
The vendor's own last-price field advances roughly every 5–15 seconds during active trading.

## 5. Historical limitations

Probed directly, not taken from documentation:

| Granularity | Max lookback | Measured |
| --- | --- | --- |
| 1m | ~7 days | 9,433 bars over 7.6d; `1mo` rejected |
| 5m | ~60 days | 17,154 bars over 70.6d; `3mo` rejected |
| 15m / 30m | ~60 days | 5,719 / 2,860 bars |
| 1h | ~730 days | 14,523 bars over 730d |
| 1d | many years | 1,260 bars over 5y |

`period1`/`period2` range queries work at every granularity, which is what makes real
pagination possible. When the chart reaches this floor it says so in the corner rather than
silently stopping. `3m` must be folded from 1m, so 3-minute history is capped at ~7 days —
that is a property of the feed, and the UI states it.

## 6. Rate limits

The endpoint publishes no documented rate limit and returned HTTP 200 for every request made
during this milestone (several hundred). It is unauthenticated and best-effort. The provider
is deliberately conservative: one request per distinct vendor symbol per poll, concurrent
polls coalesced, a 15-second timeout, and subscriptions reference-counted so nothing is
fetched for an instrument nobody is watching.

## 7. Development only, or production?

**Development only.** This is unambiguous:

- Yahoo's terms do not permit redistribution of this data in a commercial product.
- 10-minute delay is unusable for live execution.
- No book and no prints means no realistic fill modelling and no DOM.
- No SLA, no support, no schema guarantee.

A production deployment needs a licensed feed — Databento, CME MDP 3.0, Rithmic or dxFeed.
Each is a sibling of `yahoo.ts` implementing `MarketDataProvider`, plus credentials. **No
trading, charting, aggregation or risk code changes.** That isolation is the whole point of
the milestone.

---

## 8. Tests performed and results

### Automated — 115 passing

```
Test Files  4 passed (4)
     Tests  115 passed (115)
```

| Area | Tests | Result |
| --- | --- | --- |
| Instrument registry, tick/money math | 27 | pass |
| Session + roll calendars | 20 | pass |
| Bucket alignment, folding, aggregator | 33 | pass |
| Normalization, bus ordering, staleness, provider | 35 | pass |

Specifically covering:

- **Duplicate prevention** — history→stream handover, reconnect replay of the last N events,
  identical-bar re-delivery, and every timeframe asserted for unique ascending bucket times.
- **Session boundaries** — 4h buckets anchored to the 17:00 CT open; daily bars spanning one
  full overnight session; weekly anchored to the Sunday open; the 16:00–17:00 break splitting
  a fold; DST handled by the calendar, not an offset.
- **Stale detection** — a delayed feed is not stale merely for being delayed; stale only past
  its own delay plus tolerance; `MARKET_CLOSED` rather than `STALE` outside the session;
  `NO_DATA` blocks entry.
- **Reconnect** — RECONNECTING with attempt counts while unreachable, recovery to CONNECTED,
  and that `connect()` cannot claim CONNECTED without a request actually succeeding.
- **Normalization** — tick snapping per instrument, null prices dropped rather than
  interpolated, non-finite rejected, extremes re-derived, unit-mix-up timestamps rejected.

### Browser — 16/16, zero console errors

Every Phase 1 instrument loaded real bars at 1m:

```
NQ 29484.00   MNQ 29475.50   ES 7684.50   MES 7684.00
GC 4351.50    MGC 4351.50    CL 102.46    MCL 102.44
```

Every required timeframe on NQ: `1m 3m 5m 15m 30m 1h 4h 1D` — all loaded, all rendered.

| Test | Result |
| --- | --- |
| Historical pagination on scroll-left | **pass** — 2,201 → 3,910 bars (+1,709) |
| Server killed mid-session | **pass** — badge reads `RECONNECTING` |
| Server restarted | **pass** — recovers to `DELAYED 10m` unaided |
| Series survives the outage | **pass** — 3,911 bars retained |
| Stale data (forced zero tolerance) | **pass** — `STALE — ORDER ENTRY DISABLED`, tooltip: "No market update for 604s, which is 2s beyond this feed's expected delay." |
| Duplicate soak, 8 polls over 90s | **pass** — no duplicate buckets, ascending, ≤1 forming bar, settled bars immutable |
| Replay capture | **pass** — 1,370 real bars for NQ and ES, 2026-09-15 |
| Replay transport at 50× | **pass** — clock advanced 22:03→22:10 through the real session |
| Replay pause | **pass** — cursor held across 4s |
| Replay serves the recording, not live cache | **pass** — bars dated 2026-09-14, not today |

### Screenshots

`docs/milestones/m2-screenshots/` — `NQ-1m`, `NQ-5m`, `ES-1m`, `GC-1m`, `CL-1m`, plus the
replay panel and the DOM's depth-unavailable notice.

---

## 9. Bugs found and fixed during this milestone

Each was found by a test or by instrumenting live behaviour, not by inspection:

1. **Forming bar marked closed.** The cache decided "settled" from the *server* clock. On a
   10-minute delayed feed that marks the still-forming bucket final and freezes a partial
   candle into history. Settlement now propagates from the exchange clock through folding.
2. **Live row overwrote real volume.** The vendor appends a trailing row whose timestamp is
   the current market time, not a bucket boundary, with volume 0. Treated as a bar it wiped
   the bucket's real volume. It is now identified off-grid and dropped; the quote carries
   that price.
3. **Forming-bar merge replaced the vendor's aggregate.** For coarse timeframes this
   substituted a partial fold for the vendor's full bucket. The merge is now field-wise and
   gated on the exchange clock.
4. **`connect()` claimed CONNECTED unconditionally.** The vendor request swallows its own
   errors and never throws, so the terminal reported "connected" while every fetch failed.
5. **Cross-timeframe bar race.** Loading history is async but subscribing is not, so after a
   timeframe switch the new stream delivered bars into the old series. A 1D bucket time is
   also a valid 1m bucket time, so it silently corrupted an interior candle and threw
   `Cannot update oldest data`. Now gated on the timeframe the series actually holds.
6. **`switchProvider` froze the price.** It re-subscribed the *provider* directly, bypassing
   the service path that builds the aggregators, so bars arrived with nowhere to go.
7. **Republished bars rolled the live close backwards.** The vendor's bar array lags its own
   last-price field, so each poll reset the candle's close to a stale price. A price print
   inside a forming bucket now takes precedence; once settled, the exchange's close is final.
8. **Poll coalescing.** Subscribing eight instruments at start-up had seven requests swallowed
   by an in-flight guard. Requests are now queued, and `pollOnce()` resolves only when a poll
   covering the caller has genuinely finished.
9. **400 reported as 500.** The error handler flattened framework errors, and body-less
   control POSTs were rejected outright.

---

## 10. Known issues

1. The forming 1-minute candle shows `V 0` until the vendor publishes that minute's aggregate.
   This is the feed's own data, not a defect, but it looks odd next to settled bars.
2. `GET /marketdata/quote` calls `subscribe()` on every request, which inflates the
   reference count. Harmless today because nothing unsubscribes on that path, but it should
   read state rather than subscribe.
3. `nextOpen()` still scans minute-by-minute (carried over from M1).
4. The holiday calendar covers 2025–2027 only.
5. Replay emits bar-close events, so at 1× a 1-minute recording updates once a minute. Real
   intra-bar movement needs a tick-level recording, which needs a licensed feed.
6. Bar cache is unbounded; it needs a retention policy before long-running deployments.

## 11. Still mocked

**Nothing is mocked.** Every candle on screen came from the exchange-derived feed. Order
entry, positions and P&L remain *not implemented* and are labelled as such — they are not
fake, they are absent, and the UI says which milestone delivers them.

`TradingViewAdvancedChartsAdapter` is an explicit, throwing stub containing no TradingView
code. `advancedChartsAvailable()` returns false and the engine is never offered.

## 12. Required before Milestone 3

Nothing blocking. The chart adapter, market stream and aggregator are in place; Milestone 3
builds on them rather than replacing them.
