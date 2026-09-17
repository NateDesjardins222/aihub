/**
 * The drawing engine: selection, editing, menus, templates and the object tree.
 *
 * Everything here is driven the way a trader drives it - click the object,
 * right-click it, double-click it, change a setting - and verified through what
 * changes on screen or in the object tree, never through a test hook.
 *
 * The freeze regression is re-checked at the end: opening and closing every new
 * surface must leave the chart pannable.
 */
import {
  clearDrawings,
  createReport,
  launch,
  litPixels,
  paintedBounds,
  shot,
  signIn,
} from './harness.mjs';

const { say, finish } = createReport('drawing-engine');
const { browser, page, errors } = await launch();

/** The OHLC the status line reports for whatever is under the cursor. */
async function barUnder(x, y) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(450);
  return ((await page.textContent('.sl-ohlc')) ?? '').replace(/\s+/g, ' ').trim();
}

/** Click the painted body of the only horizontal line on the chart. */
async function clickTheLine(at) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const line = await paintedBounds(page, '.draw-canvas', { x0: 0.02, x1: 0.06 });
    if (!line) return false;
    await page.mouse.click(at(0.06, 0).x, (line.top + line.bottom) / 2);
    await page.waitForTimeout(400);
    if (await page.locator('[data-testid=drawing-style-bar]:not([hidden])').count()) return true;
  }
  return false;
}

async function openTree() {
  await page.click('.rail .rail-btn[aria-label="Object tree"]');
  await page.waitForTimeout(350);
}

async function closeTree() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

async function treeRows() {
  await openTree();
  const rows = await page.locator('[data-testid=object-tree-row]').count();
  await closeTree();
  return rows;
}

