/**
 * Profile the terminal's chart and drawing interaction.
 *
 * Scripted gestures against the real application, measured with the
 * instrumentation in instrument.mjs. Every number printed here was recorded in
 * the browser; none of it is inferred from reading the code.
 *
 * Run: node tests/perf/profile.mjs [drawingCount]
 */
import { launch, signIn, WEB } from '../browser/harness.mjs';
import { INSTRUMENT } from './instrument.mjs';

const DRAWINGS = Number(process.argv[2] ?? 0);

const { browser, page } = await launch({ width: 1680, height: 950 });
await page.addInitScript(INSTRUMENT);

/*
 * Chrome's own counters, through the debugging protocol.
 *
 * In a headless browser the animation-frame clock is steady whatever the page
 * is doing, so frames alone flatter the result. ScriptDuration and
 * RecalcStyleDuration are the real cost of a gesture: they are what a slower
 * machine, a busier tab or a real compositor would turn into dropped frames.
 */
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');

async function counters() {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const read = (name) => metrics.find((metric) => metric.name === name)?.value ?? 0;
  return {
    script: read('ScriptDuration'),
    layout: read('LayoutDuration'),
    style: read('RecalcStyleDuration'),
    task: read('TaskDuration'),
    nodes: read('Nodes'),
    listeners: read('JSEventListeners'),
  };
}

function row(name, result) {
  const cells = [
    name.padEnd(30),
    `${String(result.fps).padStart(3)} fps`,
    `median ${String(result.medianFrameMs).padStart(6)}ms`,
    `p95 ${String(result.p95FrameMs).padStart(7)}ms`,
    `worst ${String(result.worstFrameMs).padStart(7)}ms`,
    `jank ${String(result.jankFrames).padStart(3)}`,
    `commits ${String(result.commits).padStart(4)}`,
    `script ${String(result.scriptMs ?? 0).padStart(5)}ms`,
    `style ${String(result.styleMs ?? 0).padStart(4)}ms`,
    `layout ${String(result.layoutMs ?? 0).padStart(4)}ms`,
    `net ${String(result.requests).padStart(3)}`,
  ];
  console.log(cells.join('  '));
  if (result.components?.length) {
    console.log(' '.repeat(4) + 'rendered: ' + result.components.join(', '));
  }
  if (result.requests > 0) console.log(' '.repeat(4) + 'network:  ' + result.requestUrls.join(', '));
}

/*
 * Three runs, and the MEDIAN is reported.
 *
 * A single run of a gesture against a live market picks up whatever else the
 * tab was doing - a quote arriving, a garbage collection - and the spread
 * between runs was large enough to argue either side of a change. The median
 * of three is the smallest honest answer.
 */
async function measure(name, gesture, runs = 3) {
  const results = [];
  for (let run = 0; run < runs; run += 1) {
    results.push(await once(gesture));
  }
  const median = [...results].sort((a, b) => a.scriptMs - b.scriptMs)[Math.floor(runs / 2)];
  row(name, median);
  return median;
}

async function once(gesture) {
  const before = await counters();
  await page.evaluate(() => window.__atlas.start());
  await gesture();
  const result = await page.evaluate(() => window.__atlas.stop());
  const after = await counters();
  result.scriptMs = Math.round((after.script - before.script) * 1000);
  result.styleMs = Math.round((after.style - before.style) * 1000);
  result.layoutMs = Math.round((after.layout - before.layout) * 1000);
  result.taskMs = Math.round((after.task - before.task) * 1000);
  result.nodes = after.nodes;
  return result;
}

