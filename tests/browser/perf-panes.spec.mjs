/**
 * Four charts at once, under the hand.
 *
 * The single-chart frame budget is measured by `stress`. This is the new risk:
 * four panes, four series, four overlay layers, and a crosshair that three of
 * them are following. If multi-chart costs the terminal its frame rate then
 * multi-chart is not finished, however many panes appear.
 *
 * Thresholds match `stress` - above 30 fps during a gesture, worst frame under
 * 120ms - because a trader's hand does not care which layout is open.
 */
import { createReport, launch, shot, signIn } from './harness.mjs';

const { say, finish, watch } = createReport('perf-panes');
const { browser, page, errors } = await launch({ width: 1680, height: 950 });
watch(page);

/** Frames during a gesture, counted inside the page by requestAnimationFrame. */
async function duringGesture(gesture) {
  await page.evaluate(() => {
    window.__perf = { frames: 0, worst: 0, last: performance.now() };
    const tick = () => {
      const now = performance.now();
      const gap = now - window.__perf.last;
      window.__perf.last = now;
      window.__perf.frames += 1;
      if (window.__perf.frames > 2 && gap > window.__perf.worst) window.__perf.worst = gap;
      window.__perf.raf = requestAnimationFrame(tick);
    };
    window.__perf.raf = requestAnimationFrame(tick);
  });
  const started = Date.now();
  await gesture();
  const elapsed = Date.now() - started;
  const stats = await page.evaluate(() => {
    cancelAnimationFrame(window.__perf.raf);
    return { frames: window.__perf.frames, worst: window.__perf.worst };
  });
  return { ...stats, elapsed, fps: (stats.frames / elapsed) * 1_000 };
}

async function chooseLayout(kind) {
  await page.click('[data-testid=layout-button]');
  await page.waitForTimeout(400);
  await page.click(`[data-testid=layout-choices] button[data-layout=${kind}]`);
  await page.waitForTimeout(kind === 'ONE' ? 2_500 : 7_000);
}

async function setSync(label, on) {
  await page.click('[data-testid=layout-button]');
  await page.waitForTimeout(400);
  const box = page.locator(`input[aria-label="Sync ${label}"]`);
  if (on) await box.check();
  else await box.uncheck();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

try {
  await signIn(page);
  await page.waitForTimeout(4_000);

  const measure = async (label) => {
    const box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
    const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

    const pan = await duringGesture(async () => {
      await page.mouse.move(at(0.85, 0.2).x, at(0.85, 0.2).y);
      await page.mouse.down();
      for (let i = 0; i < 40; i += 1) await page.mouse.move(at(0.85, 0.2).x - i * 6, at(0.85, 0.2).y);
      await page.mouse.up();
    });
    say(
      pan.fps > 30 && pan.worst < 120,
      `panning ${label} stays smooth`,
      `${pan.fps.toFixed(0)} fps, worst frame ${pan.worst.toFixed(0)}ms`,
    );

    const sweep = await duringGesture(async () => {
      for (let i = 0; i < 60; i += 1) {
        const fx = 0.2 + (i % 30) / 50;
        await page.mouse.move(at(fx, 0.35 + (i % 10) / 40).x, at(fx, 0.35 + (i % 10) / 40).y);
      }
    });
    say(
      sweep.fps > 30 && sweep.worst < 120,
      `the crosshair keeps up ${label}`,
      `${sweep.fps.toFixed(0)} fps, worst frame ${sweep.worst.toFixed(0)}ms`,
    );

    const zoom = await duringGesture(async () => {
      await page.mouse.move(at(0.6, 0.5).x, at(0.6, 0.5).y);
      for (let i = 0; i < 16; i += 1) await page.mouse.wheel(0, i % 2 === 0 ? -120 : 120);
    });
    say(
      zoom.fps > 30 && zoom.worst < 120,
      `and the wheel ${label}`,
      `${zoom.fps.toFixed(0)} fps, worst frame ${zoom.worst.toFixed(0)}ms`,
    );
    return { pan, sweep, zoom };
  };

  await chooseLayout('ONE');
  await setSync('crosshair', false);
  await setSync('time range', false);
  const one = await measure('one chart');

  await chooseLayout('FOUR');
  const four = await measure('with four charts open');

  await setSync('crosshair', true);
  await setSync('time range', true);
  const synced = await measure('with four charts kept in step');
  await shot(page, 'perf-four-panes');

  // The point of the numbers: four panes cost something, but not a cliff.
  say(
    synced.sweep.fps > one.sweep.fps * 0.5,
    'keeping four charts in step costs less than half the frame rate',
    `${one.sweep.fps.toFixed(0)} fps with one, ${four.sweep.fps.toFixed(0)} with four, ${synced.sweep.fps.toFixed(0)} synced`,
  );

  await setSync('crosshair', false);
  await setSync('time range', false);
  await chooseLayout('ONE');
  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  await browser.close();
}

process.exit(finish());
