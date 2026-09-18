/**
 * How long until a trader can actually use Atlas.
 *
 *   node tools/perf-startup.mjs [runs]
 *
 * The baseline sweep reported "startup 16,614ms", which is not the
 * application: the shared sign-in helper sleeps for several seconds on purpose
 * so that later checks are not racing it. This measures the real thing, by
 * polling for the milestones rather than waiting out a clock:
 *
 *   navigation   the page begins loading
 *   app          the sign-in form or the terminal shell exists
 *   authed       credentials accepted, terminal mounting
 *   canvas       a chart canvas is in the DOM
 *   bars         the canvas has actually painted candles
 *   usable       the status line carries a real price
 *
 * "Usable" is the number that matters, because a chart with no price on it is
 * not a chart a trader can act on.
 */
import { launch, WEB, EMAIL, PASSWORD } from '../tests/browser/harness.mjs';
import { PROBE_SOURCE } from './perf/probe.mjs';

const RUNS = Number(process.argv[2] ?? 3);

/** Poll for a condition, returning how long it took. */
async function until(page, label, test, timeout = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await test().catch(() => false)) return Date.now() - start;
    await page.waitForTimeout(40);
  }
  return null;
}

const runs = [];

for (let i = 0; i < RUNS; i += 1) {
  const { browser, page, errors } = await launch({
    width: 1680,
    height: 1000,
    args: ['--enable-precise-memory-info'],
    initScript: PROBE_SOURCE,
  });
  const mark = {};
  const t0 = Date.now();
  try {
    await page.goto(WEB, { waitUntil: 'domcontentloaded' });
    mark.navigation = Date.now() - t0;

    mark.app = await until(page, 'app', async () =>
      (await page.locator('input[type=email], .terminal').count()) > 0,
    );

    if ((await page.locator('input[type=email]').count()) > 0) {
      await page.fill('input[type=email]', EMAIL);
      await page.fill('input[type=password]', PASSWORD);
      await page.click('button[type=submit]');
    }
    mark.authed = await until(page, 'authed', async () =>
      (await page.locator('.terminal').count()) > 0,
    );

    mark.canvas = await until(page, 'canvas', async () =>
      (await page.locator('.chart-canvas canvas').count()) > 0,
    );

    // Painted candles, not merely a canvas element.
    mark.bars = await until(page, 'bars', async () =>
      page.evaluate(() => {
        for (const c of document.querySelectorAll('[data-pane=p1] canvas')) {
          const ctx = c.getContext('2d');
          if (!ctx || c.width === 0) continue;
          let data;
          try { data = ctx.getImageData(0, 0, c.width, Math.min(c.height, 400)).data; } catch { continue; }
          let lit = 0;
          for (let j = 3; j < data.length; j += 4 * 97) if (data[j] > 40) lit += 1;
          if (lit > 40) return true;
        }
        return false;
      }),
    );

    mark.usable = await until(page, 'usable', async () => {
      const text = await page.locator('[data-pane=p1] [data-testid=status-line]').innerText().catch(() => '');
      return /\d{2,}/.test(text);
    });

    const nav = await page.evaluate(() => {
      const e = performance.getEntriesByType('navigation')[0];
      if (!e) return null;
      return {
        domContentLoaded: Math.round(e.domContentLoadedEventEnd),
        load: Math.round(e.loadEventEnd),
        transferKB: Math.round((e.transferSize ?? 0) / 1024),
      };
    });
    const res = await page.evaluate(() => window.__perf.resources());
    runs.push({ ...mark, nav, res, errors: errors.length });
    console.log(
      `run ${i + 1}: app ${mark.app}ms  authed ${mark.authed}ms  canvas ${mark.canvas}ms  ` +
        `bars ${mark.bars}ms  USABLE ${mark.usable}ms  heap ${res.heapMB?.toFixed(1)}MB  dom ${res.domNodes}` +
        (nav ? `  (dcl ${nav.domContentLoaded}ms, load ${nav.load}ms, ${nav.transferKB}KB)` : ''),
    );
  } finally {
    await browser.close();
  }
}

const median = (key) => {
  const values = runs.map((r) => r[key]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  return values.length ? values[Math.floor(values.length / 2)] : null;
};
console.log('\nmedian of ' + runs.length + ' runs:');
for (const key of ['app', 'authed', 'canvas', 'bars', 'usable']) {
  console.log(`  ${key.padEnd(9)} ${median(key)}ms`);
}
