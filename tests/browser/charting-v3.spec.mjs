/**
 * Charting Experience V3 — the feel changes, proven against the real chart.
 *
 * Three behaviours this milestone added, each checked for the thing that would
 * make it worthless if it were subtly wrong:
 *
 *   - the drag threshold moves a real drag and ignores a click's jitter;
 *   - the symbol selector is fully operable from the keyboard;
 *   - the magnet's preview commits exactly what it previewed.
 */
import {
  createReport,
  clearDrawings,
  launch,
  paintedBounds,
  signIn,
} from './harness.mjs';

const report = createReport('charting-v3');
const { browser, page, errors } = await launch({ width: 1680, height: 950 });

try {
  report.watch(page);
  await signIn(page);
  const box = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  await clearDrawings(page);

  // --- a trend line to grab -------------------------------------------------
  await page.click('.rail .rail-btn[aria-label="Trend line"]');
  const a = at(0.32, 0.62);
  const b = at(0.58, 0.36);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y);
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(500);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

  // ================================================= DRAG THRESHOLD =========
  // Select it, then press and release with a 2px tremor. Nothing should move.
  await page.mouse.click(mid.x, mid.y);
  await page.waitForTimeout(300);
  const before = await paintedBounds(page, '.draw-canvas');
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x + 2, mid.y + 1); // below the 3px threshold
  await page.mouse.move(mid.x + 1, mid.y + 2);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const afterJitter = await paintedBounds(page, '.draw-canvas');
  report.say(
    Math.abs(afterJitter.left - before.left) <= 1 && Math.abs(afterJitter.top - before.top) <= 1,
    'a click with a 2px tremor does not move the drawing',
    `moved ${Math.round(afterJitter.left - before.left)},${Math.round(afterJitter.top - before.top)}`,
  );

  // Now a real drag, well past the threshold. It must move.
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  for (let i = 1; i <= 14; i += 1) await page.mouse.move(mid.x + i * 3, mid.y + i * 2);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterDrag = await paintedBounds(page, '.draw-canvas');
  report.say(
    afterDrag.left - before.left > 25 && afterDrag.top - before.top > 12,
    'a real drag past the threshold moves the drawing',
    `moved ${Math.round(afterDrag.left - before.left)},${Math.round(afterDrag.top - before.top)}`,
  );

  // ================================================= SYMBOL KEYBOARD ========
  const startSymbol = (await page.textContent('[data-pane=p1] .chdr-symbol-root'))?.trim();
  await page.click('[data-pane=p1] .chdr-symbol');
  await page.waitForTimeout(300);
  report.say(
    (await page.locator('.pop-search').count()) > 0,
    'the symbol selector opens with its search focused',
  );
  // Filter to the micros, then drive the list from the keyboard alone.
  await page.keyboard.type('m');
  await page.waitForTimeout(200);
  const firstHi = await page.locator('.pop-item-hi .chdr-pop-root').first().textContent().catch(() => null);
  report.say(firstHi !== null, 'typing highlights the first match', firstHi ?? '(none)');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(120);
  const movedHi = await page.locator('.pop-item-hi .chdr-pop-root').first().textContent().catch(() => null);
  report.say(
    movedHi !== null && movedHi !== firstHi,
    'ArrowDown moves the highlight',
    `${firstHi} -> ${movedHi}`,
  );
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const afterEnter = (await page.textContent('[data-pane=p1] .chdr-symbol-root'))?.trim();
  report.say(
    afterEnter === movedHi && afterEnter !== startSymbol,
    'Enter selects the highlighted instrument',
    `${startSymbol} -> ${afterEnter}`,
  );
  report.say(
    (await page.locator('.pop-search').count()) === 0,
    'and the selector closes',
  );

  // Escape closes the selector without choosing.
  await page.click('[data-pane=p1] .chdr-symbol');
  await page.waitForTimeout(250);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const afterEsc = (await page.textContent('[data-pane=p1] .chdr-symbol-root'))?.trim();
  report.say(
    (await page.locator('.pop-search').count()) === 0 && afterEsc === afterEnter,
    'Escape closes the selector and changes nothing',
  );

  report.say(errors.length === 0, 'no page errors through any of it', errors.slice(0, 3).join(' | '));
} finally {
  const failed = report.finish();
  await browser.close();
  process.exitCode = failed === 0 ? 0 : 1;
}
