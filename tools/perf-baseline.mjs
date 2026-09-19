/**
 * The performance baseline: every interaction the brief names, measured.
 *
 *   node tools/perf-baseline.mjs                 # the standard set
 *   node tools/perf-baseline.mjs --save          # and write the baseline file
 *   node tools/perf-baseline.mjs --only pan,zoom # a subset while iterating
 *   node tools/perf-baseline.mjs --json out.json # write the run for comparison
 *
 * Each scenario drives REAL pointer, wheel and keyboard input against the real
 * application and reports the frame-time distribution and the input latency
 * beside it. Nothing here asserts; it measures. `tools/perf-check.mjs` is what
 * compares a run against the stored baseline.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { launch, signIn, clearDrawings, clearIndicators } from '../tests/browser/harness.mjs';
import { PROBE_SOURCE, measure, row, table } from './perf/probe.mjs';

const BASELINE = 'tests/browser/baselines/performance.json';
const argv = process.argv.slice(2);
const SAVE = argv.includes('--save');
/** Write the run somewhere else instead, for `perf-check.mjs` to compare. */
const JSON_OUT = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] ?? null : null;
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1]?.split(',') ?? [] : [];

const { browser, page, errors } = await launch({
  width: 1680,
  height: 1000,
  // Bucketed heap readings cannot show a slow leak; this makes them exact.
  args: ['--enable-precise-memory-info'],
  initScript: PROBE_SOURCE,
});

const results = [];
const notes = [];

/** Where the plot is, re-read each time: panels move. */
async function plot() {
  const box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
  return {
    box,
    at: (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy }),
  };
}

/** A steady drag, as a hand makes it rather than as a teleport. */
async function drag(from, to, steps = 24) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
  }
  await page.mouse.up();
}

async function sweep(at, steps = 40) {
  for (let i = 0; i <= steps; i += 1) {
    const point = at(0.15 + (0.7 * i) / steps, 0.3 + 0.3 * Math.sin(i / 4));
    await page.mouse.move(point.x, point.y);
  }
}

async function run(name, body) {
  if (only.length > 0 && !only.some((o) => name.includes(o))) return null;
  const report = await measure(page, name, body);
  results.push(row(name, report));
  process.stdout.write(
    `${name.padEnd(28)} fps ${report.frames.fps.toFixed(0).padStart(3)}  ` +
      `p95 ${(report.frames.p95 ?? 0).toFixed(1).padStart(6)}ms  ` +
      `p99 ${(report.frames.p99 ?? 0).toFixed(1).padStart(6)}ms  ` +
      `worst ${(report.frames.worst ?? 0).toFixed(0).padStart(4)}ms  ` +
      `>50ms ${String(report.frames.over50).padStart(3)}  ` +
      `resp p95 ${(report.response.p95 ?? 0).toFixed(1).padStart(6)}ms  ` +
      `long ${String(report.longTasks.n ?? 0).padStart(3)}\n`,
  );
  return report;
}

