/**
 * Where Atlas is asked to break.
 *
 *   node tools/perf-stress.mjs drawings    # 0 -> 1000 objects
 *   node tools/perf-stress.mjs indicators  # 1 -> 30 studies, and combinations
 *   node tools/perf-stress.mjs charts      # 1 -> 4 panes, loaded
 *   node tools/perf-stress.mjs endurance [minutes]
 *
 * Every level runs the SAME interaction set, so the numbers across a row are
 * comparable and the level where something collapses is visible rather than
 * inferred. Nothing is disabled to make a level pass; if interaction has to be
 * throttled to survive, that is the finding.
 */
import { launch, signIn, clearDrawings, clearIndicators } from '../tests/browser/harness.mjs';
import { PROBE_SOURCE, measure, table } from './perf/probe.mjs';

const MODE = process.argv[2] ?? 'drawings';
const ARG = Number(process.argv[3] ?? 0);

const { browser, page, errors } = await launch({
  width: 1680,
  height: 1000,
  args: ['--enable-precise-memory-info'],
  initScript: PROBE_SOURCE,
});

const n = (v, d = 1) => (v === null || v === undefined ? '—' : v.toFixed(d));

/** An authorised fetch from inside the page. */
const api = async (path, init) =>
  page.evaluate(
    async ([path, init]) => {
      const refreshToken = window.localStorage.getItem('atlas.refreshToken');
      const session = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }).then((r) => r.json());
      window.localStorage.setItem('atlas.refreshToken', session.refreshToken);
      const auth = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' };
      const response = await fetch(path, { ...init, headers: { ...auth, ...(init?.headers ?? {}) } });
      const text = await response.text();
      try { return { status: response.status, body: JSON.parse(text) }; }
      catch { return { status: response.status, body: text.slice(0, 200) }; }
    },
    [path, init ?? null],
  );

/** N drawings in the trader's own stored workspace, then a reload. */
async function seedDrawings(count) {
  const built = await page.evaluate(async (count) => {
    const refreshToken = window.localStorage.getItem('atlas.refreshToken');
    const session = await fetch('/api/v1/auth/refresh', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).then((r) => r.json());
    window.localStorage.setItem('atlas.refreshToken', session.refreshToken);
    const auth = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' };
    const bars = await fetch('/api/v1/marketdata/bars?symbol=NQ&timeframe=5m&limit=600', { headers: auth })
      .then((r) => r.json());
    const all = bars.bars ?? [];
    if (all.length < 60) return { status: 0, bytes: 0, error: `only ${all.length} bars` };
    const candles = all.slice(-200);
    const drawings = [];
    for (let i = 0; i < count; i += 1) {
      const a = (i * 3) % (candles.length - 14);
      const from = candles[a], to = candles[a + 10];
      const kind = i % 4 === 0 ? 'RECTANGLE' : i % 4 === 1 ? 'TREND_LINE' : i % 4 === 2 ? 'HORIZONTAL_LINE' : 'RAY';
      const anchors = kind === 'HORIZONTAL_LINE'
        ? [{ time: from.time, price: from.low }]
        : [{ time: from.time, price: from.low }, { time: to.time, price: to.high }];
      drawings.push({
        id: `stress-${i}`, kind, symbol: 'NQ', anchors,
        style: { color: '#5b9dff', opacity: 1, width: 1, dash: 'SOLID', filled: kind === 'RECTANGLE',
                 fillColor: '#5b9dff', fillOpacity: 0.08, fontSize: 11, showPrice: false },
        options: {}, text: '', locked: false, hidden: false, timeframes: [],
      });
    }
    const body = JSON.stringify({ drawings });
    const r = await fetch('/api/v1/drawings', { method: 'PUT', headers: auth, body });
    return { status: r.status, bytes: body.length };
  }, count);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(4_500);
  return built;
}

async function plot() {
  const box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
  return { box, at: (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy }) };
}

async function drag(from, to, steps = 24) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  }
  await page.mouse.up();
}

