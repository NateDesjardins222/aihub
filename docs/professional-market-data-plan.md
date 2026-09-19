# Professional market data: architecture autopsy and plan

Phase 0 of the Professional Market Data milestone. Written from the code as it
stands, before anything is pulled apart.

The first finding is worth stating up front, because it changes the shape of
the work: **Atlas's market-data architecture is already provider-neutral.**
The brief assumes a rewrite; what the code needs is a *new adapter*, a real
contract model, and the validation apparatus to prove any of it. The layering
the brief asks for largely exists and is load-bearing.

---

## 1. The path a price takes today

```
 yahoo.ts (734 lines)            the ONLY vendor-aware file
   HTTP poll → parse → normalize.ts → NormalizedBar / NormalizedQuote
        │
        ▼
 MarketDataProvider (provider.ts, 96 lines)
   connect/disconnect/subscribe/unsubscribe/getHistoricalBars/getQuote/era()
        │
        ▼
 MarketEventBus (bus.ts, 234 lines)
   per-symbol monotonic sequence
   drops events whose exchange timestamp regresses  ← reconnect cannot rewind
   drops byte-identical duplicates
   PriceIntegrity quarantine (price-integrity.ts, 323 lines)
   LatencyRecorder (latency.ts, 181 lines)
        │
        ├──► QuoteStore (quote-store.ts) ── freshness: FRESH/STALE/MARKET_CLOSED/NO_DATA
        │                                   blocksOrderEntry → the risk engine reads this
        │
        └──► CandleAggregator (@atlas/core) per symbol
                 │
                 ▼
          BarService (bar-service.ts, 365 lines) — history + cache + integrity
                 │
                 ▼
          MarketDataGateway → WebSocket frames (md.bar.SYM.TF, md.quote.SYM)
                 │
                 ▼
          browser: MarketStream → ChartAdapter → canvas
                                → TradingEngine marks positions
```

### What is already right

| capability | where | state |
| --- | --- | --- |
| Vendor isolation | `provider.ts` | one interface, one vendor file; the rest of the platform is clean |
| Sequencing, duplicate and regression handling | `bus.ts` | implemented, with counters |
| Market era identity | `provider.era()` | stored on open positions; a stale mark cannot price a position from another era |
| Freshness that blocks order entry | `quote-store.ts` | `blocksOrderEntry` is consumed by `risk.ts` |
| Subscription reference counting | `service.ts` | one upstream subscription per root, counted |
| Latency recording | `latency.ts` + `market/latency.ts` | server half and browser half, against a shared `observedAt` |
| Replay provider | `providers/replay.ts` | a second implementation of the same interface — the abstraction is already proven twice |
| Integer prices | throughout | prices are integer ticks, money is integer micro-dollars |

### Where the provider's assumptions have leaked

Found by reading, each with its consequence:

1. **`expectedDelayMs: provider.mode === 'DELAYED' ? 600_000 : 0`** in
   `service.ts` — ten minutes is hard-coded as *the* delayed-mode constant. The
   provider is currently reporting **21,317 s** of delay (observed in the server
   log this session, market closed), so this number is neither the provider's
   truth nor a safe default. It belongs on the provider, as a declared
   capability.
2. **`baseTimeframe`** — the whole aggregation chain starts from 1-minute bars
   because that is Yahoo's floor. A tick feed makes this wrong: the base should
   be trades, with bars derived.
3. **OHLCV-shaped ingestion.** `ProviderEvent` has `trade`, `quote`, `bar` and
   `depth`, but the live path is fed `bar` events. Nothing downstream is wrong;
   nothing downstream has ever been exercised by a real trade stream.
4. **Continuous symbols as identity.** `NQ` is the root *and* the tradeable
   thing. `instruments` carries an `activeContract` with a code (NQZ26) but the
   engine stores positions against the root, and the provider subscribes to a
   root. A real contract model has to thread `NQZ26` end to end.
