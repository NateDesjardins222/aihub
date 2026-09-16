import { describe, expect, it } from 'vitest';
import { INSTRUMENTS, getInstrument, requireInstrument, listInstruments } from './registry.js';
import {
  MICROS,
  microsToTicks,
  perSideFeesMicros,
  priceToTicks,
  realizedPnlMicros,
  tickSize,
  ticksPerPoint,
  ticksToMicros,
  ticksToPrice,
  isValidTickPrice,
  snapPrice,
  formatMicros,
} from './math.js';

const PHASE_1_PRODUCTS = ['NQ', 'MNQ', 'ES', 'MES', 'GC', 'MGC', 'CL', 'MCL'];

describe('instrument registry', () => {
  it('lists exactly the Phase 1 products', () => {
    expect(listInstruments().map((i) => i.root).sort()).toEqual([...PHASE_1_PRODUCTS].sort());
  });

  it('resolves case-insensitively and rejects unknown roots', () => {
    expect(getInstrument('nq')?.root).toBe('NQ');
    expect(getInstrument('ZZZ')).toBeUndefined();
    expect(() => requireInstrument('ZZZ')).toThrow(/UNKNOWN_INSTRUMENT/);
  });

  /**
   * The invariant that makes every downstream P&L number correct:
   * tickValue must equal pointValue * tickSize, exactly, for every product.
   */
  it('keeps tick value consistent with point value and tick size', () => {
    for (const spec of INSTRUMENTS) {
      const derived = spec.pointValueMicros * tickSize(spec);
      expect(derived, `${spec.root} tick value`).toBe(spec.tickValueMicros);
    }
  });

  it('keeps point value consistent with the published contract multiplier', () => {
    for (const spec of INSTRUMENTS) {
      expect(spec.pointValueMicros, `${spec.root} point value`).toBe(
        spec.contractMultiplier * MICROS,
      );
    }
  });

  it('gives every micro contract exactly one tenth of its full-size sibling', () => {
    for (const spec of INSTRUMENTS.filter((i) => i.isMicro)) {
      const full = requireInstrument(spec.fullSizeRoot!);
      expect(spec.tickValueMicros * 10, `${spec.root} vs ${full.root}`).toBe(full.tickValueMicros);
      expect(tickSize(spec)).toBe(tickSize(full));
    }
  });

  it('does not give the eight products a single shared tick value', () => {
    const distinct = new Set(INSTRUMENTS.map((i) => i.tickValueMicros));
    expect(distinct.size).toBeGreaterThan(1);
  });
});

describe('published contract specifications', () => {
  const expected: Record<string, { tick: number; tickValue: number; point: number }> = {
    NQ: { tick: 0.25, tickValue: 5, point: 20 },
    MNQ: { tick: 0.25, tickValue: 0.5, point: 2 },
    ES: { tick: 0.25, tickValue: 12.5, point: 50 },
    MES: { tick: 0.25, tickValue: 1.25, point: 5 },
    GC: { tick: 0.1, tickValue: 10, point: 100 },
    MGC: { tick: 0.1, tickValue: 1, point: 10 },
    CL: { tick: 0.01, tickValue: 10, point: 1000 },
    MCL: { tick: 0.01, tickValue: 1, point: 100 },
  };

  for (const [root, exp] of Object.entries(expected)) {
    it(`${root} matches the exchange specification`, () => {
      const spec = requireInstrument(root);
      expect(tickSize(spec)).toBeCloseTo(exp.tick, 10);
      expect(spec.tickValueMicros / MICROS).toBeCloseTo(exp.tickValue, 10);
      expect(spec.pointValueMicros / MICROS).toBeCloseTo(exp.point, 10);
    });
  }
});

