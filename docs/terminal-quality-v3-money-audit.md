# Atlas — Money Audit (Q-01: the phantom −$45,000)

**Symptom (manual):** an account displayed an open loss of roughly −$45,000 that
was never traded for.

Starting baseline `1b42ca0`. Branch `claude/futures-trading-simulator-v8qefu`.
This audit traces the whole money pipeline, reproduces the defect at its true
source, and states exactly what was changed and what remains.

## The pipeline, end to end

A position's money is one integer of micro-dollars throughout; there is no
floating-point money. The chain that turns a market price into a displayed loss:

```
provider payload (Yahoo delayed / Databento / replay)
  → normalize (NormalizedQuote/Trade)
  → MarketEventBus.publishQuote / publishTrade      [PriceIntegrity gate here]
  → QuoteStore.putQuote / putTrade                  (only if the bus accepted it)
  → QuoteStore.markPrice(root)                      (last, else mid of the book)
  → TradingEngine.markTicks / markTicksFor(spec,pos)  [era + contract lock here]
  → unrealizedPnlMicros(spec, position, markTicks)  = ticks * qty * tickValueMicros
  → valuation(): openPnlMicros, equityMicros = balance + openPnl
  → applyRules(...) on the SAME equity            (report == enforce)
  → WS push → web AccountBar / position readout
```

The arithmetic and units were audited and are correct: `ticksToMicros = ticks *
qty * spec.tickValueMicros`, one NQ tick = `5_000_000` micros ($5.00), and a live
1-lot NQ buy showed exactly −$5.00 for a one-tick adverse move. A −$45,000
figure is therefore **the correct formula applied to a wrong mark**: on NQ,
$45,000 = 9,000 ticks = 2,250 index points away from a real price. That is not a
small staleness drift — it is a *garbage* price that reached `markPrice`.

## Why order entry was safe but valuation was not

Order entry refuses a stale feed (`risk.ts` reads `freshness`). Valuation
deliberately does **not** gate on staleness, and that is correct: a stale-but-
plausible last price must still price a position and still be seen by the risk
rules, or a trader could dodge a max-loss breach simply by letting the feed go
quiet. (This invariant is fixed by `rules.integration.test.ts` — *"keeps the
account failed when the liquidation cannot fill"* — and must not be broken.)

So the −$45,000 is **not** a staleness bug. The mark itself was wrong. The fix
belongs in the data layer, where a wrong price is admitted — not in valuation,
which faithfully priced the number it was handed.

## Root cause: two ways a garbage price reached `markPrice`

Atlas already has a corroboration gate (`marketdata/price-integrity.ts`) wired
into the bus: a price far (>0.5%) from the last accepted one is quarantined
until a second observation agrees with it, so a lone bad print never becomes a
mark. A 2,250-point NQ jump is ~15× that tolerance, so it can only get through a
**bypass**. Two bypasses were found and fixed.

### Hole 1 — re-anchor after silence, during an OPEN market (primary)

`price-integrity.ts` re-anchors — accepts a far price with **no** corroboration —
once the feed has been quiet longer than `reanchorAfterMs` (120 s). That is
correct across a genuine session gap (a weekend really did move the market
behind a closed door). But the free delayed feed goes quiet for minutes at a
time *while the market is open* (poll backoff up to 60 s, thin overnight
spacing, vendor hiccups). A single garbage print after such an intraday silence
used to re-anchor straight through and become the mark on every open position.

**Fix:** a re-anchor now also requires the gap to have spanned a period the
market was actually **closed** (weekend, overnight, holiday, or the daily
maintenance break), tested with `getMarketState` at both ends and the midpoint
of the gap. An intraday feed hiccup — market open throughout — no longer
re-anchors; a far price then must corroborate like any other. Genuine session
gaps still re-anchor exactly as before (proven by the existing weekend test and
a new Friday→Sunday test). A real fast move is unaffected: it corroborates on
the next print and is accepted one observation late, by design.

### Hole 2 — mid-only / crossed-book bypass (latent)

`bus.publishQuote` ran the integrity gate only when `quote.last != null`. A quote
carrying only bid/ask (Databento MBP-1 realtime, replayed book quotes) skipped
the gate entirely, and `QuoteStore.markPrice` then returned `(bid+ask)/2` with no
check that the book was even two-sided and uncrossed. A crossed or blown book
(`bid > ask`) produced a garbage mid. Not exercised by the current Yahoo feed
(which always sets `last`), so this is latent today and live once the realtime
feed is enabled.

**Fix:** the bus now gates whatever price would actually be used as the mark —
the last trade, else the mid of a real two-sided **uncrossed** book — so a
mid-only quote is corroborated too. `markPrice` independently refuses a crossed
or one-sided book and returns `null` (UNKNOWN) rather than a manufactured price;
an unmarkable position already propagates to UNKNOWN account P&L (no number
shown), never to a wrong number or a zero.

## What was changed

| File | Change |
| --- | --- |
| `apps/server/src/marketdata/price-integrity.ts` | Re-anchor only when the silence spanned a market-closed period (`gapSpannedAClosure` via `getMarketState`). |
| `apps/server/src/marketdata/bus.ts` | Integrity gate now covers the mid-only path (gates last, else uncrossed two-sided mid). |
| `apps/server/src/marketdata/quote-store.ts` | `markPrice` refuses a crossed/one-sided book mid → UNKNOWN, not a fabricated price. |
| `apps/server/src/marketdata/mark-integrity-holes.test.ts` | New: reproduces both holes (failing pre-fix), and pins the session-gap / real-move cases that must still pass. |

No change was made to valuation, the rules, or the money arithmetic: they were
correct. The engine's `markTicksFor` era-lock and contract-lock (which already
fixed an *earlier* −$45,000 from a replay-era mismatch, see
`docs/market-integrity.md` P0.4) are unchanged and still hold.

