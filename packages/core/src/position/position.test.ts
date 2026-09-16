import { describe, expect, it } from 'vitest';
import { requireInstrument, priceToTicks, MICROS } from '@atlas/instruments';
import {
  applyFill,
  avgEntryTicks,
  flatPosition,
  flattenQty,
  openTicks,
  reverseQty,
  sideOf,
  unrealizedPnlMicros,
  type PositionState,
} from './position.js';

const NQ = requireInstrument('NQ');
const ES = requireInstrument('ES');
const CL = requireInstrument('CL');
const MNQ = requireInstrument('MNQ');

const T0 = 1_700_000_000_000;

function px(spec: typeof NQ, price: number): number {
  return priceToTicks(spec, price);
}

function fill(signedQty: number, price: number, spec = NQ, fees = 0, ts = T0) {
  return { signedQty, priceTicks: px(spec, price), feesMicros: fees, exchangeTs: ts };
}

function open(spec: typeof NQ, signedQty: number, price: number): PositionState {
  return applyFill(spec, flatPosition(spec.root), fill(signedQty, price, spec)).position;
}

describe('opening and adding', () => {
  it('opens a long and records its cost basis exactly', () => {
    const p = open(NQ, 2, 20_000);
    expect(p.qty).toBe(2);
    expect(sideOf(p.qty)).toBe('LONG');
    expect(avgEntryTicks(NQ, p)).toBe(px(NQ, 20_000));
    expect(p.realizedPnlMicros).toBe(0);
    expect(p.openedAt).toBe(T0);
  });

  it('opens a short with a negative quantity and a negative basis', () => {
    const p = open(NQ, -3, 20_000);
    expect(p.qty).toBe(-3);
    expect(sideOf(p.qty)).toBe('SHORT');
    expect(p.costBasisMicros).toBeLessThan(0);
    // Average entry stays positive: it is a price, not a signed value.
    expect(avgEntryTicks(NQ, p)).toBe(px(NQ, 20_000));
  });

  /** The worked example from the brief. */
  it('computes a weighted average entry when adding to a long', () => {
    let p = open(NQ, 2, 20_000);
    p = applyFill(NQ, p, fill(1, 20_010)).position;
    expect(p.qty).toBe(3);
    // (20000*2 + 20010*1) / 3 = 20003.3333...
    const expected = (px(NQ, 20_000) * 2 + px(NQ, 20_010) * 1) / 3;
    expect(avgEntryTicks(NQ, p)).toBeCloseTo(expected, 9);
  });

  it('keeps a fractional average entry exact rather than rounding it away', () => {
    // 1 @ 20000.00 and 1 @ 20000.25 average to a half tick.
    let p = open(NQ, 1, 20_000);
    p = applyFill(NQ, p, fill(1, 20_000.25)).position;
    expect(avgEntryTicks(NQ, p)).toBeCloseTo(px(NQ, 20_000) + 0.5, 12);
  });

  it('accumulates fees across fills without touching P&L', () => {
    let p = open(NQ, 1, 20_000);
    p = applyFill(NQ, p, fill(1, 20_000, NQ, 2 * MICROS)).position;
    expect(p.feesMicros).toBe(2 * MICROS);
    expect(p.realizedPnlMicros).toBe(0);
  });
});

