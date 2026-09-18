import { describe, expect, it } from 'vitest';
import type { NormalizedBar } from '@atlas/contracts';
import { INDICATORS, type ParamValues } from './registry';

/**
 * The shortcut the live market takes, held to the answer it is a shortcut for.
 *
 * A tick updates the bar in progress several times a second, and only the
 * NEWEST value of each study has to change on the screen. Recomputing every
 * study over every bar for that was measured at 31ms a tick with twenty
 * studies on the chart - two dropped frames every time the price moved.
 *
 * So each indicator declares how far back its newest value can possibly
 * depend, and the live path computes over that window instead. For a Wilder
 * average or an EMA that is a claim about how fast a seed decays, and a claim
 * is worth exactly what it is tested at: every indicator, over a range of
 * parameters, against the full-history answer it replaces. The tolerance is
 * 1e-9 relative - eleven orders of magnitude below the tick sizes these
 * numbers are displayed in.
 */

/** Two thousand bars of a plausible instrument, deterministic. */
function series(count: number): NormalizedBar[] {
  const bars: NormalizedBar[] = [];
  let price = 18_000;
  let seed = 42;
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  for (let i = 0; i < count; i += 1) {
    const drift = (random() - 0.5) * 12;
    const open = price;
    price = Math.max(1, price + drift);
    const high = Math.max(open, price) + random() * 4;
    const low = Math.min(open, price) - random() * 4;
    bars.push({
      symbol: 'NQ',
      time: 1_700_000_000_000 + i * 60_000,
      open,
      high,
      low,
      close: price,
      volume: Math.round(200 + random() * 900),
      closed: true,
    });
  }
  return bars;
}

const BARS = series(2_000);
const SESSION_EVERY = 400;
const ctx = (offset: number) => ({
  pane: 'PRICE' as const,
  isSessionStart: (_bar: NormalizedBar, index: number) => (index + offset) % SESSION_EVERY === 0,
});

/** The last value of every plot, keyed by plot id. */
function tail(bars: readonly NormalizedBar[], kind: string, params: ParamValues, offset: number) {
  const def = INDICATORS.find((item) => item.kind === kind)!;
  const output = def.compute(bars, { ...def.defaults, ...params }, ctx(offset));
  const out: Record<string, number> = {};
  for (const plot of output.plots) {
    const last = plot.points[plot.points.length - 1];
    if (last) out[plot.id] = last.value;
  }
  return out;
}

const CASES: ReadonlyArray<{ kind: string; params: ParamValues }> = [
  { kind: 'SMA', params: { period: 20 } },
  { kind: 'SMA', params: { period: 200, smoothing: 5 } },
  { kind: 'EMA', params: { period: 9 } },
  { kind: 'EMA', params: { period: 21 } },
  { kind: 'EMA', params: { period: 50 } },
  { kind: 'BOLL', params: { period: 20, multiplier: 2 } },
  { kind: 'BOLL', params: { period: 50, multiplier: 2.5 } },
  { kind: 'VOLUME', params: {} },
  { kind: 'RSI', params: { period: 14 } },
  { kind: 'RSI', params: { period: 2 } },
  { kind: 'RSI', params: { period: 50 } },
  { kind: 'MACD', params: { fast: 12, slow: 26, signal: 9 } },
  { kind: 'MACD', params: { fast: 5, slow: 35, signal: 5 } },
  { kind: 'ATR', params: { period: 14 } },
  { kind: 'ATR', params: { period: 50 } },
];

describe('the live-market tail window', () => {
  for (const { kind, params } of CASES) {
    it(`${kind} ${JSON.stringify(params)} reaches the full-history answer`, () => {
      const def = INDICATORS.find((item) => item.kind === kind)!;
      const window = def.tailBars?.({ ...def.defaults, ...params }) ?? null;
      expect(window, `${kind} declares a window`).not.toBeNull();
      expect(window!).toBeLessThan(BARS.length);

      const full = tail(BARS, kind, params, 0);
      const offset = BARS.length - window!;
      const windowed = tail(BARS.slice(-window!), kind, params, offset);

      expect(Object.keys(windowed).sort()).toEqual(Object.keys(full).sort());
      for (const [id, value] of Object.entries(full)) {
        const other = windowed[id]!;
        const scale = Math.max(1e-6, Math.abs(value));
        expect(
          Math.abs(other - value) / scale,
          `${kind}.${id}: window ${other}, full history ${value}`,
        ).toBeLessThan(1e-9);
      }
    });
  }

  it('VWAP asks for the whole history, because its anchor is the session', () => {
    const def = INDICATORS.find((item) => item.kind === 'VWAP')!;
    expect(def.tailBars?.(def.defaults)).toBeNull();
  });

  it('every indicator has decided one way or the other', () => {
    for (const def of INDICATORS) {
      expect(typeof def.tailBars, `${def.kind} declares tailBars`).toBe('function');
    }
  });
});