try {
  // ---------------------------------------------------------------- startup
  const t0 = Date.now();
  await page.evaluate(() => window.__perf.start('startup')).catch(() => {});
  await signIn(page);
  await page.waitForTimeout(3_500);
  const startup = await page.evaluate(() => window.__perf.report());
  results.push(row('startup (to usable chart)', startup));
  notes.push(`startup wall clock: ${Date.now() - t0}ms`);
  process.stdout.write(`startup                      ${Date.now() - t0}ms wall clock\n`);

  // A known state: this measures the terminal, not whatever the last run left.
  if ((await page.locator('[data-testid=chart-pane]').count()) > 1) {
    await page.click('[data-testid=layout-button]');
    await page.waitForTimeout(400);
    await page.click('[data-testid=layout-choices] button[data-layout=ONE]');
    await page.waitForTimeout(2_500);
  }
  await clearDrawings(page);
  await clearIndicators(page);
  await page.waitForTimeout(1_200);

  const before = await page.evaluate(() => window.__perf.resources());
  notes.push(`resources at baseline: ${JSON.stringify(before)}`);

  // ------------------------------------------------------------ the chart
  let p = await plot();

  await run('crosshair sweep', async () => {
    await sweep(p.at, 60);
  });

  await run('chart pan', async () => {
    for (let i = 0; i < 3; i += 1) {
      await drag(p.at(0.75, 0.5), p.at(0.3, 0.5), 30);
      await drag(p.at(0.3, 0.5), p.at(0.75, 0.5), 30);
    }
  });

  await run('wheel zoom', async () => {
    await page.mouse.move(p.at(0.6, 0.5).x, p.at(0.6, 0.5).y);
    for (let i = 0; i < 20; i += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(16);
    }
    for (let i = 0; i < 20; i += 1) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(16);
    }
  });

  await run('price axis drag', async () => {
    const axis = { x: p.box.x + p.box.width - 26, y: p.box.y + p.box.height * 0.45 };
    await drag(axis, { x: axis.x, y: axis.y + 180 }, 30);
    await drag({ x: axis.x, y: axis.y + 180 }, axis, 30);
  });

  await run('time axis drag', async () => {
    const axis = { x: p.box.x + p.box.width * 0.5, y: p.box.y + p.box.height - 10 };
    await drag(axis, { x: axis.x - 250, y: axis.y }, 30);
    await drag({ x: axis.x - 250, y: axis.y }, axis, 30);
  });

  // ------------------------------------------------------------- drawings
  await run('drawing place', async () => {
    await page.click('.rail .rail-btn[aria-label="Trend line"]');
    await page.mouse.click(p.at(0.3, 0.6).x, p.at(0.3, 0.6).y);
    await page.mouse.move(p.at(0.5, 0.35).x, p.at(0.5, 0.35).y, { steps: 20 });
    await page.mouse.click(p.at(0.5, 0.35).x, p.at(0.5, 0.35).y);
    await page.waitForTimeout(400);
  });

  await run('drawing body drag', async () => {
    const mid = p.at(0.4, 0.475);
    for (let i = 0; i < 3; i += 1) {
      await drag(mid, { x: mid.x + 70, y: mid.y - 40 }, 25);
      await drag({ x: mid.x + 70, y: mid.y - 40 }, mid, 25);
    }
  });

  await run('drawing anchor drag', async () => {
    const anchor = p.at(0.5, 0.35);
    for (let i = 0; i < 3; i += 1) {
      await drag(anchor, { x: anchor.x + 90, y: anchor.y + 60 }, 25);
      await drag({ x: anchor.x + 90, y: anchor.y + 60 }, anchor, 25);
    }
  });
  await page.keyboard.press('Escape');
  await clearDrawings(page);

  // ------------------------------------------------------------ switching
  await run('symbol switch', async () => {
    for (const root of ['ES', 'NQ']) {
      await page.click('[data-pane=p1] .chdr-symbol');
      await page.waitForTimeout(350);
      await page.click(`.popover .pop-item:has(.chdr-pop-root:text-is("${root}"))`);
      await page.waitForTimeout(2_600);
    }
  });

  await run('timeframe switch', async () => {
    for (const tf of ['5m', '15m', '1m']) {
      await page.click(`[data-pane=p1] .chdr-tf:has-text("${tf}")`);
      await page.waitForTimeout(1_800);
    }
  });

  // ----------------------------------------------------------- indicators
  await run('indicator add', async () => {
    await page.click('.chdr-btn:has-text("Indicators")');
    await page.waitForTimeout(400);
    await page.click('[data-testid=indicator-catalogue] .pop-item:has-text("Exponential moving")');
    await page.waitForTimeout(1_400);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  await run('indicator remove', async () => {
    const remove = page.locator('[data-testid=indicator-row] .ind-btn-danger').first();
    if (await remove.count()) await remove.click();
    await page.waitForTimeout(1_200);
  });

  // ---------------------------------------------------------------- chrome
  await run('settings open', async () => {
    await page.click('[data-testid=apprail-settings]');
    await page.waitForSelector('.st-nav-item', { timeout: 10_000 });
    await page.waitForTimeout(600);
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  /*
   * A theme change repaints EVERYTHING.
   *
   * Every token on the root element moves at once, which invalidates every
   * panel, every border and the chart's own colours - and the chart has to be
   * told separately, because a canvas does not inherit CSS. If any single
   * interaction in this terminal is going to drop a frame, it is this one, so
   * it is measured rather than assumed.
   */
  await run('theme switch', async () => {
    await page.click('[data-testid=apprail-settings]');
    await page.waitForSelector('.st-nav-item', { timeout: 10_000 });
    await page.click('.st-nav-item:has-text("Theme")');
    await page.waitForSelector('[data-theme-card]', { timeout: 10_000 });
    await page.waitForTimeout(400);
    for (const theme of ['MIDNIGHT', 'GRAPHITE', 'OLED', 'ATLAS_DARK']) {
      await page.click(`[data-theme-card=${theme}]`);
      await page.waitForTimeout(900);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  });

  /*
   * And how long the trader waits for it: click to the token actually
   * changing on the document, which is the moment the terminal looks
   * different.
   */
  {
    await page.click('[data-testid=apprail-settings]');
    await page.waitForSelector('.st-nav-item', { timeout: 10_000 });
    await page.click('.st-nav-item:has-text("Theme")');
    await page.waitForSelector('[data-theme-card]', { timeout: 10_000 });
    await page.waitForTimeout(400);
    const latencies = [];
    for (const theme of ['MIDNIGHT', 'GRAPHITE', 'OLED', 'ATLAS_DARK', 'MIDNIGHT', 'ATLAS_DARK']) {
      const took = await page.evaluate(
        ([id]) =>
          new Promise((resolve) => {
            const root = document.documentElement;
            const before = getComputedStyle(root).getPropertyValue('--bg-base').trim();
            const card = document.querySelector(`[data-theme-card=${id}]`);
            if (!card) return resolve(null);
            const started = performance.now();
            card.click();
            const poll = () => {
              const now = getComputedStyle(root).getPropertyValue('--bg-base').trim();
              if (now !== before) return resolve(performance.now() - started);
              if (performance.now() - started > 2_000) return resolve(null);
              requestAnimationFrame(poll);
            };
            requestAnimationFrame(poll);
          }),
        [theme],
      );
      if (took !== null) latencies.push(Math.round(took));
      await page.waitForTimeout(700);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    if (latencies.length > 0) {
      const sorted = [...latencies].sort((a, b) => a - b);
      notes.push(
        `theme applied in ${sorted[0]}-${sorted[sorted.length - 1]}ms ` +
          `(median ${sorted[Math.floor(sorted.length / 2)]}ms over ${sorted.length} changes)`,
      );
      process.stdout.write(
        `theme switch latency         median ${sorted[Math.floor(sorted.length / 2)]}ms, ` +
          `worst ${sorted[sorted.length - 1]}ms\n`,
      );
    }
  }

  await run('context menu', async () => {
    p = await plot();
    await page.mouse.click(p.at(0.5, 0.5).x, p.at(0.5, 0.5).y, { button: 'right' });
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  });

  await run('bottom panel resize', async () => {
    const splitter = await page.locator('.splitter-h').boundingBox();
    const from = { x: splitter.x + splitter.width / 2, y: splitter.y + splitter.height / 2 };
    await drag(from, { x: from.x, y: from.y - 160 }, 30);
    await drag({ x: from.x, y: from.y - 160 }, from, 30);
  });

  await run('order panel resize', async () => {
    const splitter = await page.locator('.splitter-v').boundingBox();
    const from = { x: splitter.x + splitter.width / 2, y: splitter.y + splitter.height / 2 };
    await drag(from, { x: from.x - 150, y: from.y }, 30);
    await drag({ x: from.x - 150, y: from.y }, from, 30);
  });

  await run('window resize', async () => {
    for (const size of [
      { width: 1440, height: 900 },
      { width: 1280, height: 800 },
      { width: 1680, height: 1000 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(900);
    }
  });

  await run('layout 1 -> 4 -> 1', async () => {
    await page.click('[data-testid=layout-button]');
    await page.waitForTimeout(300);
    await page.click('[data-testid=layout-choices] button[data-layout=FOUR]');
    await page.waitForTimeout(5_000);
    await page.click('[data-testid=layout-button]');
    await page.waitForTimeout(300);
    await page.click('[data-testid=layout-choices] button[data-layout=ONE]');
    await page.waitForTimeout(3_000);
  });

  const after = await page.evaluate(() => window.__perf.resources());
  notes.push(`resources after the sweep: ${JSON.stringify(after)}`);

  // ------------------------------------------------------------------ out
  const columns = [
    'scenario', 'fps', 'frameP50', 'frameP95', 'frameP99', 'frameWorst',
    'over20', 'over33', 'over50', 'respP50', 'respP95', 'respWorst', 'longTasks', 'longWorst',
  ];
  console.log('\n' + table(results, columns));
  console.log('\n' + notes.map((n) => `- ${n}`).join('\n'));
  console.log(`\npage errors: ${errors.length === 0 ? 'none' : errors.join(' | ')}`);

  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      JSON.stringify({ recordedAt: new Date().toISOString(), rows: results, notes }, null, 2),
    );
    console.log(`\nrun written to ${JSON_OUT}`);
  }

  if (SAVE) {
    mkdirSync('tests/browser/baselines', { recursive: true });
    const previous = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
    writeFileSync(
      BASELINE,
      JSON.stringify(
        { recordedAt: new Date().toISOString(), rows: results, notes, previousRecordedAt: previous?.recordedAt ?? null },
        null,
        2,
      ),
    );
    console.log(`\nbaseline written to ${BASELINE}`);
  }
} finally {
  await browser.close();
}
