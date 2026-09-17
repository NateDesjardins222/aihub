# P0 — data and financial integrity

What was wrong, how it was found, and what the numbers do now. Everything
below was reproduced against the running application; nothing in it is
inferred from reading the code.

## 1. The P&L defect

### Root cause

**Market data is global in Atlas; accounts are not.** Starting a practice
session swapped the platform's entire market-data provider, and every open
position was then priced at the recording's market instead of the one it was
opened in.

Three separate faults made that catastrophic rather than merely wrong:

1. **No provenance.** A position had no idea which market it was opened
   against, so any mark for its symbol was applied to it.
2. **Missing marks were reported as zero.** `unrealizedPnlMicros` returned 0
   when it had no mark. Zero is not "unknown" - it is the specific claim that
   the position is flat.
3. **The anchors moved anyway.** `advanceDrawdown` raised the high-water mark
   from `Math.max(hwm, equity)` on whatever equity it was handed, and a
   high-water mark never comes back down. That is ledger damage, not display.

### Reproduction, before the fix

A long opened on the live feed, then a practice replay of an earlier session:

```
2. long 1 NQ at the live price
   NQ mark 29763      position LONG 1 @ 29763.25
   openPnl $-5.00     day $-110.38    equity $99896.55
3. SAME position, practice replay running
   NQ mark 29467.25   position LONG 1 @ 29763.25
   openPnl $-5920.00  day $-5920.00   equity $93981.55
5. back on the live feed
   NQ mark 29760.25   position LONG 1 @ 29763.25
   openPnl $-60.00    day $-60.00     equity $99841.55
```

The position never moved. Only the market under it did. The magnitude is the
distance between the two markets, which is why a recording from an era 2,250
points away reports about **-$45,000** on one contract - the figure that
started this investigation.

The damage was not only on screen. Seven accounts in the development database
carry a high-water mark up to **$2,610 above their starting balance with zero
realized P&L**, which is this mechanism marking equity upwards and committing
it.

### After the fix

```
loading recording: NQ-2026-09-15-hist
  provider switch -> 400 OPEN_POSITION_BLOCKS_SWITCH
  "Close what is open first. Practice 150K is holding a position or a working
   order, and changing the market it is priced against would change what the
   account is worth."
3. SAME position, practice replay running
   NQ mark 29716      position LONG 1 @ 29717
   openPnl $-20.00    day $-58.45     equity $99775.41
```

* A position records its **market era** on the opening fill, and a mark from
  another era does not apply to it.
* An inapplicable or missing mark means **unknown**: open P&L, equity, day P&L
  and remaining drawdown are null together, the terminal shows a dash, and the
  header shows `NOT PRICED` with the reason.
* The rules **do not run** on an account that cannot be priced: no breach is
  claimed and no anchor moves.
* Changing the market under an open position is **refused**.
* An order that would realise a foreign market's price is refused
  (`POSITION_FROM_ANOTHER_MARKET`), as a backstop.

### Two more defects found while tracing it

* **Every trade in the journal was overstated by the entry commission.** The
  trade row carried only the closing side's fees while the account had been
  charged on both sides, so the journal's net P&L never summed to the
  account's realized change. Now the row carries the whole round turn, taken
  from the position's own accumulated entry fees so a partial close pays its
  share.
* **`/accounts/:id/pnl` re-derived equity, day P&L and drawdown from the
  account row** rather than from the engine. Two implementations of the same
  arithmetic is two answers to "what is my P&L". It now reports the engine's
  valuation - the same figures the rules are enforced on.
* **A practice account with no maximum loss reported its whole balance as
  "remaining drawdown"** - `DD LEFT $150.0K` on a $100,000 account. Where
  there is no drawdown rule there is now no figure.

### Deterministic evidence

`apps/server/src/trading/pnl-reconciliation.test.ts` takes a known entry, a
known exit and a known quantity for **NQ, MNQ, ES, MES, GC and CL**, computes
the expected dollars by hand from each instrument's published specification,
and demands the same number from the position, the account balance, the
equity, the day P&L, the trade row the journal reads, and the stored entry and
exit prices. It also covers the fee round turn and the market-era rules.