5. **No bid/ask anywhere in the live path.** `getDepth()` returns null by
   design and the UI says so honestly ("no bid/ask block: this feed has no
   book, and none is invented"). The plumbing exists; nothing fills it.
6. **Session knowledge lives in `@atlas/instruments`**, not in provider data.
   Holidays and early closes are the gap detector's blind spot.
7. **Float noise on some commodities** — observed previously on GC/CL; the
   integrity layer quarantines outliers, which is a symptom-level defence.

---

## 2. Target architecture

The brief's chain, mapped onto what exists, with the new work marked:

| stage | today | target |
| --- | --- | --- |
| Provider | `yahoo.ts` polling | **new:** `databento.ts` adapter (historical first) |
| Provider interface | `provider.ts` | **refine:** declared delay, capabilities per dataset, contract-aware subscribe |
| Normalized events | trade/quote/bar/depth | **refine:** sequence + both timestamps mandatory on trades/quotes |
| Integrity/sequencing | `bus.ts` | **extend:** provider-specific semantics rather than Yahoo-shaped rules |
| Tick+quote engine | quote store | **extend:** real trade stream, real top of book |
| Candle aggregation | `CandleAggregator` | **extend:** build from trades, not from vendor bars |
| History/gap fill | `BarService` | **extend:** contract-aware, session-aware gap detection |
| Market state | service | unchanged in shape |
| Distribution | gateway | **measure:** bytes/sec, incremental updates |
| Chart/execution/journal | unchanged | **prove unchanged** by regression |

**The contract model is further along than it first appeared, and this
document was wrong about it for an hour.** `packages/contracts/src/instrument.ts`
already carries a `RollRule` with QUARTERLY / MONTHLY / CUSTOM cycles and three
expiry rules (third Friday, business days before a day of month, business days
before month end), plus `rollDaysBeforeExpiry`; `packages/instruments/src/contracts.ts`
resolves an `ActiveContract` with its code, display name, month, year, last
trading day and roll date; session windows, maintenance windows and holidays
are modelled; and `providerSymbols` is already keyed by provider. The claim
that a contract model had to be built from nothing was made before that file
was read, and is withdrawn.

What is genuinely missing is narrower and more specific:

* **Contract identity does not reach the database.** Positions and orders are
  stored against the ROOT. Nothing records that a position was opened in
  NQZ26, which is what makes "a futures order belongs to a specific contract"
  true rather than implied.
* **No next contract, no manual override, no roll transition state**, and no
  historical contract identity for a trade taken before a roll.
* **The continuous chart and the tradeable contract are the same object**, so
  there is nowhere to express "you are looking at continuous NQ and trading
  NQZ26".

---

## 3. Migration strategy

1. Databento adapter against **historical** data only (no exchange licence
   needed, free credits). Build the contract model from its symbology.
2. Fixture-record real responses; every audit runs against fixtures in CI.
3. Run Yahoo and Databento side by side for the same contract/window and diff
   the candles — this is the independent validation the brief asks for, and it
   is available without live entitlements.
4. Live streaming only once credentials exist. Until then the live path is
   exercised by the replay provider and by a deterministic synthetic tick
   generator, and is **labelled as such** in every report.
5. Yahoo stays as the development/fallback provider, clearly labelled, and may
   never masquerade as real-time.

**Rollback** is a one-line provider swap, which is the property the existing
architecture already has and this milestone must not lose.

---

## 4. Validation methodology

* **Candle forensics** — expected vs Atlas bars for a contract/timeframe/window,
  printing every mismatching timestamp with the field that differs. Not "99.8%".
* **Tick grid** — every price divisible by the instrument's tick size, per
  instrument, with counts of violations.
* **Session-aware gaps** — a missing bar inside a known closed session is not a
  gap; anything else is, and is recorded.
* **Latency, in segments** — exchange→receive, receive→normalized,
  normalized→socket, socket→browser, browser→series, series→paint, reported
  separately. Never one number.
* **Regression** — the whole existing suite, plus Execution V2's, run against
  the new path. A market-data change that moves a P&L is a failure.

---

## 5. External boundary — what this milestone cannot do alone

Per Phase 66, stated plainly rather than worked around:

* **No provider credentials exist.** No Databento key, no dxFeed contract, no
  Rithmic/FCM relationship. No live professional tick can be produced, and none
  will be simulated and called live.
* **No exchange licence exists**, so redistribution to end users cannot be
  demonstrated, only designed.
* What I need is listed at the end of
  `docs/market-data-provider-evaluation.md`.

Everything up to that boundary — adapter, contract model, normalisation,
fixtures, aggregation, gap detection, audits, forensics, regression — can be
built and proven, and that is what the implementation phases will do.

---

## 6. Status of this document

Phase 0 autopsy: **complete**. Phase 1 research: **complete**, in
`docs/market-data-provider-evaluation.md`. Phase 2 recommendation: **Databento
first, dxFeed conversation in parallel, Rithmic deferred** — with the reasoning
and the switching triggers recorded there.

Implementation has not started, and is gated on the decision points in §7 of
the evaluation document.
