/**
 * The manual acceptance walkthrough.
 *
 * Not a test suite: a scripted pass through the whole terminal at a normal
 * desktop size that stops and photographs every step, so the pass can be
 * JUDGED BY EYE rather than by an assertion. The brief asked for "a full
 * manual acceptance workflow in a real browser at normal desktop sizes, with
 * screenshots as evidence", and an assertion cannot tell you that a label is
 * ugly, a control is hidden or a panel is cramped.
 *
 * Every shot lands in the shots directory with a numbered name, and the step
 * names are printed as it goes so a shot can be tied to what produced it.
 *
 *   node tests/browser/manual-pass.mjs
 */
import { launch, signIn, shot, clearDrawings } from './harness.mjs';

const { browser, page, errors } = await launch({ width: 1680, height: 1050 });
let step = 0;

async function record(name, ms = 900) {
  step += 1;
  await page.waitForTimeout(ms);
  const file = `manual-${String(step).padStart(2, '0')}-${name}`;
  await shot(page, file);
  console.log(`${file}`);
}

async function tool(name) {
  await page.click('.rail .rail-btn[aria-label="All drawing tools"]');
  await page.waitForTimeout(400);
  const item = page.locator(`.popover .rail-tool-item:has-text("${name}")`);
  if ((await item.count()) === 0) {
    // Its category is collapsed; the categories are the top-level rows.
    const rows = await page.locator('.popover > div > button.pop-item').count();
    for (let i = 0; i < rows; i += 1) {
      await page.locator('.popover > div > button.pop-item').nth(i).click();
      await page.waitForTimeout(250);
      if ((await item.count()) > 0) break;
    }
  }
  await item.first().click();
  await page.waitForTimeout(350);
}