describe('tick arithmetic', () => {
  it('round-trips prices through ticks without drift', () => {
    const cases: Array<[string, number]> = [
      ['NQ', 20_145.25],
      ['NQ', 29_472.75],
      ['ES', 6_812.5],
      ['GC', 4_386.3],
      ['GC', 2_050.0],
      ['CL', 78.94],
      ['MCL', 61.07],
    ];
    for (const [root, price] of cases) {
      const spec = requireInstrument(root);
      const ticks = priceToTicks(spec, price);
      expect(Number.isInteger(ticks)).toBe(true);
      expect(ticksToPrice(spec, ticks)).toBeCloseTo(price, 10);
    }
  });

  it('validates tick alignment per instrument', () => {
    const nq = requireInstrument('NQ');
    expect(isValidTickPrice(nq, 20_145.25)).toBe(true);
    expect(isValidTickPrice(nq, 20_145.1)).toBe(false);
    expect(isValidTickPrice(nq, 20_145.5)).toBe(true);

    const cl = requireInstrument('CL');
    expect(isValidTickPrice(cl, 78.94)).toBe(true);
    expect(isValidTickPrice(cl, 78.945)).toBe(false);

    const gc = requireInstrument('GC');
    expect(isValidTickPrice(gc, 2_050.1)).toBe(true);
    expect(isValidTickPrice(gc, 2_050.15)).toBe(false);
  });

  it('snaps off-tick prices to the nearest valid tick', () => {
    const nq = requireInstrument('NQ');
    expect(snapPrice(nq, 20_145.3)).toBeCloseTo(20_145.25, 10);
    expect(snapPrice(nq, 20_145.4)).toBeCloseTo(20_145.5, 10);
    const gc = requireInstrument('GC');
    expect(snapPrice(gc, 2_050.17)).toBeCloseTo(2_050.2, 10);
  });

  it('reports ticks per point per instrument', () => {
    expect(ticksPerPoint(requireInstrument('NQ'))).toBe(4);
    expect(ticksPerPoint(requireInstrument('GC'))).toBe(10);
    expect(ticksPerPoint(requireInstrument('CL'))).toBe(100);
  });
});

describe('P&L uses the correct contract specification', () => {
  it('values a 60-tick NQ move at $300 per contract', () => {
    const nq = requireInstrument('NQ');
    expect(ticksToMicros(nq, 60, 1)).toBe(300 * MICROS);
    expect(ticksToMicros(nq, 60, 2)).toBe(600 * MICROS);
  });

  it('values the same 60-tick move differently on every product', () => {
    const results = PHASE_1_PRODUCTS.map(
      (r) => ticksToMicros(requireInstrument(r), 60, 1) / MICROS,
    );
    expect(results).toEqual([300, 30, 750, 75, 600, 60, 600, 60]);
  });

  it('computes realized P&L for a long and a short symmetrically', () => {
    const nq = requireInstrument('NQ');
    const entry = priceToTicks(nq, 20_100);
    const exit = priceToTicks(nq, 20_110);
    expect(realizedPnlMicros(nq, entry, exit, 2, 1)).toBe(400 * MICROS); // +10 pts * $20 * 2
    expect(realizedPnlMicros(nq, entry, exit, 2, -1)).toBe(-400 * MICROS);
  });

  it('computes ES P&L using the $50 multiplier, not NQ’s $20', () => {
    const es = requireInstrument('ES');
    const entry = priceToTicks(es, 5_000);
    const exit = priceToTicks(es, 5_010);
    expect(realizedPnlMicros(es, entry, exit, 1, 1)).toBe(500 * MICROS);
  });

  it('computes CL P&L using the $1,000 multiplier', () => {
    const cl = requireInstrument('CL');
    const entry = priceToTicks(cl, 78.0);
    const exit = priceToTicks(cl, 78.5);
    expect(realizedPnlMicros(cl, entry, exit, 1, 1)).toBe(500 * MICROS);
  });

  it('computes GC P&L using the 100 oz multiplier', () => {
    const gc = requireInstrument('GC');
    const entry = priceToTicks(gc, 2_000.0);
    const exit = priceToTicks(gc, 2_003.5);
    expect(realizedPnlMicros(gc, entry, exit, 1, 1)).toBe(350 * MICROS);
  });

  it('converts a dollar risk budget to ticks per instrument', () => {
    expect(microsToTicks(requireInstrument('NQ'), 500 * MICROS, 1)).toBe(100);
    expect(microsToTicks(requireInstrument('MNQ'), 500 * MICROS, 1)).toBe(1000);
    expect(microsToTicks(requireInstrument('ES'), 500 * MICROS, 2)).toBe(20);
  });

  it('charges fees per side and per contract', () => {
    const nq = requireInstrument('NQ');
    expect(perSideFeesMicros(nq, 1)).toBe(
      nq.commissionPerSideMicros + nq.exchangeFeesPerSideMicros,
    );
    expect(perSideFeesMicros(nq, 3)).toBe(3 * perSideFeesMicros(nq, 1));
  });

  it('formats money without floating point artifacts', () => {
    expect(formatMicros(-600 * MICROS)).toBe('-$600.00');
    expect(formatMicros(1_234_567_890)).toBe('$1,234.57');
    expect(formatMicros(250 * MICROS, { sign: true })).toBe('+$250.00');
  });
});