| instrument | trade | expected |
|---|---|---|
| NQ | long 2 @ 20,000 → 20,010 | 40 ticks × $5 × 2 = **$400** |
| MNQ | long 3 @ 20,000 → 20,010 | 40 ticks × $0.50 × 3 = **$60** |
| ES | short 1 @ 5,000 → 4,995 | 20 ticks × $12.50 = **$250** |
| MES | short 4 @ 5,000 → 5,002.50 | 10 ticks against × $1.25 × 4 = **-$50** |
| GC | long 1 @ 2,400 → 2,401 | 10 ticks × $10 = **$100** |
| CL | long 2 @ 80 → 79.50 | 50 ticks against × $10 × 2 = **-$1,000** |

## 2. The artificial price gaps

### What was ruled out first

A scan of what the API actually serves - 2,000 bars per timeframe for NQ, ES,
MNQ, GC and CL - found **no isolated spikes, no out-of-order timestamps and no
duplicate timestamps**, and the stored bars contain no malformed OHLC at all.
Quote and bar agreed to the cent on every poll over six polls of four
instruments. So the gaps were not sitting in storage.

One spike the scan did find is **real**: CL on 2020-04-20 closes at **-37.63**,
between neighbours at 18.27 and 10.01. WTI crude genuinely settled below zero
that day. It stays.

### Root cause

Instrumenting the live pipeline found it. `PriceIntegrity` records every price
the bus is asked to publish, and within a minute of start-up:

```
MNQ QUARANTINE 29462.75  lastAccepted 29721.25  0.87% away
     exchangeTs 04:09Z   received 20:50Z
GC  QUARANTINE 4333      lastAccepted 4382.10   1.12% away
     exchangeTs 04:00Z   received 20:50Z
```

The feed re-publishes **old observations** - a warm-up poll, a reconnect, a
vendor revising a bar. NQ really did trade at 29,462.75 at 04:09 and at
29,721.25 at 20:50; the price was right and its arrival was late. Two places
treated such an observation as the current price:

1. **`CandleAggregator.ingestPrice` created a bar for it.** A last price
   carries its own exchange timestamp, and a print stamped hours ago opened a
   bar in the middle of the history: one price, no volume, drawn as an
   isolated candle wherever that minute sat on the chart.
2. **The integrity anchor moved to it**, so the next genuine live price looked
   like a 0.87% jump and was itself questioned.

### The fix, and why it does not erase real gaps

* A print older than the newest bucket may **revise** a bar that exists; it
  never invents one.
* A bar for a bucket that has already passed is a **revision**, not a price:
  it reaches the history and does not become the anchor.
* Everything else goes through a **corroboration** gate. A price far from the
  last accepted one is held back, not published. If the next observation
  agrees, the market really moved and both are accepted - one observation
  late. If the next observation returns to where it was, the outlier is
  discarded and counted.

Genuine gaps survive by construction: a real move sustains itself, so it
corroborates; an overnight or weekend gap arrives after a long silence, which
re-anchors rather than questions; a single bad print never corroborates, and
it is the only thing removed. Nothing is interpolated, averaged or smoothed -
the only outcomes are "published as received" and "not published, and
counted".

### Where to look

`GET /api/v1/marketdata/diagnostics` now reports, per symbol:

```
integrity: { NQ: { accepted, quarantined, released, discarded, rejected, reanchored } }
recent:    [ { symbol, verdict, price, lastAccepted, deviation, exchangeTs, at, note } ]
```

`released` is a genuine fast move that arrived one observation late.
`discarded` is a bad print that never reached the chart or the mark.

### Regression tests

`apps/server/src/marketdata/price-integrity.test.ts` reproduces the isolated
far-away candle as a sequence - `29,700, 29,702.25, 29,698.5, 27,450, 29,701,
29,703.75` - and asserts the outlier is held, discarded, never published on
the bus, and never becomes the price of anything, while the stream it
interrupted continues. Alongside it: a genuine 300-point move that a second
print confirms, a weekend gap that re-anchors, a bar whose range covers the
market, crude's real negative settlement, and prices that are refused outright.

`packages/core/src/candles/candles.test.ts` covers the stale print that used
to create a bar in the past.