describe('unrealized P&L', () => {
  it('values a long move using the instrument tick value', () => {
    const p = open(NQ, 2, 20_000);
    // +10 points = 40 ticks * $5 * 2 contracts = $400
    expect(unrealizedPnlMicros(NQ, p, px(NQ, 20_010))).toBe(400 * MICROS);
    expect(unrealizedPnlMicros(NQ, p, px(NQ, 19_990))).toBe(-400 * MICROS);
  });

  it('values a short in the opposite direction', () => {
    const p = open(NQ, -2, 20_000);
    expect(unrealizedPnlMicros(NQ, p, px(NQ, 19_990))).toBe(400 * MICROS);
    expect(unrealizedPnlMicros(NQ, p, px(NQ, 20_010))).toBe(-400 * MICROS);
  });

  it('uses each instrument’s own multiplier, not a shared one', () => {
    const tenPoints = [
      [NQ, 20_000, 20_010, 200],
      [ES, 5_000, 5_010, 500],
      [MNQ, 20_000, 20_010, 20],
    ] as const;
    for (const [spec, entry, mark, dollars] of tenPoints) {
      const p = open(spec, 1, entry);
      expect(unrealizedPnlMicros(spec, p, px(spec, mark)), spec.root).toBe(dollars * MICROS);
    }
    // Crude moves in cents, not index points.
    const cl = open(CL, 1, 78.0);
    expect(unrealizedPnlMicros(CL, cl, px(CL, 78.5))).toBe(500 * MICROS);
  });

  it('is zero when flat, and when there is no mark price', () => {
    expect(unrealizedPnlMicros(NQ, flatPosition('NQ'), px(NQ, 20_000))).toBe(0);
    expect(unrealizedPnlMicros(NQ, open(NQ, 1, 20_000), null)).toBe(0);
  });

  it('reports open ticks per contract for display', () => {
    const p = open(NQ, 3, 20_000);
    expect(openTicks(NQ, p, px(NQ, 20_005))).toBe(20);
    const s = open(NQ, -3, 20_000);
    expect(openTicks(NQ, s, px(NQ, 20_005))).toBe(-20);
  });
});

describe('reducing and closing', () => {
  it('realizes P&L on a partial close and keeps the average entry', () => {
    const p = open(NQ, 3, 20_000);
    const r = applyFill(NQ, p, fill(-1, 20_010));
    expect(r.position.qty).toBe(2);
    expect(r.grossRealizedMicros).toBe(200 * MICROS); // 40 ticks * $5 * 1
    expect(avgEntryTicks(NQ, r.position)).toBe(px(NQ, 20_000));
    expect(r.closedLots).toHaveLength(1);
    expect(r.closedLots[0]!.qty).toBe(1);
    expect(r.closedLots[0]!.side).toBe('LONG');
    expect(r.reversed).toBe(false);
  });

  it('flattens exactly and leaves no residual basis', () => {
    const p = open(NQ, 3, 20_000);
    const r = applyFill(NQ, p, fill(-3, 20_010));
    expect(r.position.qty).toBe(0);
    expect(r.position.costBasisMicros).toBe(0);
    expect(r.position.openedAt).toBeNull();
    expect(r.grossRealizedMicros).toBe(600 * MICROS);
    expect(sideOf(r.position.qty)).toBe('FLAT');
  });

  it('closes a short for a profit when price falls', () => {
    const p = open(NQ, -2, 20_000);
    const r = applyFill(NQ, p, fill(2, 19_990));
    expect(r.position.qty).toBe(0);
    expect(r.grossRealizedMicros).toBe(400 * MICROS);
    expect(r.closedLots[0]!.side).toBe('SHORT');
  });

  it('accumulates realized P&L across successive closes', () => {
    let p = open(NQ, 4, 20_000);
    p = applyFill(NQ, p, fill(-1, 20_010)).position;
    p = applyFill(NQ, p, fill(-1, 20_020)).position;
    p = applyFill(NQ, p, fill(-2, 19_990)).position;
    expect(p.qty).toBe(0);
    // +200 +400 -400
    expect(p.realizedPnlMicros).toBe(200 * MICROS);
  });

  /**
   * The residue test. Closing a 3-lot one at a time from a fractional average
   * must total exactly the same as closing it in one go.
   */
  it('loses nothing to rounding when a fractional basis is closed piecemeal', () => {
    let p = flatPosition('NQ');
    p = applyFill(NQ, p, fill(1, 20_000)).position;
    p = applyFill(NQ, p, fill(1, 20_000.25)).position;
    p = applyFill(NQ, p, fill(1, 20_000.5)).position;

    let piecemeal = flatPosition('NQ');
    piecemeal = { ...p };
    let total = 0;
    for (let i = 0; i < 3; i += 1) {
      const r = applyFill(NQ, piecemeal, fill(-1, 20_010));
      piecemeal = r.position;
      total += r.grossRealizedMicros;
    }
    const atOnce = applyFill(NQ, p, fill(-3, 20_010));

    expect(piecemeal.qty).toBe(0);
    expect(piecemeal.costBasisMicros).toBe(0);
    expect(total).toBe(atOnce.grossRealizedMicros);
    expect(piecemeal.realizedPnlMicros).toBe(atOnce.position.realizedPnlMicros);
  });
});