try {
  await signIn(page);
  const box = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  await clearDrawings(page);

  // --- a horizontal line, selected ----------------------------------------
  await page.click('.rail .rail-btn[aria-label="Horizontal line"]');
  await page.mouse.click(at(0.4, 0.42).x, at(0.4, 0.42).y);
  await page.waitForTimeout(800);
  say((await litPixels(page, '.draw-canvas')) > 200, 'the horizontal line is painted');

  say(
    (await page.locator('[data-testid=drawing-style-bar]:not([hidden])').count()) === 1,
    'the floating style bar appears with the new object selected',
  );

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  say(
    (await page.locator('[data-testid=drawing-style-bar]:not([hidden])').count()) === 0,
    'the style bar goes away when nothing is selected',
  );

  say(await clickTheLine(at), 'clicking the line selects it again');

  // --- the style bar edits the object -------------------------------------
  await page.click('[data-testid=drawing-style-bar] button[aria-label=Colour]');
  await page.waitForTimeout(250);
  await page.click('.dsb-pop .dsb-swatch-btn[aria-label="#f2544b"]');
  await page.waitForTimeout(600);
  const red = await page.evaluate(() => {
    const canvas = document.querySelector('.draw-canvas');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 40 && data[i] > 180 && data[i + 1] < 120 && data[i + 2] < 120) count += 1;
    }
    return count;
  });
  say(red > 100, 'the colour chosen on the style bar is what gets painted', `${red} red pixels`);

  // --- double-click opens the object settings ------------------------------
  const line = await paintedBounds(page, '.draw-canvas', { x0: 0.02, x1: 0.06 });
  await page.mouse.dblclick(at(0.06, 0).x, (line.top + line.bottom) / 2);
  await page.waitForTimeout(600);
  say(
    (await page.locator('[data-testid=drawing-properties]').count()) === 1,
    'double-clicking an object opens its settings',
  );
  say(
    ((await page.textContent('[data-testid=drawing-properties] .st-head h3')) ?? '').includes(
      'Horizontal line',
    ),
    'the settings dialog names the tool it is editing',
  );

  // A property the tool declares, edited and seen.
  const priceLabel = page.locator('[data-testid=drawing-properties] .st-row:has-text("Price label") input');
  const hadLabel = await priceLabel.isChecked();
  await priceLabel.click();
  await page.waitForTimeout(500);
  say((await priceLabel.isChecked()) !== hadLabel, 'a generated property control edits the object');
  await priceLabel.click();
  await page.waitForTimeout(300);

  await page.click('[data-testid=drawing-properties] button[aria-label="Close object settings"]');
  await page.waitForTimeout(400);
  say(
    (await page.locator('[data-testid=drawing-properties]').count()) === 0,
    'the settings dialog closes',
  );

  // --- the context menu ----------------------------------------------------
  const forMenu = await paintedBounds(page, '.draw-canvas', { x0: 0.02, x1: 0.06 });
  await page.mouse.click(at(0.06, 0).x, (forMenu.top + forMenu.bottom) / 2, { button: 'right' });
  await page.waitForTimeout(500);
  say(
    (await page.locator('[data-testid=drawing-context-menu]').count()) === 1,
    'right-clicking an object opens its context menu',
  );

  await page.click('[data-testid=drawing-context-menu] .dm-item:has-text("Duplicate")');
  await page.waitForTimeout(700);
  say((await treeRows()) === 2, 'Duplicate from the menu makes a second object');

  // Back to one object, so the next steps can find the line they mean: the
  // copy is offset in price and both would be inside the same painted box.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(700);
  say((await treeRows()) === 1, 'undo takes the duplicate away again');

  // Lock from the object tree, then prove a locked object cannot be dragged.
  await openTree();
  await page.locator('[data-testid=object-tree-row] .ot-btn').nth(1).click();
  await page.waitForTimeout(400);
  await closeTree();
  say(await clickTheLine(at), 'the locked object can still be selected');

  const lockedBefore = await paintedBounds(page, '.draw-canvas', { x0: 0.02, x1: 0.06 });
  await page.mouse.move(at(0.06, 0).x, (lockedBefore.top + lockedBefore.bottom) / 2);
  await page.mouse.down();
  await page.mouse.move(at(0.06, 0).x, (lockedBefore.top + lockedBefore.bottom) / 2 - 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const lockedAfter = await paintedBounds(page, '.draw-canvas', { x0: 0.02, x1: 0.06 });
  // The chart may have panned under it; what must not happen is the object
  // following the pointer 60px up while locked.
  say(
    Math.abs(lockedAfter.top - lockedBefore.top) < 25,
    'a locked object does not move when dragged',
    `${Math.round(lockedBefore.top)} -> ${Math.round(lockedAfter.top)}`,
  );

  // --- the object tree -----------------------------------------------------
  await openTree();
  const rows = page.locator('[data-testid=object-tree-row]');
  say((await rows.count()) === 1, 'the object tree lists the object on this instrument');

  const litBeforeHide = await litPixels(page, '.draw-canvas');
  await rows.first().locator('.ot-btn').first().click();
  await page.waitForTimeout(600);
  const litHidden = await litPixels(page, '.draw-canvas');
  say(litHidden < litBeforeHide, 'hiding from the tree takes it off the chart', `${litBeforeHide} -> ${litHidden}`);

  await rows.first().locator('.ot-btn').first().click();
  await page.waitForTimeout(600);
  const litShown = await litPixels(page, '.draw-canvas');
  say(litShown > litHidden, 'showing it brings it back', `${litHidden} -> ${litShown}`);

  // A regression: the chart's own Escape handler used to swallow the popover's,
  // because a synchronous re-render removed the popover's listener mid-dispatch.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  say(
    (await page.locator('.popover').count()) === 0,
    'Escape closes the object tree even with an object selected',
  );

  // --- fib levels and presets ---------------------------------------------
  await clearDrawings(page);
  await page.click('.rail .rail-btn[aria-label="Fib retracement"]');
  await page.mouse.click(at(0.35, 0.3).x, at(0.35, 0.3).y);
  await page.waitForTimeout(300);
  await page.mouse.click(at(0.6, 0.6).x, at(0.6, 0.6).y);
  await page.waitForTimeout(800);
  const litFib = await litPixels(page, '.draw-canvas');
  say(litFib > 500, 'the fib is painted', `${litFib} lit pixels`);

  await page.click('[data-testid=drawing-style-bar] button[aria-label="Object settings"]');
  await page.waitForTimeout(500);
  say(
    (await page.locator('[data-testid=level-editor]').count()) === 1,
    'the fib settings include a level editor',
  );

  // Templates persist in the workspace, so a previous run's are still here.
  // Cleared first, or the counts below would be counting history.
  for (let guard = 0; guard < 12; guard += 1) {
    const stale = page.locator('[data-testid=drawing-properties] .dp-template-del');
    if ((await stale.count()) === 0) break;
    await stale.first().click();
    await page.waitForTimeout(250);
  }
  say(
    (await page.locator('[data-testid=drawing-properties] .dp-template').count()) === 0,
    'saved templates can be deleted',
  );

  const levelCountBefore = await page.locator('[data-testid=level-editor] .dp-level').count();
  await page.click('[data-testid=level-editor] .dp-preset:has-text("OTE")');
  await page.waitForTimeout(600);
  const values = await page
    .locator('[data-testid=level-editor] .dp-level-value')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.value)));
  say(values.includes(70.5), 'the OTE preset puts 70.5% among the levels', values.join(' '));
  say(values.length !== levelCountBefore || values.includes(62), 'the preset replaced the classic set');

  // Remove a level and see the chart lose a line.
  const litWithOte = await litPixels(page, '.draw-canvas');
  await page.locator('[data-testid=level-editor] .dp-level-del').first().click();
  await page.waitForTimeout(600);
  const litAfterRemove = await litPixels(page, '.draw-canvas');
  say(litAfterRemove < litWithOte, 'removing a level removes its line', `${litWithOte} -> ${litAfterRemove}`);

  // --- templates -----------------------------------------------------------
  await page.fill('[data-testid=drawing-properties] .dp-save-name', 'OTE setup');
  await page.waitForTimeout(200);
  await page.click('[data-testid=drawing-properties] button:has-text("Save template")');
  await page.waitForTimeout(500);
  say(
    (await page.locator('[data-testid=drawing-properties] .dp-template-apply:has-text("OTE setup")').count()) === 1,
    'a template can be saved from the settings dialog',
  );
  say(
    (await page.inputValue('[data-testid=drawing-properties] .dp-save-name')) === '',
    'the name box clears once the template is saved',
  );
  await page.click('[data-testid=drawing-properties] button[aria-label="Close object settings"]');
  await page.waitForTimeout(400);

  // A second fib, then the template applied to it from its context menu.
  await page.click('.rail .rail-btn[aria-label="Fib retracement"]');
  await page.mouse.click(at(0.68, 0.32).x, at(0.68, 0.32).y);
  await page.waitForTimeout(300);
  await page.mouse.click(at(0.82, 0.62).x, at(0.82, 0.62).y);
  await page.waitForTimeout(800);

  await page.click('[data-testid=drawing-style-bar] button[aria-label="Object settings"]');
  await page.waitForTimeout(500);
  const before = await page
    .locator('[data-testid=level-editor] .dp-level-value')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.value)));
  say(!before.includes(70.5), 'the second fib starts from the classic levels', before.join(' '));

  await page.click('[data-testid=drawing-properties] .dp-template-apply:has-text("OTE setup")');
  await page.waitForTimeout(600);
  const after = await page
    .locator('[data-testid=level-editor] .dp-level-value')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.value)));
  say(after.includes(70.5), 'applying the template brings its levels across', after.join(' '));

  await page.click('[data-testid=drawing-properties] .dp-template:has-text("OTE setup") .dp-template-del');
  await page.waitForTimeout(400);
  say(
    (await page.locator('[data-testid=drawing-properties] .dp-template:has-text("OTE setup")').count()) === 0,
    'the template is gone once deleted',
  );
  await page.click('[data-testid=drawing-properties] button[aria-label="Close object settings"]');
  await page.waitForTimeout(400);

  // --- undo and redo from the rail -----------------------------------------
  // From an empty chart, so the step being undone is unambiguous: applying a
  // template can leave MORE pixels than it removed, which would make a pixel
  // count a meaningless assertion.
  await clearDrawings(page);
  await page.click('.rail .rail-btn[aria-label="Trend line"]');
  await page.mouse.click(at(0.35, 0.3).x, at(0.35, 0.3).y);
  await page.waitForTimeout(300);
  await page.mouse.click(at(0.6, 0.55).x, at(0.6, 0.55).y);
  await page.waitForTimeout(800);
  const litOne = await litPixels(page, '.draw-canvas');
  say(litOne > 200, 'one object is on the chart', `${litOne} lit pixels`);

  await page.click('.rail .rail-btn[aria-label=Undo]');
  await page.waitForTimeout(700);
  const litUndone = await litPixels(page, '.draw-canvas');
  say(litUndone === 0, 'undo on the rail takes it away', `${litOne} -> ${litUndone}`);

  await page.click('.rail .rail-btn[aria-label=Redo]');
  await page.waitForTimeout(700);
  const litRedone = await litPixels(page, '.draw-canvas');
  say(litRedone > 200, 'redo on the rail brings it back', `${litRedone} lit pixels`);

  // --- the freeze regression, after every new surface ----------------------
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const probe = at(0.3, 0.4);
  const beforePan = await barUnder(probe.x, probe.y);
  await page.mouse.move(at(0.75, 0.18).x, at(0.75, 0.18).y);
  await page.mouse.down();
  await page.mouse.move(at(0.45, 0.18).x, at(0.75, 0.18).y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const afterPan = await barUnder(probe.x, probe.y);
  say(
    beforePan !== afterPan && beforePan.length > 0,
    'the chart still pans after using the menus, the dialog and the tree',
    `${beforePan} -> ${afterPan}`,
  );

  /*
   * Changing the chart style must not silently kill the drawing engine.
   *
   * It did: rebuilding the price series left the cached projection holding a
   * removed one, which answered null for every price, so an anchor could not
   * be formed and NOTHING could be drawn. The tool still armed, nothing threw,
   * and the same happened after any appearance change structural enough to
   * rebuild the series - which is how a reloaded terminal ended up unable to
   * draw at all.
   */
  await clearDrawings(page);
  await page.click('.chdr-icon[title="Candles"]');
  await page.waitForTimeout(400);
  await page.click('.popover .pop-item:has-text("Bars")');
  await page.waitForTimeout(900);
  await page.click('.rail .rail-btn[aria-label="Horizontal line"]');
  await page.waitForTimeout(250);
  const afterStyle = at(0.45, 0.45);
  await page.mouse.click(afterStyle.x, afterStyle.y);
  await page.waitForTimeout(700);
  say((await litPixels(page)) > 100, 'a drawing still places after the chart style changes');
  await clearDrawings(page);
  await page.click('.chdr-icon[title="Bars"]');
  await page.waitForTimeout(400);
  await page.click('.popover .pop-item:has-text("Candles")');
  await page.waitForTimeout(900);
  await page.click('.rail .rail-btn[aria-label="Horizontal line"]');
  await page.waitForTimeout(250);
  await page.mouse.click(afterStyle.x, afterStyle.y);
  await page.waitForTimeout(700);
  say((await litPixels(page)) > 100, 'and after changing it back');

  await shot(page, 'drawing-engine');
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