try {
  await signIn(page);
  await page.waitForTimeout(2_000);

  const box = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  // Clear whatever a previous run left behind.
  const tree = page.locator('.rail .rail-btn[aria-label="Object tree"]');
  if (await tree.count()) {
    await tree.click();
    await page.waitForTimeout(300);
    const clear = page.locator('.popover .rail-clear');
    if (await clear.count()) {
      await clear.click();
      await page.waitForTimeout(500);
    } else {
      await page.keyboard.press('Escape');
    }
  }

  /*
   * Load the chart up the way a trader's saved workspace does: written to
   * their preferences and restored on boot. Placing them by hand through the
   * toolbar would measure the toolbar.
   */
  if (DRAWINGS > 0) {
    console.log(`seeding ${DRAWINGS} drawings through the trader's saved workspace…`);
    const seeded = await page.evaluate(async (count) => {
      // The application holds its access token in memory; refresh through the
      // ordinary endpoint rather than reaching into it.
      const refreshToken = window.localStorage.getItem('atlas.refreshToken');
      const session = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }).then((r) => r.json());
      window.localStorage.setItem('atlas.refreshToken', session.refreshToken);
      const auth = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' };

      const quote = await fetch('/api/v1/marketdata/quote?symbol=NQ', { headers: auth }).then((r) => r.json());
      const last = quote?.quote?.last ?? quote?.last ?? 20000;
      const now = Date.now();
      const drawings = [];
      for (let i = 0; i < count; i += 1) {
        const kind = i % 3 === 0 ? 'RECTANGLE' : i % 3 === 1 ? 'TREND_LINE' : 'HORIZONTAL_LINE';
        // Every seeded drawing sits BELOW the last price, in a known band, so
        // a pan started above it is measuring a pan rather than accidentally
        // grabbing a horizontal line that spans the whole chart.
        const price = last * (1 - 0.005 - ((i % 40) / 40) * 0.025);
        const start = now - (i % 60) * 15 * 60_000;
        const anchors =
          kind === 'HORIZONTAL_LINE'
            ? [{ time: start, price }]
            : [
                { time: start, price },
                { time: start + 30 * 60_000, price: price * 1.002 },
              ];
        drawings.push({
          id: `p${i}`,
          kind,
          symbol: 'NQ',
          anchors,
          style: {
            color: '#4d8dff',
            width: 1,
            dash: 'SOLID',
            fill: kind === 'RECTANGLE' ? 'rgba(91,157,255,0.10)' : null,
            fontSize: 11,
            showPrice: false,
          },
          options: {},
          text: '',
          locked: false,
          hidden: false,
          timeframes: [],
          createdAt: now,
        });
      }
      const current = await fetch('/api/v1/preferences', { headers: auth }).then((r) => r.json());
      const preferences = current.preferences ?? {};
      preferences.chart = { ...(preferences.chart ?? {}), drawings };
      const body = JSON.stringify(preferences);
      const response = await fetch('/api/v1/preferences', { method: 'PUT', headers: auth, body });
      return { status: response.status, bytes: body.length };
    }, DRAWINGS);
    console.log(`  saved workspace: ${seeded.bytes} bytes, HTTP ${seeded.status}`);
    if (seeded.status !== 200) {
      console.log('  !! the workspace could not be saved - see the report on the 64 KB limit');
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
    await page.waitForTimeout(6_000);
  }

  /*
   * A warm-up gesture, not measured.
   *
   * The first sweep after a page load pays for compiling the paths it touches,
   * which is real for a trader loading the terminal but is not the steady
   * state the rest of this is about - and it was landing on whichever gesture
   * happened to run first, which made the comparison between gestures
   * meaningless.
   */
  for (let i = 0; i < 60; i += 1) {
    const fx = 0.25 + (i / 60) * 0.5;
    await page.mouse.move(at(fx, 0.4).x, at(fx, 0.4).y);
  }
  await page.mouse.move(at(0.5, 0.5).x, at(0.5, 0.5).y);
  await page.mouse.wheel(0, -120);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(800);

  console.log(`\n=== Atlas chart profile — ${DRAWINGS} drawings on the chart ===\n`);

  // --- idle ----------------------------------------------------------------
  await measure('idle (no interaction)', async () => {
    await page.waitForTimeout(3_000);
  });

  /*
   * Gestures are dispatched as fast as the driver can send them, with no
   * pacing. A gesture paced at 60Hz measures the pacing, not the terminal: a
   * trader moving a mouse quickly produces a burst, and a burst is what finds
   * the ceiling.
   */
  await measure('crosshair sweep (fast)', async () => {
    for (let i = 0; i < 120; i += 1) {
      const fx = 0.2 + (i / 120) * 0.6;
      const fy = 0.3 + Math.sin(i / 6) * 0.15;
      await page.mouse.move(at(fx, fy).x, at(fx, fy).y);
    }
    await page.waitForTimeout(400);
  });

  // --- pan -----------------------------------------------------------------
  // Started in the top-right, which is the emptiest part of a chart: a pan
  // that starts on a drawing is a drag, and would be measuring the wrong
  // gesture.
  await measure('pan drag (fast)', async () => {
    await page.keyboard.press('Escape');
    await page.mouse.move(at(0.92, 0.04).x, at(0.92, 0.04).y);
    await page.mouse.down();
    for (let i = 0; i < 80; i += 1) {
      await page.mouse.move(at(0.92 - i * 0.004, 0.04).x, at(0.92, 0.04).y);
    }
    await page.mouse.up();
    await page.waitForTimeout(400);
  });

  // --- zoom ----------------------------------------------------------------
  await measure('zoom wheel', async () => {
    await page.mouse.move(at(0.5, 0.5).x, at(0.5, 0.5).y);
    for (let i = 0; i < 40; i += 1) {
      await page.mouse.wheel(0, i % 2 === 0 ? -120 : 120);
    }
    await page.waitForTimeout(400);
  });

  // Hovering ACROSS the drawings, which is where hit-testing is paid for.
  await measure('crosshair over drawings', async () => {
    for (let i = 0; i < 120; i += 1) {
      const fx = 0.2 + (i / 120) * 0.6;
      const fy = 0.55 + Math.sin(i / 5) * 0.2;
      await page.mouse.move(at(fx, fy).x, at(fx, fy).y);
    }
    await page.waitForTimeout(400);
  });

  // --- drawing a rectangle -------------------------------------------------
  await measure('placing a rectangle', async () => {
    // Rectangle is a pinned tool, so this is the button a trader reaches for.
    await page.click('.rail .rail-btn[aria-label="Rectangle"]');
    await page.waitForTimeout(150);
    await page.mouse.click(at(0.35, 0.3).x, at(0.35, 0.3).y);
    for (let i = 0; i < 80; i += 1) {
      await page.mouse.move(at(0.35 + i * 0.0025, 0.3 + i * 0.002).x, at(0.35, 0.3 + i * 0.002).y);
    }
    await page.mouse.click(at(0.55, 0.46).x, at(0.55, 0.46).y);
    await page.waitForTimeout(400);
    // Leave the chart as it was found, or the third run measures a pile of
    // rectangles rather than the placing of one.
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
  });

  // --- dragging an existing drawing ---------------------------------------
  await measure('dragging a drawing', async () => {
    await page.click('.rail .rail-btn[aria-label="Rectangle"]');
    await page.waitForTimeout(150);
    await page.mouse.click(at(0.35, 0.3).x, at(0.35, 0.3).y);
    await page.mouse.click(at(0.55, 0.46).x, at(0.55, 0.46).y);
    await page.waitForTimeout(400);

    // Grab the top edge, which is a place the rectangle is certainly hit.
    await page.mouse.move(at(0.45, 0.3).x, at(0.45, 0.3).y);
    await page.mouse.down();
    for (let i = 0; i < 80; i += 1) {
      await page.mouse.move(at(0.45 + i * 0.002, 0.3 + i * 0.0015).x, at(0.45, 0.3 + i * 0.0015).y);
    }
    await page.mouse.up();
    await page.waitForTimeout(600);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
  });

  // --- after the gesture: does it talk to the network? ---------------------
  await measure('settling after a drag', async () => {
    await page.waitForTimeout(2_500);
  });

  const listeners = await page.evaluate(() => {
    const byType = window.__atlas.listeners.byType;
    const interesting = ['pointermove', 'mousemove', 'pointerdown', 'wheel', 'keydown', 'resize'];
    return {
      total: window.__atlas.listeners.added,
      interesting: Object.fromEntries(interesting.map((type) => [type, byType[type] ?? 0])),
    };
  });
  console.log('\nlisteners added since load:', JSON.stringify(listeners));

  const memory = await page.evaluate(() =>
    performance.memory
      ? {
          usedMB: Math.round(performance.memory.usedJSHeapSize / 1e6),
          totalMB: Math.round(performance.memory.totalJSHeapSize / 1e6),
        }
      : null,
  );
  console.log('heap:', JSON.stringify(memory));
} finally {
  await browser.close();
}
