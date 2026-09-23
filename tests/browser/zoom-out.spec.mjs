/**
 * Horizontal zoom-out limit.
 *
 * The zoom-out limit was too restrictive (the library's default minimum bar
 * spacing stopped it at ~2,500 bars on a full-width chart, fewer on a split).
 * The adapter now exposes MAX_VISIBLE_SPAN = 12,000 bars as the single, hard,
 * width-independent stop, with MIN_BAR_SPACING low enough that the count is what
 * binds. This drives the real chart and reads its own geometry
 * (`window.__atlasChartView().span` = visible bar count) to prove:
 *   - zoom-out now reaches far past the old limit, up to the cap;
 *   - the cap is a real hard stop (not infinite);
 *   - candles still render (no collapse into a blank canvas);
 *   - zoom-in still works and is unchanged;
 *   - it holds in ONE and TWO-chart layouts.
 */
import { createReport, launch, signIn, shot } from './harness.mjs';

const CAP = 12_000;
const { say, finish, watch } = createReport('zoom-out');
const { browser, page, errors } = await launch({ width: 1680, height: 950 });
watch(page);

const view = () => page.evaluate(() => window.__atlasChartView?.() ?? null);

/** Scroll the wheel over the active plot `times`, `dy` per notch (>0 = zoom out). */
async function wheel(times, dy) {
  const box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  for (let i = 0; i < times; i += 1) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(400);
}

/** Non-zero painted pixels on the price canvas — proof the chart still renders. */
const litCanvas = () =>
  page.evaluate(() => {
    const cv = document.querySelector('[data-pane=p1] .chart-canvas canvas');
    if (!cv) return 0;
    const ctx = cv.getContext('2d');
    if (!ctx) return 0;
    const { width, height } = cv;
    if (!width || !height) return 0;
    const d = ctx.getImageData(0, 0, width, height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 20) lit += 1;
    return lit;
  });

async function chooseLayout(kind) {
  await page.click('[data-testid=layout-button]');
  await page.waitForTimeout(400);
  await page.click(`[data-testid=layout-choices] button[data-layout=${kind}]`);
  await page.waitForTimeout(kind === 'ONE' ? 2_500 : 6_000);
}

try {
  await signIn(page);
  await chooseLayout('ONE');
  await page.waitForTimeout(1_500);

  const baseline = await view();
  say(baseline !== null, 'the chart exposes its view geometry', JSON.stringify(baseline));
  const startSpan = baseline?.span ?? 0;

  // --- extreme zoom-out, ONE layout ---------------------------------------
  await wheel(40, 480); // 40 notch-4 scrolls: more than enough to reach the cap
  const out = await view();
  const outSpan = out?.span ?? 0;
  say(
    outSpan > 4_000,
    'ONE: zoom-out now reaches far past the old ~2,500-bar limit',
    `${Math.round(startSpan)} -> ${Math.round(outSpan)} bars`,
  );
  say(
    outSpan <= CAP * 1.02,
    'ONE: and stops at the hard cap (not infinite)',
    `${Math.round(outSpan)} <= ~${CAP}`,
  );
  say(
    Math.abs(outSpan - CAP) / CAP < 0.1,
    'ONE: the cap is what binds, consistently (near 12,000 bars)',
    `${Math.round(outSpan)} bars`,
  );
  // One more push must not exceed the cap: it is a real stop.
  await wheel(10, 480);
  const pinned = (await view())?.span ?? 0;
  say(pinned <= CAP * 1.02, 'ONE: further scrolling does not pass the cap', `${Math.round(pinned)} bars`);
  say((await litCanvas()) > 500, 'ONE: candles still render at full zoom-out (no collapse)', `${await litCanvas()} px`);
  await shot(page, 'zoom-out-one');

  // --- zoom-in still works and is unchanged --------------------------------
  await wheel(60, -480); // zoom all the way back in
  const inSpan = (await view())?.span ?? 0;
  say(inSpan < 60, 'ONE: zoom-in still tightens to a handful of bars (unchanged)', `${Math.round(inSpan)} bars`);
  say(inSpan >= 6, 'ONE: zoom-in floor is intact (never inverts)', `${Math.round(inSpan)} bars`);

  // --- TWO-chart layout ----------------------------------------------------
  await chooseLayout('TWO_V');
  await page.waitForTimeout(1_500);
  await wheel(40, 480);
  const twoOut = (await view())?.span ?? 0;
  say(
    twoOut > 4_000 && twoOut <= CAP * 1.02,
    'TWO_V: the same generous cap applies on a split pane (width-independent)',
    `${Math.round(twoOut)} bars`,
  );
  say((await litCanvas()) > 500, 'TWO_V: candles still render at full zoom-out', `${await litCanvas()} px`);
  await shot(page, 'zoom-out-two');

  // Leave it tidy for anything that follows.
  await wheel(60, -480);
  await chooseLayout('ONE');

  say(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 200));
} finally {
  await browser.close();
}

process.exit(finish());
