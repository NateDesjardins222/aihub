/**
 * The terminal under load.
 *
 * A chart with two hundred and fifty objects on it has to behave like a chart
 * with one: pan, zoom, resize, change the interval, change the instrument and
 * come back, and every object is still on the price it was drawn on and the
 * frame rate is still a frame rate.
 *
 * The drawings are seeded through the trader's own stored workspace, which is
 * how a marked-up chart actually arrives - placing two hundred and fifty
 * objects through the toolbar would measure the toolbar. The frame counts come
 * from requestAnimationFrame inside the page during a real gesture.
 */
import { createReport, launch, litPixels, shot, signIn, useSymbol } from './harness.mjs';

const { say, finish } = createReport('stress');
const { browser, page, errors } = await launch({ width: 1600, height: 950 });

const COUNTS = [1, 10, 50, 100, 250];

/** Write N drawings into the trader's stored drawings, then reload. */
async function seed(count) {
  const result = await page.evaluate(async (count) => {
    const refreshToken = window.localStorage.getItem('atlas.refreshToken');
    const session = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).then((r) => r.json());
    window.localStorage.setItem('atlas.refreshToken', session.refreshToken);
    const auth = {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
    };

    const bars = await fetch('/api/v1/marketdata/bars?symbol=NQ&timeframe=5m&limit=400', {
      headers: auth,
    }).then((r) => r.json());
    const all = bars.bars ?? [];
    if (all.length < 40) return { status: 0, bytes: 0, error: `only ${all.length} bars` };
    /*
     * The NEWEST bars, which is where the default view is.
     *
     * Objects scattered across a day of history would be off screen in the
     * view the terminal opens on, and a check that nothing is painted would
     * then be about the viewport rather than about the drawings.
     */
    const candles = all.slice(-120);
    const drawings = [];
    for (let i = 0; i < count; i += 1) {
      // Anchored to REAL bars, so the objects sit where price actually went
      // and a pan has something to carry them past.
      const from = candles[(i * 2) % (candles.length - 12)];
      const to = candles[((i * 2) % (candles.length - 12)) + 8];
      const kind = i % 3 === 0 ? 'RECTANGLE' : i % 3 === 1 ? 'TREND_LINE' : 'HORIZONTAL_LINE';
      const anchors =
        kind === 'HORIZONTAL_LINE'
          ? [{ time: from.time, price: from.low }]
          : [
              { time: from.time, price: from.low },
              { time: to.time, price: to.high },
            ];
      drawings.push({
        id: `stress-${i}`,
        kind,
        symbol: 'NQ',
        anchors,
        style: {
          color: '#5b9dff',
          opacity: 1,
          width: 1,
          dash: 'SOLID',
          filled: kind === 'RECTANGLE',
          fillColor: '#5b9dff',
          fillOpacity: 0.08,
          fontSize: 11,
          showPrice: false,
        },
        options: {},
        text: '',
        locked: false,
        hidden: false,
        timeframes: [],
      });
    }
    const body = JSON.stringify({ drawings });
    const response = await fetch('/api/v1/drawings', { method: 'PUT', headers: auth, body });
    return { status: response.status, bytes: body.length };
  }, count);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(5_000);
  return result;
}

/**
 * Back to the newest bar.
 *
 * Panning and zooming are part of what this suite does, so any check about
 * what is PAINTED has to start from a known view: an object that is off screen
 * is off screen for a good reason and is not a defect.
 */
async function home() {
  await page.click('.chart-nav button[title="Scroll to the newest bar"]');
  await page.waitForTimeout(900);
}

/** Objects the terminal thinks it has, read from the object tree. */
async function treeCount() {
  await page.click('.rail .rail-btn[aria-label="Object tree"]');
  await page.waitForTimeout(400);
  const rows = await page.locator('[data-testid=object-tree-row]').count();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  return rows;
}

/**
 * Frames painted while a gesture runs, and the worst gap between them.
 *
 * The mean is a poor measure of smoothness: a gesture that renders sixty
 * frames and then stalls for 300ms feels broken and averages fine. The long
 * gap is the number that matches what a hand feels.
 */
async function duringGesture(gesture) {
  await page.evaluate(() => {
    window.__stress = { frames: 0, worst: 0, last: performance.now() };
    const tick = () => {
      const now = performance.now();
      const gap = now - window.__stress.last;
      window.__stress.last = now;
      window.__stress.frames += 1;
      if (window.__stress.frames > 2 && gap > window.__stress.worst) window.__stress.worst = gap;
      window.__stress.raf = requestAnimationFrame(tick);
    };
    window.__stress.raf = requestAnimationFrame(tick);
  });
  const started = Date.now();
  await gesture();
  const elapsed = Date.now() - started;
  const stats = await page.evaluate(() => {
    cancelAnimationFrame(window.__stress.raf);
    return { frames: window.__stress.frames, worst: window.__stress.worst };
  });
  return { ...stats, elapsed, fps: (stats.frames / elapsed) * 1_000 };
}