/** The interaction set every level runs, so the rows compare. */
async function exercise(label) {
  const p = await plot();
  const out = {};

  out.crosshair = await measure(page, 'crosshair', async () => {
    for (let i = 0; i <= 50; i += 1) {
      const q = p.at(0.15 + (0.7 * i) / 50, 0.3 + 0.25 * Math.sin(i / 3));
      await page.mouse.move(q.x, q.y);
    }
  });

  out.pan = await measure(page, 'pan', async () => {
    for (let i = 0; i < 3; i += 1) {
      await drag(p.at(0.75, 0.5), p.at(0.3, 0.5), 28);
      await drag(p.at(0.3, 0.5), p.at(0.75, 0.5), 28);
    }
  });

  out.zoom = await measure(page, 'zoom', async () => {
    await page.mouse.move(p.at(0.6, 0.5).x, p.at(0.6, 0.5).y);
    for (let i = 0; i < 16; i += 1) { await page.mouse.wheel(0, -120); await page.waitForTimeout(20); }
    for (let i = 0; i < 16; i += 1) { await page.mouse.wheel(0, 120); await page.waitForTimeout(20); }
  });

  out.resize = await measure(page, 'resize', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(700);
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.waitForTimeout(700);
  });

  out.timeframe = await measure(page, 'timeframe', async () => {
    await page.click('[data-pane=p1] .chdr-tf:has-text("5m")');
    await page.waitForTimeout(1_600);
    await page.click('[data-pane=p1] .chdr-tf:has-text("1m")');
    await page.waitForTimeout(1_600);
  });

  const res = await page.evaluate(() => window.__perf.resources());
  return { label, ...out, res };
}

function summarise(level, r) {
  const f = (m) => `${n(m.frames.p95)}/${n(m.frames.worst, 0)}`;
  return {
    level,
    'crosshair fps': n(r.crosshair.frames.fps, 0),
    'crosshair p95/worst': f(r.crosshair),
    'pan fps': n(r.pan.frames.fps, 0),
    'pan p95/worst': f(r.pan),
    'pan >50ms': r.pan.frames.over50,
    'zoom fps': n(r.zoom.frames.fps, 0),
    'zoom p95/worst': f(r.zoom),
    'resize worst': n(r.resize.frames.worst, 0),
    'tf worst': n(r.timeframe.frames.worst, 0),
    'long tasks': (r.crosshair.longTasks.n ?? 0) + (r.pan.longTasks.n ?? 0) + (r.zoom.longTasks.n ?? 0),
    heapMB: n(r.res.heapMB),
    dom: r.res.domNodes,
  };
}

