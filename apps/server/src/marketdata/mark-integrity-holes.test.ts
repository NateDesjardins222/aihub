/**
 * Q-01 (the phantom −$45,000): the two data-layer holes through which a garbage
 * price reached `markPrice` and became an open position's mark.
 *
 * These reproduce the defect first (they FAIL against the pre-fix code) and then
 * lock in the fix:
 *
 *   1. RE-ANCHOR DURING AN OPEN MARKET. The corroboration gate re-anchors — i.e.
 *      accepts a far price with no second opinion — once the feed has been quiet
 *      longer than `reanchorAfterMs` (120 s). That is correct across a session
 *      gap (a weekend really did move the market), but WRONG for an intraday
 *      feed hiccup: the free delayed feed goes quiet for minutes at a time while
 *      the market is open, and a single garbage print after that silence used to
 *      re-anchor straight through. A re-anchor must require the gap to have
 *      spanned a period the market was actually closed.
 *
 *   2. MID-ONLY / CROSSED-BOOK BYPASS. Integrity ran only when `quote.last` was
 *      set; a quote carrying only bid/ask slipped past it, and `markPrice` then
 *      returned `(bid+ask)/2` with no check that the book was even two-sided and
 *      uncrossed. A crossed or blown book produced a garbage mid.
 *
 * The genuine session gap, the real fast move, and the real two-sided book must
 * all still get through — those cases are asserted here too, and in
 * price-integrity.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { requireInstrument, getMarketState } from '@atlas/instruments';
import type { NormalizedQuote } from '@atlas/contracts';
import { PriceIntegrity } from './price-integrity.js';
import { MarketEventBus } from './bus.js';

const NQ = requireInstrument('NQ');

// A weekday time NQ's RTH is open (10:00 CT). Verified against the calendar so
// the "market open" premise of the intraday-hiccup case is real, not assumed.
const OPEN_TS = Date.UTC(2026, 8, 15, 15, 0, 0);

function quote(over: Partial<NormalizedQuote> & { exchangeTs: number }): NormalizedQuote {
  return {
    symbol: 'NQ',
    bid: null,
    bidSize: null,
    ask: null,
    askSize: null,
    last: null,
    lastSize: null,
    seq: over.exchangeTs,
    synthesizedBook: false,
    ...over,
  };
}

describe('Q-01 hole 1: re-anchor must not trust a lone print during an open market', () => {
  it('the premise holds — NQ RTH is open at the test timestamp', () => {
    expect(getMarketState(NQ, OPEN_TS).state).toBe('OPEN');
    // ...and still open two minutes later, so any gap here is a FEED gap.
    expect(getMarketState(NQ, OPEN_TS + 121_000).state).toBe('OPEN');
  });

  it('quarantines a far print after an intraday feed gap, instead of re-anchoring it', () => {
    const gate = new PriceIntegrity();
    expect(gate.check(NQ, 20_000, OPEN_TS, OPEN_TS)).toBe('ACCEPT');
    // 2,250 points away — a $45,000 phantom on one NQ — arriving 121 s later,
    // while the market is still open. Nothing corroborates it.
    const v = gate.check(NQ, 17_750, OPEN_TS + 121_000, OPEN_TS + 121_000);
    expect(v).toBe('QUARANTINE');
    // The garbage never became the price of anything.
    expect(gate.lastAccepted('NQ')).toBe(20_000);
  });

  it('still re-anchors across a genuine session gap (weekend), market closed between', () => {
    // Friday 10:00 CT (open) → Sunday 10:00 CT (before the 17:00 CT reopen, so
    // closed), with the whole weekend closed in between: a real gap that must
    // re-anchor, exactly as before.
    const fridayOpen = Date.UTC(2026, 8, 18, 15, 0, 0);
    const sundayClosed = fridayOpen + 2 * 86_400_000;
    expect(getMarketState(NQ, fridayOpen).state).toBe('OPEN');
    expect(getMarketState(NQ, sundayClosed).state).not.toBe('OPEN');

    const gate = new PriceIntegrity();
    gate.check(NQ, 20_000, fridayOpen, fridayOpen);
    expect(gate.check(NQ, 19_400, sundayClosed, sundayClosed)).toBe('ACCEPT');
    expect(gate.counts('NQ').reanchored).toBe(1);
  });

  it('a real intraday move still gets through, one corroborating print later', () => {
    const gate = new PriceIntegrity();
    gate.check(NQ, 20_000, OPEN_TS, OPEN_TS);
    // A fast 200-point move during open hours: held once, then confirmed.
    expect(gate.check(NQ, 19_800, OPEN_TS + 121_000, OPEN_TS + 121_000)).toBe('QUARANTINE');
    expect(gate.check(NQ, 19_798, OPEN_TS + 127_000, OPEN_TS + 127_000)).toBe('ACCEPT');
    expect(gate.lastAccepted('NQ')).toBe(19_798);
  });
});

describe('Q-01 hole 2: a mid-only / crossed book must not mark a position', () => {
  it('runs integrity on the mid when there is no last price', () => {
    const bus = new MarketEventBus();
    const seen: number[] = [];
    bus.onQuote('NQ', (q) => seen.push(q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : NaN));

    // A sane two-sided book around 20,000 is accepted.
    expect(bus.publishQuote(quote({ bid: 19_999.75, ask: 20_000.25, exchangeTs: OPEN_TS }))).toBe(true);
    // A book whose mid is 2,250 points away, with nothing to corroborate it, is
    // held back — it must not reach a consumer as a mark.
    expect(
      bus.publishQuote(quote({ bid: 17_749.75, ask: 17_750.25, exchangeTs: OPEN_TS + 3_000 })),
    ).toBe(false);
    expect(bus.getStats().droppedQuarantined).toBeGreaterThanOrEqual(1);
  });
});
