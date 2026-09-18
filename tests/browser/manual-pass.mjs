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
import { SHOTS, launch, signIn, shot, clearDrawings } from './harness.mjs';

const { browser, page, errors } = await launch({ width: 1680, height: 1050 });
let step = 0;

/** Photograph ONE element, tightly, for a report that asks for that thing. */
async function closeUp(selector, name, pad = 8) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) {
    console.log(`  (no ${selector} to photograph)`);
    return;
  }
  const size = page.viewportSize();
  await page.screenshot({
    path: `${SHOTS}/${name}.png`,
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.min(size.width - Math.max(0, box.x - pad), box.width + pad * 2),
      height: Math.min(size.height - Math.max(0, box.y - pad), box.height + pad * 2),
    },
  });
  console.log(`${name}`);
}

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

/** The mark price the open position is valued at, from the blotter. */
async function markPrice() {
  await page.click('.tab:text-is("Positions")');
  await page.waitForTimeout(600);
  const cells = page.locator('.data-table tbody tr td');
  if ((await cells.count()) < 5) return null;
  const cell = ((await cells.nth(4).textContent()) ?? '').trim();
  const value = Number(cell.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/** Drag the position marker to a pixel offset from the mark: +down, -up. */
async function dragFromMark(dy) {
  const price = await markPrice();
  if (price === null) return false;
  const chart = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
  const y = await page.evaluate((v) => window.__atlasChartView?.(undefined, v)?.yAtPrice ?? null, price);
  if (y === null) return false;
  const target = chart.y + y + dy;
  const marker = await page.locator('[data-testid=marker-position]').boundingBox();
  if (!marker) return false;
  const from = { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 60, from.y + (target - from.y) / 2, { steps: 6 });
  await page.mouse.move(from.x - 60, target, { steps: 6 });
  await page.waitForTimeout(400);
  await shot(page, `manual-${String(step).padStart(2, '0')}x-dragging-protective`);
  await page.mouse.up();
  await page.waitForTimeout(3_000);
  return true;
}

/** Flatten and cancel, so the walkthrough leaves the account as it found it. */
async function flatten() {
  const close = page.locator('.tk-grid2 button:has-text("Close")');
  if (await close.isEnabled().catch(() => false)) {
    await close.click();
    await page.waitForTimeout(3_000);
  }
  const cancel = page.locator('.tk-grid2 button:has-text("Cancel orders")');
  if (await cancel.isEnabled().catch(() => false)) {
    await cancel.click();
    await page.waitForTimeout(2_500);
  }
}

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

  // --- 10. the price motion setting ----------------------------------------
  /*
   * The brief asked for this by name and said twice that it could not be
   * found, so both states are photographed: RAW with the smoothing controls
   * gone, SMOOTH with them, and the presentation-only guarantee in the panel.
   */
  await page.click('[data-testid=apprail-settings]');
  await page.waitForTimeout(900);
  await page.click('.st-nav-item:text-is("Price motion")');
  await page.waitForTimeout(500);
  await page.click('[data-testid=motion-raw]');
  await record('price-motion-raw', 700);
  await page.click('[data-testid=motion-smooth]');
  await record('price-motion-smooth', 700);
  console.log(
    `  guarantee: ${((await page.textContent('[data-testid=motion-guarantee]')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)}`,
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  // --- 11. the micro contracts ---------------------------------------------
  // NQ and ES were walked above; MNQ and MES are the ones whose tick VALUE
  // differs by a factor of ten, which is where a P&L error would show.
  for (const root of ['MNQ', 'MES']) {
    await page.click('[data-pane=p1] .chdr-symbol');
    await page.waitForTimeout(600);
    await page.click(`.popover .pop-item:has(.chdr-pop-root:text-is("${root}"))`);
    await page.waitForTimeout(4_000);
    await record(`symbol-${root.toLowerCase()}`);
    console.log(
      `  ${root}: ${((await page.textContent('[data-pane=p1] [data-testid=status-line]')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 110)}`,
    );
  }
  await page.click('[data-pane=p1] .chdr-symbol');
  await page.waitForTimeout(600);
  await page.click('.popover .pop-item:has(.chdr-pop-root:text-is("NQ"))');
  await page.waitForTimeout(4_000);

  // --- 12. a real trade, with a stop and a target --------------------------
  /*
   * The four account boxes, the position marker, and the protective labels -
   * at rest showing only their dollars, and widened while a leg is being
   * placed. Server-side throughout: every order here exists in the blotter.
   */
  await flatten();
  await page.click('.tk-preset:text-is("1")');
  await page.waitForTimeout(400);
  const boxesBefore = (await page.locator('.abar-box').allTextContents()).map((t) =>
    t.replace(/\s+/g, ' ').trim(),
  );
  console.log(`  account bar before: ${boxesBefore.join('  |  ')}`);
  await page.click('[data-testid=buy]');
  await page.waitForTimeout(6_000);
  await record('position-open');
  const boxesOpen = (await page.locator('.abar-box').allTextContents()).map((t) =>
    t.replace(/\s+/g, ' ').trim(),
  );
  console.log(`  account bar with a position: ${boxesOpen.join('  |  ')}`);
  await closeUp('.abar', 'manual-account-bar', 4);

  if ((await page.locator('[data-testid=marker-position]').count()) > 0) {
    await dragFromMark(-150);
    await record('target-placed', 1_200);
    await dragFromMark(150);
    await record('stop-and-target', 1_200);
    // count() first: textContent on a missing selector waits out the whole
    // default timeout before it throws, and a leg that filled is legitimately
    // not there any more.
    for (const leg of ['stop', 'target']) {
      const label = page.locator(`[data-testid=marker-${leg}]`);
      const text =
        (await label.count()) > 0
          ? ((await label.first().textContent()) ?? '').replace(/\s+/g, ' ').trim()
          : 'not on the chart';
      console.log(`  ${leg} label at rest: "${text}"`);
    }
    await page.click('.tab:text-is("Orders")');
    await record('protective-orders-on-the-server', 1_200);
  }
  await flatten();
  await page.click('.tab:text-is("Trades")');
  await record('trade-recorded', 1_500);
  const boxesAfter = (await page.locator('.abar-box').allTextContents()).map((t) =>
    t.replace(/\s+/g, ' ').trim(),
  );
  console.log(`  account bar after closing: ${boxesAfter.join('  |  ')}`);

  // --- 13. a deliberately unusual Fibonacci set ----------------------------
  await clearDrawings(page);
  box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
  await tool('Fib retracement');
  await page.mouse.click(at(box, 0.3, 0.68).x, at(box, 0.3, 0.68).y);
  await page.waitForTimeout(300);
  await page.mouse.click(at(box, 0.6, 0.3).x, at(box, 0.6, 0.3).y);
  await page.waitForTimeout(900);
  await page.keyboard.press('Escape');
  await page.mouse.dblclick(at(box, 0.45, 0.49).x, at(box, 0.45, 0.49).y);
  await page.waitForTimeout(900);
  const levelEditor = page.locator('[data-testid=level-editor]');
  if ((await levelEditor.count()) > 0) {
    // Nothing standard: 11.1, 33.3 and 88.8, named by hand. The default set
    // is not hard-coded anywhere the editor can reach, which is the point.
    const values = levelEditor.locator('.dp-level-value');
    const labels = levelEditor.locator('.dp-level-label');
    const custom = [
      ['11.1', 'first'],
      ['33.3', 'third'],
      ['88.8', 'late'],
    ];
    for (let i = 0; i < custom.length && i < (await values.count()); i += 1) {
      await values.nth(i).fill(custom[i][0]);
      await values.nth(i).press('Enter');
      await labels.nth(i).fill(custom[i][1]);
      await labels.nth(i).press('Enter');
      await page.waitForTimeout(250);
    }
    await levelEditor.locator('.dp-level-add').click();
    await page.waitForTimeout(400);
    await values.last().fill('261.8');
    await values.last().press('Enter');
    await labels.last().fill('stretch');
    await labels.last().press('Enter');
    await page.waitForTimeout(600);
    await record('fib-custom-levels', 900);
    await closeUp('[data-testid=drawing-properties]', 'manual-fib-level-editor');

    // Save it as a template, and prove it comes back after a reload.
    const nameField = page.locator('[data-testid=drawing-properties] .dp-save-name');
    if ((await nameField.count()) > 0) {
      await nameField.fill('Unusual set');
      await page.click('[data-testid=drawing-properties] .dp-btn:has-text("Save template")');
      await page.waitForTimeout(800);
      await closeUp('[data-testid=drawing-properties]', 'manual-fib-template-saved');
      console.log(
        `  templates for this tool: ${(await page.locator('[data-testid=drawing-properties] .dp-template-apply').allTextContents()).join(' / ')}`,
      );
    }
    console.log(
      `  fib levels: ${(await values.allTextContents()).join(' ')} / inputs ${(await values.evaluateAll((n) => n.map((i) => i.value))).join(' ')}`,
    );
  }
  const closeProps = page.locator('[data-testid=drawing-properties] button[aria-label="Close object settings"]');
  if ((await closeProps.count()) > 0) await closeProps.click();
  await page.waitForTimeout(600);
  await record('fib-on-the-chart', 900);

  // --- 13b. Bollinger bands, edited -----------------------------------------
  await page.click('[data-pane=p1] .chdr-btn:has-text("Indicators")');
  await page.waitForTimeout(600);
  await page.click('[data-testid=indicator-catalogue] .pop-item:has-text("Bollinger")');
  await page.waitForTimeout(1_600);
  const bbSections = await page
    .locator('[data-testid=indicator-settings] .st-group-title')
    .allTextContents();
  console.log(`  Bollinger sections: ${bbSections.join(' / ')}`);
  await closeUp('[data-testid=indicator-settings]', 'manual-bollinger-settings');
  const bbRow = (label) =>
    page
      .locator('[data-testid=indicator-settings] .st-row')
      .filter({ has: page.locator(`.st-row-label:text-is("${label}")`) });
  // A deliberately obvious edit: the upper band on its own.
  const bbUpper = bbRow('Colour').nth(1).locator('.st-colour-text');
  await bbUpper.fill('#2ec4a6');
  await bbUpper.press('Enter');
  const bbWidth = bbRow('Thickness').nth(1).locator('input[type=number]');
  await bbWidth.fill('3');
  await bbWidth.press('Enter');
  const bbFill = bbRow('Opacity').last().locator('input[type=number]');
  await bbFill.fill('18');
  await bbFill.press('Enter');
  await page.waitForTimeout(1_200);
  await page.keyboard.press('Escape');
  await record('bollinger-edited', 1_200);

  // --- 13c. the scales, by hand ---------------------------------------------
  box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
  const scaleOf = () => page.evaluate(() => window.__atlasChartView?.()?.priceRange ?? null);
  const spanOf = () => page.evaluate(() => window.__atlasChartView?.()?.span ?? null);
  const priceAxis = { x: box.x + box.width - 26, y: box.y + box.height * 0.45 };
  const timeAxis = { x: box.x + box.width * 0.5, y: box.y + box.height - 10 };
  const scale0 = await scaleOf();
  await page.mouse.move(priceAxis.x, priceAxis.y);
  await page.mouse.down();
  await page.mouse.move(priceAxis.x, priceAxis.y + 140, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const scale1 = await scaleOf();
  await page.mouse.dblclick(priceAxis.x, priceAxis.y);
  await page.waitForTimeout(900);
  const scale2 = await scaleOf();
  console.log(
    `  price axis: ${scale0?.toFixed(1)} -> dragged ${scale1?.toFixed(1)} -> double-clicked ${scale2?.toFixed(1)}`,
  );
  const span0 = await spanOf();
  await page.mouse.move(timeAxis.x, timeAxis.y);
  await page.mouse.down();
  await page.mouse.move(timeAxis.x - 200, timeAxis.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const span1 = await spanOf();
  await page.mouse.dblclick(timeAxis.x, timeAxis.y);
  await page.waitForTimeout(900);
  const span2 = await spanOf();
  console.log(
    `  time axis: ${span0?.toFixed(1)} -> dragged ${span1?.toFixed(1)} -> double-clicked ${span2?.toFixed(1)} bars`,
  );
  await record('scales-by-hand', 900);

  // --- 14. four EMAs, independently set ------------------------------------
  for (const length of [9, 21, 50, 200]) {
    await page.click('[data-pane=p1] .chdr-btn:has-text("Indicators")');
    await page.waitForTimeout(600);
    await page.click('[data-testid=indicator-catalogue] .pop-item:has-text("Exponential moving")');
    await page.waitForTimeout(1_400);
    const lengthInput = page
      .locator('[data-testid=indicator-settings] .st-row:has(.st-row-label:text-is("Length")) input[type=number]')
      .first();
    if ((await lengthInput.count()) > 0) {
      await lengthInput.fill(String(length));
      await lengthInput.press('Enter');
      await page.waitForTimeout(900);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  await record('four-emas', 1_500);
  console.log(
    `  legend: ${(await page.locator('[data-testid=indicator-row]').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim()).join(' / ')}`,
  );

  // --- 15. volume is an indicator, not furniture ---------------------------
  const paneHeightBefore = (await page.locator('[data-pane=p1] .chart-canvas').boundingBox()).height;
  await page.click('[data-pane=p1] .chdr-btn:has-text("Indicators")');
  await page.waitForTimeout(600);
  await page.click('[data-testid=indicator-catalogue] .pop-item:has-text("Volume")');
  await page.waitForTimeout(1_600);
  await page.keyboard.press('Escape');
  await record('volume-added', 1_200);
  const volumeRow = page.locator('[data-testid=indicator-row][data-kind=VOLUME]');
  if ((await volumeRow.count()) > 0) {
    await volumeRow.locator('.ind-btn-danger').click();
    await page.waitForTimeout(1_400);
  }
  await record('volume-removed', 1_200);
  const paneHeightAfter = (await page.locator('[data-pane=p1] .chart-canvas').boundingBox()).height;
  console.log(`  chart height ${Math.round(paneHeightBefore)}px -> ${Math.round(paneHeightAfter)}px after removing volume`);

  // --- 16. panel resizing, and the left rail -------------------------------
  const splitter = await page.locator('.splitter-v').boundingBox();
  await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + splitter.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitter.x + 500, splitter.y + splitter.height / 2, { steps: 12 });
  await page.mouse.up();
  await record('order-panel-narrow', 900);
  await page.mouse.move(splitter.x + 500, splitter.y + splitter.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitter.x - 60, splitter.y + splitter.height / 2, { steps: 12 });
  await page.mouse.up();
  await record('order-panel-restored', 900);
  const rail = await page.locator('.apprail').boundingBox();
  console.log(`  left navigation: ${Math.round(rail.width)}px wide, ${await page.locator('.apprail-btn').count()} destinations`);
  await record('left-navigation', 600);

  // --- 17. a reload, and what survives it ----------------------------------
  const beforeReload = {
    drawings: await page.evaluate(() => window.__atlasDrawings?.().length ?? null),
    indicators: await page.locator('[data-testid=indicator-row]').count(),
  };
  await page.reload();
  await page.waitForTimeout(8_000);
  const afterReload = {
    drawings: await page.evaluate(() => window.__atlasDrawings?.().length ?? null),
    indicators: await page.locator('[data-testid=indicator-row]').count(),
  };
  console.log(
    `  across a reload: drawings ${beforeReload.drawings} -> ${afterReload.drawings}, indicators ${beforeReload.indicators} -> ${afterReload.indicators}`,
  );
  await record('after-a-reload', 1_500);

  // --- 18. back to a clean single chart ------------------------------------
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
  await record('final-terminal', 2_000);

  console.log(`\npage errors: ${errors.length === 0 ? 'none' : errors.join(' | ')}`);
} finally {
  await browser.close();
}
