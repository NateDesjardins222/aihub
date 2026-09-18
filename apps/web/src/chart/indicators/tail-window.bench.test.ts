import { describe, it } from 'vitest';
import type { NormalizedBar } from '@atlas/contracts';
import { INDICATORS, type ParamValues } from './registry';

/**
 * What a tick costs, with and without the window.
 *
 * Not an assertion - a printout. The browser measurement of this needs the
 * market to be moving, and a fix that can only be measured when the market
 * cooperates is a fix nobody can check. The arithmetic itself is
 * deterministic, so it is timed here over a realistic history at the study
 * counts the stress ladder uses.
 */
function series(count: number): NormalizedBar[] {
  const bars: NormalizedBar[] = [];
  let price = 18_000;
  let seed = 7;
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price = Math.max(1, price + (random() - 0.5) * 12);
    bars.push({
      symbol: 'NQ',
      time: 1_700_000_000_000 + i * 60_000,
      open,
      high: Math.max(open, price) + random() * 4,
      low: Math.min(open, price) - random() * 4,
      close: price,
      volume: Math.round(200 + random() * 900),
      closed: true,
    });
  }
  return bars;
}

const MIX = ['EMA', 'RSI', 'BOLL', 'MACD'];

function tickCost(bars: readonly NormalizedBar[], studies: number, windowed: boolean): number {
  const ctx = (offset: number) => ({
    pane: 'PRICE' as const,
    isSessionStart: (_bar: NormalizedBar, index: number) => (index + offset) % 400 === 0,
  });
  const started = performance.now();
  const passes = 20;
  for (let pass = 0; pass < passes; pass += 1) {
    for (let i = 0; i < studies; i += 1) {
      const def = INDICATORS.find((item) => item.kind === MIX[i % MIX.length])!;
      const params: ParamValues = { ...def.defaults };
      const window = windowed ? (def.tailBars?.(params) ?? null) : null;
      const use = window !== null && window < bars.length ? bars.slice(-window) : bars;
      const offset = bars.length - use.length;
      def.compute(use, params, ctx(offset));
    }
  }
  return (performance.now() - started) / passes;
}

describe('what a live tick costs in indicator arithmetic', () => {
  it('prints the cost per tick, over 1500 bars', () => {
    const bars = series(1_500);
    // Warm the JIT, so the first row is not the slow one.
    tickCost(bars, 5, false);
    tickCost(bars, 5, true);
    const lines: string[] = [];
    for (const studies of [1, 5, 10, 20, 30]) {
      const full = tickCost(bars, studies, false);
      const window = tickCost(bars, studies, true);
      lines.push(
        `  ${String(studies).padStart(2)} studies   whole history ${full.toFixed(2)}ms   ` +
          `declared window ${window.toFixed(2)}ms   ${(full / window).toFixed(1)}x`,
      );
    }
    console.log(`\n${lines.join('\n')}\n`);
  });
});