describe('reversal', () => {
  /** The worked example: long 3, sell 5, expect short 2. */
  it('closes the long and opens a short with the surplus', () => {
    const p = open(NQ, 3, 20_000);
    const r = applyFill(NQ, p, fill(-5, 20_010));

    expect(r.reversed).toBe(true);
    expect(r.position.qty).toBe(-2);
    expect(sideOf(r.position.qty)).toBe('SHORT');
    // The whole long is realized...
    expect(r.grossRealizedMicros).toBe(600 * MICROS);
    // ...and the new short is entered at the reversal price, not the old average.
    expect(avgEntryTicks(NQ, r.position)).toBe(px(NQ, 20_010));
    expect(r.closedLots).toHaveLength(1);
    expect(r.closedLots[0]!.qty).toBe(3);
    expect(r.position.openedAt).toBe(T0);
  });

  it('reverses a short into a long symmetrically', () => {
    const p = open(NQ, -2, 20_000);
    const r = applyFill(NQ, p, fill(5, 19_990));
    expect(r.position.qty).toBe(3);
    expect(r.grossRealizedMicros).toBe(400 * MICROS);
    expect(avgEntryTicks(NQ, r.position)).toBe(px(NQ, 19_990));
  });

  it('offers helper quantities for flatten and reverse', () => {
    const p = open(NQ, 3, 20_000);
    expect(flattenQty(p)).toBe(-3);
    expect(reverseQty(p)).toBe(-6);
    const s = open(NQ, -2, 20_000);
    expect(flattenQty(s)).toBe(2);
    expect(reverseQty(s)).toBe(4);
  });
});

describe('long random walk stays exact', () => {
  /**
   * Deterministic pseudo-random sequence (no Math.random: reproducibility
   * matters more than variety, and the fabrication guard forbids it anyway).
   * Invariant: realized P&L computed incrementally must equal the P&L implied
   * by the fills, and a flat position must always have a zero cost basis.
   */
  it('keeps cost basis and realized P&L consistent over 500 fills', () => {
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    let p = flatPosition('NQ');
    let cashMicros = 0; // signed cash flow from every fill
    let priceTicks = px(NQ, 20_000);

    for (let i = 0; i < 500; i += 1) {
      priceTicks += Math.round((next() - 0.5) * 20);
      const qty = Math.max(1, Math.round(next() * 4));
      const signed = next() > 0.5 ? qty : -qty;

      // Cash accounting, entirely independent of the position engine.
      cashMicros -= priceTicks * signed * NQ.tickValueMicros;

      const r = applyFill(NQ, p, {
        signedQty: signed,
        priceTicks,
        feesMicros: 0,
        exchangeTs: T0 + i * 1000,
      });
      p = r.position;

      if (p.qty === 0) expect(p.costBasisMicros).toBe(0);
    }

    // Close out whatever remains and compare against the independent ledger.
    if (p.qty !== 0) {
      cashMicros -= priceTicks * -p.qty * NQ.tickValueMicros;
      p = applyFill(NQ, p, {
        signedQty: -p.qty,
        priceTicks,
        feesMicros: 0,
        exchangeTs: T0,
      }).position;
    }

    expect(p.qty).toBe(0);
    expect(p.costBasisMicros).toBe(0);
    expect(p.realizedPnlMicros).toBe(cashMicros);
  });
});