## Money invariants (verified)

- 1 NQ contract, 1 tick adverse = exactly −$5.00 (live and in
  `pnl-reconciliation.test.ts`).
- Per-instrument money conservation across NQ/MNQ/ES/MES/GC/MGC/CL/MCL is pinned
  by `pnl-reconciliation.test.ts` (12/12 in isolation).
- An unmarkable position ⇒ account open P&L and equity are UNKNOWN (null), never
  a number, so a missing/again-rejected mark can never show as a loss or a zero.
- A stale-but-plausible feed still prices the position and is still seen by the
  rules (the max-loss-evasion invariant), unchanged.

## Known limitations (honest residuals)

- **Two corroborating garbage prints.** If the vendor returns the *same* wrong
  value on two consecutive polls (within 0.5% of each other), corroboration
  accepts it — by design the gate cannot distinguish a persistent vendor fault
  from a real move on price alone. This is a property of a corroboration gate,
  not a regression; catching it needs a second independent source. Documented,
  not fixed this milestone.
- **Same-root wrong-contract value.** A price for the correct root/era/contract
  that is simply wrong in value (e.g. a continuous-vs-front-month divergence,
  ~300 pts on NQ) is used verbatim; the era/contract locks guard source and roll
  mismatches, not value. Below the 2,250-pt phantom on its own.
- **Legacy positions** with `marketEra === null` or `contractCode === null` skip
  the era/contract locks and mark against the current feed. Pre-dates the locks;
  amplifier only.
- **Ungated trades.** `publishTrade` has no integrity check; trades feed the
  aggregator and buffer but not `markPrice` directly, so they do not fabricate a
  mark today.

## Verification

- `apps/server/src/marketdata/` — **95/95** pass, including the new
  `mark-integrity-holes` reproduction (fails pre-fix, passes post-fix) and every
  existing corroboration/re-anchor/gap/negative-price case.
- Mark-dependent trading files in isolation: `pnl-reconciliation` 12/12,
  `rules.integration` 14/14, `contract-lock` 3/3, `engine` 58/58, `adversarial`
  10/10, `determinism` 3/3.
- Server typecheck clean.
- Full-directory server runs show ~8 failures in the determinism / adversarial /
  engine-timing / pnl-foreign-market family; each of those files passes 100% in
  isolation both with and without this change (baseline had the same family of
  failures, a different overlapping set), i.e. pre-existing full-directory
  nondeterminism, not this change.
