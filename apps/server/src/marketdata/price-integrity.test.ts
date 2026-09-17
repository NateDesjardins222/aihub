/**
 * The isolated far-away candle, reproduced and then prevented.
 *
 * The sequence in the first test is the defect as it was observed: a healthy
 * stream of NQ prices around 29,700, one print at 27,450, then the stream
 * carrying on as if nothing had happened. That single print used to open a
 * candle of its own two thousand points below the market AND become the mark
 * that priced every open position.
 *
 * The rest of the file is about what must NOT change: a real fast move, a
 * weekend gap, a session open, and crude oil's genuine negative settlement in
 * April 2020 all have to survive.
 */
import { describe, expect, it } from 'vitest';
import { requireInstrument } from '@atlas/instruments';
import { MarketEventBus } from './bus.js';
import { PriceIntegrity } from './price-integrity.js';

const NQ = requireInstrument('NQ');
const CL = requireInstrument('CL');

/** Exchange timestamps two seconds apart, like the delayed feed's polls. */
const at = (step: number): number => Date.UTC(2026, 8, 17, 15, 0, 0) + step * 2_000;

describe('an isolated far-away price', () => {
  it('is held back, and the stream it interrupted continues', () => {
    const gate = new PriceIntegrity();
    const verdicts = [29_700, 29_702.25, 29_698.5, 27_450, 29_701, 29_703.75].map((price, i) =>
      gate.check(NQ, price, at(i), at(i)),
    );

    expect(verdicts).toEqual([
      'ACCEPT',
      'ACCEPT',
      'ACCEPT',
      // 2,250 points away, with nothing to corroborate it.
      'QUARANTINE',
      'ACCEPT',
      'ACCEPT',
    ]);
    // The outlier never became the price of anything.
    expect(gate.lastAccepted('NQ')).toBe(29_703.75);
    const counts = gate.counts('NQ');
    expect(counts.quarantined).toBe(1);
    expect(counts.discarded).toBe(1);
    expect(counts.released).toBe(0);

    // And it is on the record, with the arithmetic that condemned it.
    const anomaly = gate.recent().find((a) => a.price === 27_450);
    expect(anomaly?.verdict).toBe('QUARANTINE');
    expect(anomaly?.deviation).toBeCloseTo(0.0759, 3);
  });

  it('never reaches a consumer of the bus', () => {
    const bus = new MarketEventBus();
    const seen: number[] = [];
    bus.onQuote('NQ', (q) => seen.push(q.last!));

    const quote = (price: number, step: number) => ({
      symbol: 'NQ',
      exchangeTs: at(step),
      bid: null,
      bidSize: null,
      ask: null,
      askSize: null,
      last: price,
      lastSize: null,
      seq: step,
      synthesizedBook: false,
    });

    expect(bus.publishQuote(quote(29_700, 0))).toBe(true);
    expect(bus.publishQuote(quote(27_450, 1))).toBe(false);
    expect(bus.publishQuote(quote(29_701, 2))).toBe(true);

    expect(seen).toEqual([29_700, 29_701]);
    expect(bus.getStats().droppedQuarantined).toBe(1);
  });

  it('does not block the believable price that follows it', () => {
    // The held price must not advance the symbol's clock, or the next quote
    // would look out of order and be dropped for the wrong reason.
    const bus = new MarketEventBus();
    const seen: number[] = [];
    bus.onQuote('ES', (q) => seen.push(q.last!));
    const quote = (price: number, step: number) => ({
      symbol: 'ES',
      exchangeTs: at(step),
      bid: null,
      bidSize: null,
      ask: null,
      askSize: null,
      last: price,
      lastSize: null,
      seq: step,
      synthesizedBook: false,
    });
    bus.publishQuote(quote(7_700, 0));
    bus.publishQuote(quote(5_100, 1));
    bus.publishQuote(quote(7_701, 2));
    expect(seen).toEqual([7_700, 7_701]);
  });
});

