/**
 * Engineering Phase B, Part I (STEP 2-3) — chart trading coordinate truth.
 *
 * Two objective invariants, proven against the REAL instrument registry:
 *
 *  1. TICK SNAPPING. Every draggable trading price the chart produces
 *     (`snapPrice`) lands on a valid instrument tick, for all eight launch
 *     instruments, with no binary floating-point residue in the displayed or
 *     submitted number.
 *
 *  2. PRICE ↔ PIXEL ROUND-TRIP. The chart's coordinate transform is invertible
 *     to within a tick at the top, middle and bottom of the visible scale, and
 *     stays invertible after zoom, pan and container-resize — modelled through
 *     the same `ChartProjection` contract the adapter exposes (an affine
 *     price↔Y map in linear mode). The live lightweight-charts transform is
 *     exercised additionally in the browser suite; this pins the math the
 *     trading overlays depend on so a regression is caught headlessly.
 *
 * These are the coordinate guarantees under the non-negotiable principle:
 * zoom/pan/resize re-derive screen coordinates and never change the market
 * value.
 */
import { describe, expect, it } from 'vitest';
import { INSTRUMENTS, getInstrument } from '@atlas/instruments';
import { snapPrice } from './protection';
import type { ChartProjection } from './ChartAdapter';

/** The eight launch instruments, in the phase's stated order. */
const LAUNCH = ['NQ', 'MNQ', 'ES', 'MES', 'GC', 'MGC', 'CL', 'MCL'] as const;

/** The authoritative float tick size, derived from the integer registry value. */
function tickOf(root: string): number {
  const spec = getInstrument(root)!;
  return spec.tickSizeScaled / 10 ** spec.pricePrecision;
}

/** True when a price sits exactly on the instrument's integer tick grid. */
function onTickGrid(price: number, root: string): boolean {
  const spec = getInstrument(root)!;
  // Integer-tick math: express the price in scaled units and check it is an
  // exact multiple of the scaled tick. This is the floating-point-proof test.
  const scaled = Math.round(price * 10 ** spec.pricePrecision);
  return scaled % spec.tickSizeScaled === 0;
}

describe('the registry backs every launch instrument with an integer tick', () => {
  it('has all eight instruments with a positive integer tickSizeScaled', () => {
    for (const root of LAUNCH) {
      const spec = getInstrument(root);
      expect(spec, root).toBeTruthy();
      expect(Number.isInteger(spec!.tickSizeScaled), root).toBe(true);
      expect(spec!.tickSizeScaled, root).toBeGreaterThan(0);
    }
  });

  it('matches the published tick sizes', () => {
    expect(tickOf('NQ')).toBe(0.25);
    expect(tickOf('MNQ')).toBe(0.25);
    expect(tickOf('ES')).toBe(0.25);
    expect(tickOf('MES')).toBe(0.25);
    expect(tickOf('GC')).toBe(0.1);
    expect(tickOf('MGC')).toBe(0.1);
    expect(tickOf('CL')).toBe(0.01);
    expect(tickOf('MCL')).toBe(0.01);
  });
});

describe('STEP 3 — tick snapping is correct for all eight launch instruments', () => {
  // Representative live-ish prices per asset class.
  const BASE: Record<string, number> = {
    NQ: 20_000,
    MNQ: 20_000,
    ES: 5_600,
    MES: 5_600,
    GC: 2_650,
    MGC: 2_650,
    CL: 72,
    MCL: 72,
  };

  it('snaps an arbitrary between-tick price onto the grid, for every instrument', () => {
    for (const root of LAUNCH) {
      const tick = tickOf(root);
      const base = BASE[root]!;
      // Walk a range of sub-tick offsets; every snap must land on the grid.
      for (let i = -50; i <= 50; i += 1) {
        const raw = base + i * tick * 0.37; // deliberately off-grid
        const snapped = snapPrice(raw, tick);
        expect(onTickGrid(snapped, root), `${root} raw=${raw} snapped=${snapped}`).toBe(true);
      }
    }
  });

  it('an exact tick is returned unchanged (no drift)', () => {
    for (const root of LAUNCH) {
      const tick = tickOf(root);
      const base = BASE[root]!;
      for (let i = 0; i < 20; i += 1) {
        const exact = snapPrice(base + i * tick, tick);
        expect(snapPrice(exact, tick)).toBe(exact);
        expect(onTickGrid(exact, root)).toBe(true);
      }
    }
  });

  it('NQ can never produce an invalid increment like 20000.13', () => {
    // The classic bug: a 0.01-resolution price on a 0.25-tick instrument.
    expect(snapPrice(20_000.13, 0.25)).toBe(20_000.25);
    expect(onTickGrid(snapPrice(20_000.13, 0.25), 'NQ')).toBe(true);
    // A whole sweep of cents never lands off-grid.
    for (let c = 0; c < 100; c += 1) {
      const snapped = snapPrice(20_000 + c / 100, 0.25);
      expect(onTickGrid(snapped, 'NQ'), `cent=${c} snapped=${snapped}`).toBe(true);
    }
  });

  it('CL snaps to whole cents with no floating-point tail', () => {
    // 0.01 ticks are where binary floating point bites hardest.
    for (let i = 0; i < 200; i += 1) {
      const raw = 72 + i * 0.0037;
      const snapped = snapPrice(raw, 0.01);
      expect(onTickGrid(snapped, 'CL'), `raw=${raw} snapped=${snapped}`).toBe(true);
      // No float tail beyond pricePrecision (2) decimals — the submitted number is clean.
      expect(Number(snapped.toFixed(2)), `raw=${raw} snapped=${snapped}`).toBe(snapped);
    }
  });

  it('handles CL negative prices (April 2020 was real) and keeps them on-grid', () => {
    expect(getInstrument('CL')!.allowsNegativePrice).toBe(true);
    for (const raw of [-0.004, -37.63, -0.01, -12.005]) {
      const snapped = snapPrice(raw, 0.01);
      expect(onTickGrid(snapped, 'CL'), `raw=${raw} snapped=${snapped}`).toBe(true);
    }
  });

  it('an exactly-representable half-tick rounds up (Math.round semantics)', () => {
    // 0.125 = 1/8 is exact in binary, so this half is genuinely halfway and
    // resolves up every time.
    expect(snapPrice(20_000.125, 0.25)).toBe(20_000.25);
    expect(snapPrice(20_000.375, 0.25)).toBe(20_000.5);
  });

  it('a NON-representable decimal literal still lands on a valid tick (no off-grid price)', () => {
    // 72.005 and 2650.05 are not exactly representable in binary (each is a
    // hair below the true value), so they resolve to the nearer representable
    // tick rather than "up". That is not a bug: the result is ALWAYS on the
    // grid and within half a tick, and real drag input is a continuous
    // yToPrice value, never a decimal literal. This documents the behaviour so
    // it is not mistaken for an order-price defect.
    for (const [raw, tick, root] of [
      [72.005, 0.01, 'CL'],
      [2_650.05, 0.1, 'GC'],
    ] as const) {
      const snapped = snapPrice(raw, tick);
      expect(onTickGrid(snapped, root), `${root} ${raw} -> ${snapped}`).toBe(true);
      expect(Math.abs(snapped - raw)).toBeLessThanOrEqual(tick / 2 + 1e-9);
    }
  });
});

