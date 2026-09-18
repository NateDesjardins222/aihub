/**
 * The chart must stay usable after a drawing is made.
 *
 * This is the regression suite for the freeze: the drawing canvas used to take
 * pointer events as soon as any drawing existed, so the chart could not be
 * panned or zoomed again until the drawing was deleted.
 *
 * Panning is verified through something a trader can see rather than through a
 * test hook: hover a fixed x, read the bar the status line reports, pan, and
 * read it again. If the chart moved, a different bar is under that pixel.
 */
import { clearDrawings, createReport, launch, litPixels, paintedBounds, shot, signIn } from './harness.mjs';

const { say, finish, watch } = createReport('drawing-pointer');
const { browser, page, errors } = await launch();
watch(page);

/** The OHLC the status line reports for whatever is under the cursor. */
async function barUnder(x, y) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(450);
  return ((await page.textContent('.sl-ohlc')) ?? '').replace(/\s+/g, ' ').trim();
}

try {
  await signIn(page);

  const box = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const probe = at(0.35, 0.4);

  await clearDrawings(page);

  // A baseline: panning works before anything is drawn.
  const before = await barUnder(probe.x, probe.y);
  await page.mouse.move(at(0.6, 0.5).x, at(0.6, 0.5).y);
  await page.mouse.down();
  await page.mouse.move(at(0.3, 0.5).x, at(0.6, 0.5).y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const afterBaseline = await barUnder(probe.x, probe.y);
  say(before !== afterBaseline && before.length > 0, 'the chart pans with no drawings', `${before} -> ${afterBaseline}`);

  // --- draw a trend line, then pan ----------------------------------------
  await page.click('.rail .rail-btn[aria-label="Trend line"]');
  await page.mouse.click(at(0.3, 0.35).x, at(0.3, 0.35).y);
  await page.mouse.click(at(0.5, 0.6).x, at(0.5, 0.6).y);
  await page.waitForTimeout(700);
  const litTrendLine = await litPixels(page, '.draw-canvas');
  say(litTrendLine > 200, 'the trend line is painted', `${litTrendLine} lit pixels`);
  say(
    await page.locator('.rail .rail-btn[aria-label=Cursor]').evaluate((n) => n.classList.contains('rail-btn-on')),
    'the tool returns to the cursor after placement',
  );

  const beforePan = await barUnder(probe.x, probe.y);
  // Start the pan on empty chart space, well away from the line.
  await page.mouse.move(at(0.75, 0.2).x, at(0.75, 0.2).y);
  await page.mouse.down();
  await page.mouse.move(at(0.45, 0.2).x, at(0.75, 0.2).y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const afterPan = await barUnder(probe.x, probe.y);
  say(beforePan !== afterPan, 'the chart still pans after drawing a trend line', `${beforePan} -> ${afterPan}`);

  // --- draw a rectangle, then zoom ----------------------------------------
  await page.click('.rail .rail-btn[aria-label="Rectangle"]').catch(async () => {
    await page.click('.rail .rail-btn[aria-label="All drawing tools"]');
    await page.click('.popover .pop-item:has-text("Shapes")');
    await page.click('.popover .pop-item:has-text("Rectangle")');
  });
  await page.mouse.click(at(0.62, 0.3).x, at(0.62, 0.3).y);
  await page.waitForTimeout(300);
  await page.mouse.click(at(0.78, 0.5).x, at(0.78, 0.5).y);
  await page.waitForTimeout(800);
  const litWithRectangle = await litPixels(page, '.draw-canvas');
  say(
    litWithRectangle > litTrendLine,
    'the rectangle is painted alongside the trend line',
    `${litTrendLine} -> ${litWithRectangle} lit pixels`,
  );

  // --- select, drag, deselect ---------------------------------------------
  // A horizontal line is used for this: it is hit anywhere along its width, so
  // the assertion tests SELECTION rather than the test's ability to find a
  // corner on a moving axis.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  // Cleared first so the measurement below can only be the horizontal line.
  // Drawing with several objects present is covered by the pan and zoom checks
  // above; this part is about selection.
  await clearDrawings(page);
  await page.click('.rail .rail-btn[aria-label="Horizontal line"]');
  await page.mouse.click(at(0.4, 0.45).x, at(0.4, 0.45).y);
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  say(
    (await page.locator('[data-testid=drawing-style-bar]:not([hidden])').count()) === 0,
    'Escape deselects',
  );

  let line = await paintedBounds(page, '.draw-canvas', { x0: 0.02, x1: 0.06 });
  say(line !== null, 'the horizontal line spans the chart');

  // Re-measured on each attempt: the price axis auto-scales as the market
  // moves, so a drawing anchored to a price drifts a few pixels between being
  // measured and being clicked. A trader clicks the line they can see; so does
  // this.
  let selected = false;
  for (let attempt = 0; attempt < 4 && !selected; attempt += 1) {
    line = await paintedBounds(page, '.draw-canvas', { x0: 0.02, x1: 0.06 });
    if (!line) break;
    await page.mouse.click(at(0.5, 0).x, line.top);
    await page.waitForTimeout(400);
    selected = (await page.locator('[data-testid=drawing-style-bar]:not([hidden])').count()) === 1;
  }
  say(selected, 'clicking a drawing selects it');

  if (selected) {
    const grab = { x: at(0.5, 0).x, y: line.top };
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x, grab.y - 60, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    const moved = await paintedBounds(page, '.draw-canvas', { x0: 0.02, x1: 0.06 });
    say(moved !== null && moved.top < line.top - 20, 'dragging it moves it', `${Math.round(line.top)} -> ${Math.round(moved?.top ?? 0)}`);
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // --- zoom, then pan, with drawings on the chart --------------------------
  const beforeZoom = await barUnder(probe.x, probe.y);
  await page.mouse.move(at(0.5, 0.5).x, at(0.5, 0.5).y);
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(700);
  const afterZoom = await barUnder(probe.x, probe.y);
  say(beforeZoom !== afterZoom, 'the chart still zooms after drawing a rectangle', `${beforeZoom} -> ${afterZoom}`);

  /*
   * Pan from empty chart, not from the line.
   *
   * The drawing on screen is a horizontal line spanning the full width, and
   * the zoom above rescaled the price axis - so a grab point fixed at 75% of
   * the height lands on the line whenever the new scale happens to put it
   * there, and dragging a drawing correctly does NOT pan the chart. The check
   * is that drawings do not FREEZE panning, so it grabs a row of pixels the
   * drawing is not in and says which row it used.
   */
  const drawn = await paintedBounds(page, '.draw-canvas');
  const canvas = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
  let grabFraction = 0.75;
  if (drawn !== null) {
    const clash = (fraction) => {
      const y = canvas.y + canvas.height * fraction;
      return y > drawn.top - 45 && y < drawn.bottom + 45;
    };
    grabFraction = [0.75, 0.25, 0.6, 0.4, 0.85, 0.15].find((f) => !clash(f)) ?? 0.75;
  }
  const beforeFinal = await barUnder(probe.x, probe.y);
  await page.mouse.move(at(0.2, grabFraction).x, at(0.2, grabFraction).y);
  await page.mouse.down();
  await page.mouse.move(at(0.5, grabFraction).x, at(0.2, grabFraction).y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const afterFinal = await barUnder(probe.x, probe.y);
  say(
    beforeFinal !== afterFinal,
    'the chart pans after selecting and deselecting',
    `grabbed at ${Math.round(grabFraction * 100)}% of the height: ${beforeFinal} -> ${afterFinal}`,
  );

  // --- undo / redo ---------------------------------------------------------
  // From a known empty state, so the assertion is about undo and not about
  // whatever earlier steps happened to leave behind.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  let litAfterClear = await litPixels(page, '.draw-canvas');
  for (let attempt = 0; attempt < 4 && litAfterClear > 0; attempt += 1) {
    if (!(await clearDrawings(page))) break;
    await page.waitForTimeout(400);
    litAfterClear = await litPixels(page, '.draw-canvas');
  }
  if (litAfterClear > 0) await shot(page, 'drawing-pointer-stuck');
  say(litAfterClear === 0, 'the chart starts with nothing drawn', `${litAfterClear} lit pixels`);

  await page.click('.rail .rail-btn[aria-label="Trend line"]');
  await page.mouse.click(at(0.35, 0.3).x, at(0.35, 0.3).y);
  await page.waitForTimeout(300);
  await page.mouse.click(at(0.6, 0.55).x, at(0.6, 0.55).y);
  await page.waitForTimeout(800);
  const litOne = await litPixels(page, '.draw-canvas');
  say(litOne > 200, 'one drawing is on the chart', `${litOne} lit pixels`);

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(700);
  const litUndone = await litPixels(page, '.draw-canvas');
  say(litUndone === 0, 'undo removes it', `${litUndone} lit pixels`);

  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(700);
  const litRedone = await litPixels(page, '.draw-canvas');
  say(litRedone > 200, 'redo brings it back', `${litRedone} lit pixels`);

  await shot(page, 'drawing-pointer');

  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  try {
    await clearDrawings(page);
  } catch {
    /* the browser may already be gone */
  }
  await browser.close();
}

process.exit(finish());
