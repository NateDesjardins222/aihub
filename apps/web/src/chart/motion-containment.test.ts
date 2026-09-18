import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * A standing guard that smoothing stays a drawing choice.
 *
 * The brief was categorical: FLUID/SMOOTH is presentation only and must NEVER
 * alter OHLC, market history, fills, stop triggering, target triggering, order
 * matching, P&L, risk, journal data or recorded market data. Execution always
 * uses genuine observations.
 *
 * `motion.ts` has three unit-tested guarantees about the VALUES it emits, and
 * they are necessary but not sufficient: a perfectly well-behaved interpolated
 * price is still wrong the moment anything but the canvas can read it. So this
 * checks the other half structurally - who is allowed to import the module at
 * all.
 *
 * The rule: `MarketMotion` may be constructed only by the chart panel that
 * draws with it. Everything else may touch the SETTINGS (a mode, a smoothing
 * fraction - persisted preferences, no prices in them) and nothing else.
 *
 * A guard on imports is worth more here than a guard on behaviour, because the
 * failure this prevents is not "the interpolation is wrong". It is someone
 * reaching for the smooth value in an order ticket because it is the number on
 * screen, which every individual step of would look reasonable in review.
 */

const WEB_SRC = resolve(import.meta.dirname, '..');

/** Files allowed to construct the motion engine, with the reason. */
const MAY_CONSTRUCT: ReadonlyArray<{ path: string; reason: string }> = [
  { path: 'panels/ChartPanel.tsx', reason: 'the chart that draws the eased price' },
  { path: 'chart/motion.ts', reason: 'the module itself' },
  { path: 'chart/motion.test.ts', reason: 'its unit tests' },
  { path: 'chart/motion-containment.test.ts', reason: 'this guard, which names it' },
];

/** Value-bearing exports: touching these means touching a price. */
const PRICE_BEARING = /\bMarketMotion\b/;

/**
 * Anywhere a price could leave the browser for the server, or be used as if it
 * were a genuine observation. Nothing in here may reach the motion module even
 * indirectly, so the check is on the whole directory rather than named files.
 */
const MUST_NOT_TOUCH = ['market/api.ts', 'market/stream.ts', 'state/execution.ts'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const relative = (file: string): string => file.slice(WEB_SRC.length + 1);

describe('smoothing cannot reach anything but the canvas', () => {
  const files = walk(WEB_SRC).map((file) => ({
    path: relative(file),
    source: readFileSync(file, 'utf8'),
  }));

  it('finds the files it is meant to be guarding', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => f.path === 'chart/motion.ts')).toBe(true);
    expect(files.some((f) => f.path === 'panels/ChartPanel.tsx')).toBe(true);
  });

  it('only the chart constructs the motion engine', () => {
    const allowed = new Set(MAY_CONSTRUCT.map((entry) => entry.path));
    const offenders = files
      .filter((f) => !allowed.has(f.path) && PRICE_BEARING.test(f.source))
      .map((f) => f.path);
    expect(offenders, `${offenders.join(', ')} references MarketMotion`).toEqual([]);
  });

  it('the server-facing modules never import it', () => {
    for (const path of MUST_NOT_TOUCH) {
      const file = files.find((f) => f.path === path);
      expect(file, `${path} is missing - update this guard`).toBeDefined();
      expect(file?.source.includes('motion'), `${path} mentions motion`).toBe(false);
    }
  });

  it('the module itself says what it must not do', () => {
    const motion = files.find((f) => f.path === 'chart/motion.ts');
    expect(motion?.source).toMatch(/never sent to the server|Nothing produced here is ever sent/);
  });
});