describe('what must still get through', () => {
  it('accepts a genuine fast move once a second print confirms it', () => {
    const gate = new PriceIntegrity();
    gate.check(NQ, 29_700, at(0), at(0));
    // A news spike: 300 points in one observation, and it STAYS there.
    expect(gate.check(NQ, 29_400, at(1), at(1))).toBe('QUARANTINE');
    expect(gate.check(NQ, 29_395, at(2), at(2))).toBe('ACCEPT');
    expect(gate.lastAccepted('NQ')).toBe(29_395);
    expect(gate.counts('NQ').released).toBe(1);
    // From there the move continues normally, one observation at a time.
    expect(gate.check(NQ, 29_360, at(3), at(3))).toBe('ACCEPT');
  });

  it('re-anchors across a session gap instead of questioning it', () => {
    const gate = new PriceIntegrity();
    gate.check(NQ, 29_700, at(0), at(0));
    // Friday close to Sunday open: a real gap in a real market, and the chart
    // must show it.
    const sundayOpen = at(0) + 2 * 86_400_000;
    expect(gate.check(NQ, 29_100, sundayOpen, sundayOpen)).toBe('ACCEPT');
    expect(gate.counts('NQ').reanchored).toBe(1);
    expect(gate.counts('NQ').quarantined).toBe(0);
  });

  it('accepts a bar whose range covers where the market was', () => {
    const gate = new PriceIntegrity();
    gate.check(NQ, 29_700, at(0), at(0));
    const verdict = gate.checkBar(
      NQ,
      { open: 29_700, high: 29_780, low: 29_690, close: 29_775, time: at(1) },
      at(1),
    );
    expect(verdict).toBe('ACCEPT');
    expect(gate.lastAccepted('NQ')).toBe(29_775);
  });

  it('holds a bar that is nowhere near the market, and lets the next one through', () => {
    const gate = new PriceIntegrity();
    gate.check(NQ, 29_700, at(0), at(0));
    expect(
      gate.checkBar(
        NQ,
        { open: 27_400, high: 27_460, low: 27_390, close: 27_450, time: at(1) },
        at(1),
      ),
    ).toBe('QUARANTINE');
    expect(
      gate.checkBar(
        NQ,
        { open: 29_700, high: 29_710, low: 29_695, close: 29_705, time: at(2) },
        at(2),
      ),
    ).toBe('ACCEPT');
  });

  it('keeps crude oil’s negative settlement, which really happened', () => {
    const gate = new PriceIntegrity();
    // 20 April 2020: WTI settled at -$37.63. It is real history and Atlas
    // serves it; a gate that "knew" prices cannot be negative would erase it.
    const monday = Date.UTC(2020, 3, 20, 19, 30, 0);
    gate.check(CL, 10.01, monday - 3_600_000, monday - 3_600_000);
    expect(gate.check(CL, -37.63, monday, monday)).not.toBe('REJECT');
  });

  it('refuses what cannot be a price at all', () => {
    const gate = new PriceIntegrity();
    expect(gate.check(NQ, Number.NaN, at(0), at(0))).toBe('REJECT');
    expect(gate.check(NQ, null, at(1), at(1))).toBe('REJECT');
    // An index future cannot trade at zero; crude can.
    expect(gate.check(NQ, 0, at(2), at(2))).toBe('REJECT');
    expect(gate.counts('NQ').rejected).toBe(3);
  });

  it('gives up on a held price rather than remembering it for ever', () => {
    const gate = new PriceIntegrity({ quarantineTtlMs: 5_000 });
    gate.check(NQ, 29_700, at(0), 1_000);
    expect(gate.check(NQ, 27_450, at(1), 2_000)).toBe('QUARANTINE');
    // The same wrong price again, but much later: it is a fresh outlier, not
    // corroboration of the old one.
    expect(gate.check(NQ, 27_450, at(2), 60_000)).toBe('QUARANTINE');
    expect(gate.counts('NQ').released).toBe(0);
  });
});