/**
 * A linear (affine) price↔Y projection, matching the ChartAdapter contract in
 * NORMAL price-scale mode: y = topPad + (priceTop − price) * pxPerPrice.
 * Zoom changes pxPerPrice; pan changes priceTop; resize changes height.
 */
function affineProjection(opts: {
  priceTop: number;
  priceBottom: number;
  height: number;
}): Pick<ChartProjection, 'priceToY' | 'yToPrice' | 'height'> {
  const { priceTop, priceBottom, height } = opts;
  const pxPerPrice = height / (priceTop - priceBottom);
  return {
    height,
    priceToY: (price) => (priceTop - price) * pxPerPrice,
    yToPrice: (y) => priceTop - y / pxPerPrice,
  };
}

describe('STEP 2 — price ↔ pixel round-trip stays within a tick', () => {
  const views = [
    { name: 'wide', priceTop: 20_100, priceBottom: 19_900, height: 800 },
    { name: 'zoomed-in', priceTop: 20_010, priceBottom: 19_990, height: 800 }, // zoom
    { name: 'panned', priceTop: 20_300, priceBottom: 20_100, height: 800 }, // pan
    { name: 'resized-short', priceTop: 20_100, priceBottom: 19_900, height: 360 }, // resize
    { name: 'resized-tall', priceTop: 20_100, priceBottom: 19_900, height: 1440 },
  ];

  it('recovers the snapped price at top, middle and bottom of the scale, across transforms', () => {
    const tick = 0.25; // NQ
    for (const v of views) {
      const proj = affineProjection(v);
      const samples = [v.priceTop - tick, (v.priceTop + v.priceBottom) / 2, v.priceBottom + tick];
      for (const price of samples) {
        const snapped = snapPrice(price, tick);
        const y = proj.priceToY(snapped)!;
        const back = snapPrice(proj.yToPrice(y)!, tick);
        // Round-trip through pixels must not move the value off its tick.
        expect(Math.abs(back - snapped), `${v.name} @ ${snapped}`).toBeLessThanOrEqual(tick / 2);
        expect(onTickGrid(back, 'NQ')).toBe(true);
      }
    }
  });

  it('a pan (priceTop shift) never changes the price that a fixed order Y maps back to, beyond re-derivation', () => {
    // The order's authoritative price is fixed; only its screen Y changes with the view.
    const tick = 0.25;
    const orderPrice = snapPrice(20_000, tick);
    const a = affineProjection({ priceTop: 20_100, priceBottom: 19_900, height: 800 });
    const b = affineProjection({ priceTop: 20_050, priceBottom: 19_850, height: 800 }); // panned
    const yA = a.priceToY(orderPrice)!;
    const yB = b.priceToY(orderPrice)!;
    // The marker moved on screen…
    expect(yA).not.toBe(yB);
    // …but the price read back from each view is the same authoritative value.
    expect(snapPrice(a.yToPrice(yA)!, tick)).toBe(orderPrice);
    expect(snapPrice(b.yToPrice(yB)!, tick)).toBe(orderPrice);
  });

  it('holds for GC (0.10) and CL (0.01) grids too', () => {
    for (const [root, base, span] of [
      ['GC', 2_650, 20],
      ['CL', 72, 2],
    ] as const) {
      const tick = tickOf(root);
      const proj = affineProjection({ priceTop: base + span, priceBottom: base - span, height: 700 });
      for (let i = -5; i <= 5; i += 1) {
        const snapped = snapPrice(base + i * tick * 3, tick);
        const back = snapPrice(proj.yToPrice(proj.priceToY(snapped)!)!, tick);
        expect(Math.abs(back - snapped), `${root} @ ${snapped}`).toBeLessThanOrEqual(tick / 2);
        expect(onTickGrid(back, root)).toBe(true);
      }
    }
  });
});