try {
  await signIn(page);
  await page.waitForTimeout(3_000);
  if ((await page.locator('[data-testid=chart-pane]').count()) > 1) {
    await page.click('[data-testid=layout-button]');
    await page.waitForTimeout(400);
    await page.click('[data-testid=layout-choices] button[data-layout=ONE]');
    await page.waitForTimeout(2_500);
  }
  await clearDrawings(page);
  await clearIndicators(page);
  await page.waitForTimeout(1_000);

  const rows = [];

  if (MODE === 'drawings') {
    for (const count of [0, 1, 10, 25, 50, 100, 250, 500, 750, 1000]) {
      const seeded = await seedDrawings(count);
      if (seeded.status !== 200 && count > 0) {
        console.log(`${count}: SEED FAILED status=${seeded.status} ${JSON.stringify(seeded).slice(0, 120)}`);
        rows.push({ level: `${count} drawings`, 'crosshair fps': 'SEED FAILED' });
        continue;
      }
      const painted = await page.evaluate(() => window.__atlasDrawings?.().length ?? -1);
      const r = await exercise(`${count} drawings`);
      const s = summarise(`${count} drawings`, r);
      s.onChart = painted;
      s.bytes = seeded.bytes ?? 0;
      rows.push(s);
      console.log(
        `${String(count).padStart(4)} drawings (${String(painted).padStart(4)} on chart) ` +
          `pan ${s['pan fps'].padStart(3)}fps p95 ${s['pan p95/worst'].padEnd(12)} ` +
          `crosshair ${s['crosshair fps'].padStart(3)}fps p95 ${s['crosshair p95/worst'].padEnd(12)} ` +
          `zoom ${s['zoom fps'].padStart(3)}fps  long ${String(s['long tasks']).padStart(3)}  heap ${s.heapMB}MB  dom ${s.dom}`,
      );
    }
    await seedDrawings(0);
  }

  if (MODE === 'indicators') {
    const CATALOGUE = ['Exponential moving', 'Moving average', 'Relative strength', 'Bollinger', 'VWAP', 'MACD', 'Average true range', 'Volume'];
    const add = async (name) => {
      await page.click('.chdr-btn:has-text("Indicators")');
      await page.waitForTimeout(350);
      const item = page.locator(`[data-testid=indicator-catalogue] .pop-item:has-text("${name}")`).first();
      if ((await item.count()) === 0) { await page.keyboard.press('Escape'); return false; }
      await item.click();
      await page.waitForTimeout(900);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      return true;
    };
    let live = 0;
    for (const target of [1, 5, 10, 20, 30]) {
      while (live < target) {
        const ok = await add(CATALOGUE[live % CATALOGUE.length]);
        live += 1;
        if (!ok) break;
      }
      const onChart = await page.locator('[data-testid=indicator-row]').count();
      const r = await exercise(`${target} indicators`);
      const s = summarise(`${target} indicators`, r);
      s.onChart = onChart;
      rows.push(s);
      console.log(
        `${String(target).padStart(3)} indicators (${String(onChart).padStart(3)} rows) ` +
          `pan ${s['pan fps'].padStart(3)}fps p95 ${s['pan p95/worst'].padEnd(12)} ` +
          `crosshair ${s['crosshair fps'].padStart(3)}fps  zoom ${s['zoom fps'].padStart(3)}fps  ` +
          `tf worst ${s['tf worst']}ms  long ${s['long tasks']}  heap ${s.heapMB}MB  dom ${s.dom}`,
      );
    }
    // The combinations the brief asks for.
    for (const [d, i] of [[100, 10], [250, 10], [500, 10], [250, 20]]) {
      await seedDrawings(d);
      const have = await page.locator('[data-testid=indicator-row]').count();
      while ((await page.locator('[data-testid=indicator-row]').count()) < i) {
        if (!(await add(CATALOGUE[(await page.locator('[data-testid=indicator-row]').count()) % CATALOGUE.length]))) break;
      }
      const r = await exercise(`${d}d + ${i}i`);
      const s = summarise(`${d} drawings + ${i} indicators`, r);
      rows.push(s);
      console.log(
        `${String(d).padStart(4)}d + ${String(i).padStart(2)}i  pan ${s['pan fps'].padStart(3)}fps p95 ${s['pan p95/worst'].padEnd(12)} ` +
          `crosshair ${s['crosshair fps'].padStart(3)}fps  zoom ${s['zoom fps'].padStart(3)}fps  long ${s['long tasks']}  heap ${s.heapMB}MB`,
      );
    }
    await seedDrawings(0);
    await clearIndicators(page);
  }

  if (MODE === 'charts') {
    const setLayout = async (kind) => {
      await page.click('[data-testid=layout-button]');
      await page.waitForTimeout(350);
      await page.click(`[data-testid=layout-choices] button[data-layout=${kind}]`);
      await page.waitForTimeout(4_500);
    };
    for (const [kind, label] of [['ONE', '1 chart'], ['TWO_V', '2 charts'], ['THREE', '3 charts'], ['FOUR', '4 charts']]) {
      await setLayout(kind);
      const r = await exercise(label);
      const s = summarise(label, r);
      s.onChart = await page.locator('[data-testid=chart-pane]').count();
      rows.push(s);
      console.log(
        `${label.padEnd(9)} pan ${s['pan fps'].padStart(3)}fps p95 ${s['pan p95/worst'].padEnd(12)} ` +
          `crosshair ${s['crosshair fps'].padStart(3)}fps  zoom ${s['zoom fps'].padStart(3)}fps  ` +
          `long ${s['long tasks']}  heap ${s.heapMB}MB  dom ${s.dom}  canvases ${r.res.canvases}`,
      );
    }
    // Four charts, loaded.
    await seedDrawings(250);
    await setLayout('FOUR');
    const r = await exercise('4 charts + 250 drawings');
    const s = summarise('4 charts + 250 drawings', r);
    rows.push(s);
    console.log(`4 charts + 250 drawings  pan ${s['pan fps']}fps p95 ${s['pan p95/worst']}  heap ${s.heapMB}MB  dom ${s.dom}`);
    await seedDrawings(0);
    await setLayout('ONE');
  }

  if (MODE === 'endurance') {
    const minutes = ARG > 0 ? ARG : 15;
    const deadline = Date.now() + minutes * 60_000;
    const samples = [];
    let cycle = 0;
    console.log(`endurance: ${minutes} minutes of realistic activity`);
    while (Date.now() < deadline) {
      cycle += 1;
      const p = await plot();
      await drag(p.at(0.7, 0.5), p.at(0.35, 0.5), 20);
      await page.mouse.move(p.at(0.5, 0.4).x, p.at(0.5, 0.4).y);
      for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, i % 2 ? 120 : -120);
      if (cycle % 2 === 0) {
        await page.click('[data-pane=p1] .chdr-tf:has-text("5m")');
        await page.waitForTimeout(1_200);
        await page.click('[data-pane=p1] .chdr-tf:has-text("1m")');
        await page.waitForTimeout(1_200);
      }
      if (cycle % 3 === 0) {
        await page.click('[data-pane=p1] .chdr-symbol');
        await page.waitForTimeout(300);
        await page.click('.popover .pop-item:has(.chdr-pop-root:text-is("ES"))').catch(() => {});
        await page.waitForTimeout(2_200);
        await page.click('[data-pane=p1] .chdr-symbol');
        await page.waitForTimeout(300);
        await page.click('.popover .pop-item:has(.chdr-pop-root:text-is("NQ"))').catch(() => {});
        await page.waitForTimeout(2_200);
      }
      if (cycle % 4 === 0) {
        await page.click('.chdr-btn:has-text("Indicators")');
        await page.waitForTimeout(300);
        await page.click('[data-testid=indicator-catalogue] .pop-item:has-text("Exponential moving")').catch(() => {});
        await page.waitForTimeout(800);
        await page.keyboard.press('Escape');
        const remove = page.locator('[data-testid=indicator-row] .ind-btn-danger').first();
        if (await remove.count()) await remove.click();
        await page.waitForTimeout(600);
      }
      if (cycle % 5 === 0) {
        await page.click('[data-testid=apprail-journal]').catch(() => {});
        await page.waitForTimeout(1_800);
        await page.click('[data-testid=apprail-charts]').catch(() => {});
        await page.waitForTimeout(1_200);
      }
      const res = await page.evaluate(() => window.__perf.resources());
      samples.push({ minute: Math.round((minutes * 60_000 - (deadline - Date.now())) / 6000) / 10, ...res });
      const s = samples[samples.length - 1];
      console.log(`  t+${String(s.minute).padStart(5)}min  heap ${n(s.heapMB)}MB  dom ${s.domNodes}  canvases ${s.canvases}  canvasMPx ${n(s.canvasMPixels, 2)}`);
    }
    const first = samples[0], last = samples[samples.length - 1];
    rows.push({ level: 'endurance start', heapMB: n(first.heapMB), dom: first.domNodes, canvases: first.canvases });
    rows.push({ level: 'endurance end', heapMB: n(last.heapMB), dom: last.domNodes, canvases: last.canvases });
    console.log(`\nheap ${n(first.heapMB)}MB -> ${n(last.heapMB)}MB   dom ${first.domNodes} -> ${last.domNodes}   canvases ${first.canvases} -> ${last.canvases}`);
  }

  if (rows.length > 0) console.log('\n' + table(rows, Object.keys(rows[0])));
  console.log(`\npage errors: ${errors.length === 0 ? 'none' : errors.slice(0, 10).join(' | ')}`);
} finally {
  await browser.close();
}