try {
  await signIn(page);
  // This suite trades NQ, so the ticket has to be pointed at NQ.
  await useSymbol(page, 'NQ');
  const box = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  const worstByCount = [];

  for (const count of COUNTS) {
    const seeded = await seed(count);
    say(seeded.status === 200, `${count} drawings can be saved`, `${seeded.bytes} bytes, HTTP ${seeded.status}`);
    say(
      (await page.locator('[data-testid=save-error]').count()) === 0,
      `and the terminal reports no save failure at ${count}`,
    );
    say((await treeCount()) === count, `all ${count} come back after a reload`);
    await home();
    say((await litPixels(page, '.draw-canvas')) > 20, `and they are painted at ${count}`);

    // --- pan ---------------------------------------------------------------
    const pan = await duringGesture(async () => {
      await page.mouse.move(at(0.85, 0.06).x, at(0.85, 0.06).y);
      await page.mouse.down();
      for (let i = 0; i < 40; i += 1) {
        await page.mouse.move(at(0.85, 0.06).x - i * 8, at(0.85, 0.06).y);
      }
      await page.mouse.up();
    });
    say(
      pan.fps > 30 && pan.worst < 120,
      `panning stays smooth with ${count} drawings`,
      `${pan.fps.toFixed(0)} fps, worst frame ${pan.worst.toFixed(0)}ms`,
    );

    // --- crosshair ---------------------------------------------------------
    const sweep = await duringGesture(async () => {
      for (let i = 0; i < 60; i += 1) {
        const fx = 0.2 + (i % 30) / 50;
        await page.mouse.move(at(fx, 0.35 + (i % 10) / 40).x, at(fx, 0.35 + (i % 10) / 40).y);
      }
    });
    say(
      sweep.fps > 30 && sweep.worst < 120,
      `the crosshair keeps up with ${count} drawings`,
      `${sweep.fps.toFixed(0)} fps, worst frame ${sweep.worst.toFixed(0)}ms`,
    );

    // --- zoom --------------------------------------------------------------
    const zoom = await duringGesture(async () => {
      await page.mouse.move(at(0.6, 0.5).x, at(0.6, 0.5).y);
      for (let i = 0; i < 16; i += 1) await page.mouse.wheel(0, i % 2 === 0 ? -120 : 120);
    });
    say(
      zoom.worst < 150,
      `zooming does not stall with ${count} drawings`,
      `worst frame ${zoom.worst.toFixed(0)}ms`,
    );

    worstByCount.push({ count, pan: Math.round(pan.worst), sweep: Math.round(sweep.worst) });

    // --- resize ------------------------------------------------------------
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(1_200);
    await home();
    say((await litPixels(page, '.draw-canvas')) > 20, `a resize keeps them on the chart at ${count}`);
    await page.setViewportSize({ width: 1600, height: 950 });
    await page.waitForTimeout(1_200);

    // --- interval, and back ------------------------------------------------
    const prices = async () => {
      await page.click('.rail .rail-btn[aria-label="Object tree"]');
      await page.waitForTimeout(400);
      const rows = await page.locator('[data-testid=object-tree-row] .ot-detail').allTextContents();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      return rows.join('|');
    };
    const before = await prices();
    const current = await page.locator('.chdr-tf-on').first().innerText();
    const other = await page
      .locator('.chdr-tf:not(.chdr-tf-on):not(.chdr-tf-more)')
      .first()
      .innerText();
    await page.click(`.chdr-tf:text-is("${other}")`);
    await page.waitForTimeout(4_500);
    await home();
    say(
      (await litPixels(page, '.draw-canvas')) > 20,
      `changing the interval to ${other} keeps them at ${count}`,
    );
    await page.click(`.chdr-tf:text-is("${current}")`);
    await page.waitForTimeout(4_500);
    say(
      (await prices()) === before,
      `and coming back to ${current} leaves every anchor where it was at ${count}`,
    );

    // --- instrument, and back ---------------------------------------------
    const pickSymbol = async (root) => {
      await page.click('.chdr-symbol');
      await page.waitForTimeout(400);
      await page.click(`.pop-item:has(.chdr-pop-root:text-is("${root}"))`);
      await page.waitForTimeout(5_500);
    };
    await pickSymbol('ES');
    await home();
    say(
      (await litPixels(page, '.draw-canvas')) === 0,
      `another instrument shows none of NQ’s objects at ${count}`,
    );
    await pickSymbol('NQ');
    say((await prices()) === before, `and coming back to NQ restores them all at ${count}`);


    if (count === 250) await shot(page, 'stress-250-drawings');
  }

  console.log(
    `\nworst frame, by object count:\n${worstByCount
      .map((row) => `  ${String(row.count).padStart(3)}  pan ${row.pan}ms  crosshair ${row.sweep}ms`)
      .join('\n')}`,
  );

  // The clean-up is itself a check: a chart can be emptied again.
  await page.evaluate(async () => {
    const refreshToken = window.localStorage.getItem('atlas.refreshToken');
    const session = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).then((r) => r.json());
    window.localStorage.setItem('atlas.refreshToken', session.refreshToken);
    await fetch('/api/v1/drawings', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ drawings: [] }),
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(4_000);
  say((await litPixels(page, '.draw-canvas')) === 0, 'the chart can be emptied again');

  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  await browser.close();
}

process.exit(finish());