const at = (box, fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

try {
  await signIn(page);
  await page.waitForTimeout(4_500);
  await record('signed-in');

  let box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();

  // --- 1. intervals and instruments ---------------------------------------
  for (const tf of ['5m', '15m', '1h']) {
    await page.click(`[data-pane=p1] .chdr-tf:has-text("${tf}")`);
    await page.waitForTimeout(2_200);
  }
  await record('interval-1h');
  await page.click('[data-pane=p1] .chdr-tf:has-text("1m")');
  await page.waitForTimeout(2_200);

  await page.click('[data-pane=p1] .chdr-symbol');
  await page.waitForTimeout(500);
  await record('symbol-picker', 300);
  await page.click('.popover .pop-item:has(.chdr-pop-root:text-is("ES"))');
  await page.waitForTimeout(3_500);
  await record('symbol-es');
  await page.click('[data-pane=p1] .chdr-symbol');
  await page.waitForTimeout(500);
  await page.click('.popover .pop-item:has(.chdr-pop-root:text-is("NQ"))');
  await page.waitForTimeout(3_500);

  // --- 2. navigation -------------------------------------------------------
  await page.mouse.move(at(box, 0.6, 0.5).x, at(box, 0.6, 0.5).y);
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -120);
  await record('zoomed-in');
  for (let i = 0; i < 10; i += 1) await page.mouse.wheel(0, 120);
  await record('zoomed-out');
  await page.mouse.move(at(box, 0.8, 0.3).x, at(box, 0.8, 0.3).y);
  await page.mouse.down();
  await page.mouse.move(at(box, 0.35, 0.3).x, at(box, 0.35, 0.3).y, { steps: 14 });
  await page.mouse.up();
  await record('panned');
  await page.click('[data-pane=p1] .chart-nav button[title="Reset the scales"]');
  await record('scales-reset');

  // --- 3. every drawing tool ----------------------------------------------
  await clearDrawings(page);
  box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
  const draws = [
    ['Trend line', [[0.2, 0.6], [0.32, 0.35]]],
    ['Horizontal line', [[0.4, 0.45]]],
    ['Vertical line', [[0.45, 0.5]]],
    ['Ray', [[0.5, 0.65], [0.6, 0.5]]],
    ['Extended line', [[0.52, 0.3], [0.62, 0.25]]],
    ['Rectangle', [[0.66, 0.3], [0.78, 0.55]]],
    ['Fib retracement', [[0.2, 0.75], [0.35, 0.55]]],
    ['Measure', [[0.82, 0.4], [0.9, 0.6]]],
    ['Text', [[0.7, 0.72]]],
  ];
  for (const [name, points] of draws) {
    await tool(name);
    for (const [fx, fy] of points) {
      const point = at(box, fx, fy);
      await page.mouse.move(point.x, point.y, { steps: 3 });
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(400);
  }
  await page.keyboard.press('Escape');
  await record('every-tool-drawn', 1_200);

  // The position tools, which are the new ones.
  await tool('Long position');
  const long = at(box, 0.3, 0.45);
  await page.mouse.click(long.x, long.y);
  await page.waitForTimeout(700);
  await tool('Short position');
  const short = at(box, 0.55, 0.35);
  await page.mouse.click(short.x, short.y);
  await page.waitForTimeout(700);
  await page.keyboard.press('Escape');
  await record('position-tools');

  // A selected object, with its style bar, and then its settings dialog.
  await page.mouse.click(long.x + 30, long.y + 6);
  await record('selected-style-bar', 600);
  await page.mouse.dblclick(long.x + 30, long.y + 6);
  await record('object-settings', 900);
  await page.click('[data-testid=drawing-properties] button[aria-label="Close object settings"]');
  await page.waitForTimeout(500);

  // The object tree, with everything on the chart in it.
  await page.click('.rail .rail-btn[aria-label="Object tree"]');
  await record('object-tree', 600);
  await page.keyboard.press('Escape');

  // --- 4. indicators -------------------------------------------------------
  for (const name of ['Exponential moving average', 'Relative strength index']) {
    await page.click('[data-pane=p1] .chdr-btn:has-text("Indicators")');
    await page.waitForTimeout(600);
    await page.click(`[data-testid=indicator-catalogue] .pop-item:has-text("${name}")`);
    await page.waitForTimeout(1_400);
    await record(`indicator-${name.split(' ')[0].toLowerCase()}-settings`, 400);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
  await record('indicator-rows');

  // --- 5. multi-chart ------------------------------------------------------
  await page.click('[data-testid=layout-button]');
  await record('layout-menu', 400);
  await page.click('[data-testid=layout-choices] button[data-layout=FOUR]');
  await page.waitForTimeout(7_000);
  await record('four-charts');
  await page.click('[data-pane=p2] button[aria-label="Maximize this chart"]');
  await record('maximized-pane', 1_500);
  await page.click('[data-pane=p2] button[aria-label="Restore the layout"]');
  await page.waitForTimeout(2_500);
  await page.click('[data-testid=layout-button]');
  await page.waitForTimeout(400);
  await page.click('[data-testid=layout-choices] button[data-layout=TWO_V]');
  await page.waitForTimeout(6_000);
  await record('two-charts');

  // --- 6. the journal ------------------------------------------------------
  await page.click('[data-testid=apprail-journal]');
  await page.waitForSelector('[data-testid=drawer-journal]', { timeout: 20_000 });
  await page.waitForTimeout(2_500);
  await record('journal-overview');
  await page.click('.journal-tabs .chip:has-text("Calendar")');
  await record('journal-calendar', 1_200);
  const day = page.locator('[data-testid=calendar-day]').first();
  if ((await day.count()) > 0) {
    await day.click();
    await record('journal-day', 1_200);
    await page.click('.journal-trades > li:first-child .journal-trade-head');
    await record('journal-trade-detail', 900);
  }
  await page.click('.journal-tabs .chip:has-text("Sessions")');
  await record('journal-sessions', 1_200);
  await page.click('[data-testid=drawer-journal] .drawer-close');
  await page.waitForTimeout(800);

  // --- 7. practice ---------------------------------------------------------
  await page.click('[data-testid=apprail-practice]');
  await page.waitForSelector('[data-testid=drawer-practice]', { timeout: 20_000 });
  await record('practice', 2_500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  // --- 8. the order ticket and the blotter ---------------------------------
  await page.click('.tk-preset:has-text("3")');
  await record('ticket-three-contracts', 600);
  await page.click('.tk-preset:has-text("1")');
  await page.waitForTimeout(400);
  for (const tab of ['Orders', 'Trades', 'Accounts', 'Quotes', 'Positions']) {
    await page.click(`.tab:has-text("${tab}")`);
    await record(`blotter-${tab.toLowerCase()}`, 700);
  }

  // The bottom panel collapses, and comes back.
  await page.click('.panel-head .icon-btn');
  await record('blotter-collapsed', 700);
  await page.click('.panel-head .icon-btn');
  await page.waitForTimeout(700);

  // --- 9. settings ---------------------------------------------------------
  await page.click('.abar-icon[aria-label=Settings]');
  await page.waitForTimeout(900);
  for (const section of ['Symbol', 'Status line', 'Scales and lines', 'Canvas', 'Time and format', 'Motion']) {
    const nav = page.locator(`.st-nav-item:text-is("${section}")`);
    if ((await nav.count()) === 0) continue;
    await nav.click();
    await record(`settings-${section.toLowerCase().replace(/[^a-z]+/g, '-')}`, 600);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  // --- 10. back to a clean single chart ------------------------------------
  await page.click('[data-testid=layout-button]');
  await page.waitForTimeout(400);
  await page.click('[data-testid=layout-choices] button[data-layout=ONE]');
  await page.waitForTimeout(3_000);
  await clearDrawings(page);
  for (let i = 0; i < 8; i += 1) {
    const remove = page.locator('[data-testid=indicator-row] .ind-btn-danger').first();
    if ((await remove.count()) === 0) break;
    await remove.click();
    await page.waitForTimeout(300);
  }
  await record('clean-again', 1_500);

  console.log(`\npage errors: ${errors.length === 0 ? 'none' : errors.join(' | ')}`);
} finally {
  await browser.close();
}
