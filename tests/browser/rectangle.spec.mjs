/**
 * The rectangle, behaviour by behaviour.
 *
 * This is the reference tool: the interaction it establishes is the one every
 * other drawing tool is expected to match, so it is checked against all twenty
 * points of the brief rather than "a rectangle appears".
 *
 * Everything is driven the way a trader drives it, and read from what is
 * actually painted - the canvas pixels - rather than from application state.
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

const { say, finish } = createReport('rectangle');
const { browser, page, errors } = await launch({ width: 1600, height: 950 });

/** Alpha values the drawing canvas painted, sampled across a region. */
async function alphaProfile(region) {
  return page.evaluate((region) => {
    const canvas = document.querySelector('.draw-canvas');
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const x0 = Math.floor(width * region.x0);
    const x1 = Math.ceil(width * region.x1);
    const y0 = Math.floor(height * region.y0);
    const y1 = Math.ceil(height * region.y1);
    let painted = 0;
    let opaque = 0;
    let translucent = 0;
    let sum = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha === 0) continue;
        painted += 1;
        sum += alpha;
        if (alpha > 200) opaque += 1;
        else translucent += 1;
      }
    }
    return { painted, opaque, translucent, meanAlpha: painted ? sum / painted : 0 };
  }, region);
}

async function selectedBar() {
  return page.locator('[data-testid=drawing-style-bar]:not([hidden])').count();
}

/**
 * The prices a drawing is anchored to, read from the object tree.
 *
 * This is the view-INDEPENDENT truth: pixels move whenever the chart is
 * panned, zoomed or auto-scaled, so "did the anchors change" cannot be asked
 * of the canvas. The tree prints the anchor prices.
 */
async function anchorPrices() {
  await page.click('.rail .rail-btn[aria-label="Object tree"]');
  await page.waitForTimeout(350);
  const rows = await page.locator('[data-testid=object-tree-row] .ot-detail').allTextContents();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  return rows;
}

try {
  await signIn(page);
  const box = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  await clearDrawings(page);

  // ------------------------------------------------------- 1. creation -----
  await page.click('.rail .rail-btn[aria-label="Rectangle"]');
  say(
    await page
      .locator('.rail .rail-btn[aria-label="Rectangle"]')
      .evaluate((node) => node.classList.contains('rail-btn-on')),
    'picking the tool arms it',
  );

  await page.mouse.click(at(0.3, 0.3).x, at(0.3, 0.3).y);
  await page.mouse.move(at(0.45, 0.45).x, at(0.45, 0.45).y);
  await page.waitForTimeout(250);
  const preview = await litPixels(page, '.draw-canvas');
  say(preview > 100, 'the rectangle previews under the cursor before the second click', `${preview} px`);

  await page.mouse.click(at(0.55, 0.55).x, at(0.55, 0.55).y);
  await page.waitForTimeout(600);
  say((await litPixels(page, '.draw-canvas')) > 300, 'the second click creates it');
  say(
    await page
      .locator('.rail .rail-btn[aria-label=Cursor]')
      .evaluate((node) => node.classList.contains('rail-btn-on')),
    'and the tool returns to the cursor',
  );
  say((await selectedBar()) === 1, 'the new rectangle is selected');

  // --------------------------------------------- 2. price action visible ---
  const inside = await alphaProfile({ x0: 0.36, x1: 0.48, y0: 0.36, y1: 0.48 });
  say(
    inside.painted > 500 && inside.opaque === 0,
    'the fill is genuinely translucent: nothing inside it is opaque',
    `${inside.painted} painted, mean alpha ${Math.round(inside.meanAlpha)}/255`,
  );
  say(
    inside.meanAlpha > 0 && inside.meanAlpha < 45,
    'and it is subtle enough to read candles through',
    `mean alpha ${Math.round(inside.meanAlpha)}/255`,
  );
  await shot(page, 'rectangle-default');

  // ------------------------------------------------------ 3. selection -----
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  say((await selectedBar()) === 0, 'Escape deselects, and the handles go with it');

  const body = await paintedBounds(page, '.draw-canvas');
  const centre = { x: (body.left + body.right) / 2, y: (body.top + body.bottom) / 2 };
  await page.mouse.click(centre.x, centre.y);
  await page.waitForTimeout(400);
  say((await selectedBar()) === 1, 'clicking inside a filled rectangle selects it');

  // -------------------------------------------------------- 4. moving ------
  const before = await paintedBounds(page, '.draw-canvas');
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i += 1) {
    await page.mouse.move(centre.x + i * 3, centre.y + i * 2);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterMove = await paintedBounds(page, '.draw-canvas');
  const movedX = afterMove.left - before.left;
  const movedY = afterMove.top - before.top;
  say(
    movedX > 40 && movedX < 80 && movedY > 25 && movedY < 60,
    'dragging inside moves the whole rectangle with the pointer',
    `moved ${Math.round(movedX)},${Math.round(movedY)} for a 60,40 drag`,
  );
  say(
    Math.abs(afterMove.right - afterMove.left - (before.right - before.left)) < 3 &&
      Math.abs(afterMove.bottom - afterMove.top - (before.bottom - before.top)) < 3,
    'and its size does not change while it moves',
  );

  // ------------------------------------------------------ 5. resizing ------
  const shape = await paintedBounds(page, '.draw-canvas');
  // The top edge midpoint: a price-only handle.
  await page.mouse.move((shape.left + shape.right) / 2, shape.top);
  await page.waitForTimeout(200);
  const edgeCursor = await page.locator('.chart-canvas').evaluate((node) => node.style.cursor);
  say(edgeCursor === 'ns-resize', 'the top edge offers a vertical resize cursor', edgeCursor || 'none');

  await page.mouse.down();
  await page.mouse.move((shape.left + shape.right) / 2, shape.top - 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterEdge = await paintedBounds(page, '.draw-canvas');
  say(
    afterEdge.top < shape.top - 25,
    'dragging the top edge changes price only',
    `top ${Math.round(shape.top)} -> ${Math.round(afterEdge.top)}`,
  );
  say(
    Math.abs(afterEdge.left - shape.left) < 3 && Math.abs(afterEdge.right - shape.right) < 3,
    'and leaves the time span alone',
  );

  // The left edge midpoint: a time-only handle.
  const forTime = await paintedBounds(page, '.draw-canvas');
  await page.mouse.move(forTime.left, (forTime.top + forTime.bottom) / 2);
  await page.waitForTimeout(200);
  const timeCursor = await page.locator('.chart-canvas').evaluate((node) => node.style.cursor);
  say(timeCursor === 'ew-resize', 'the left edge offers a horizontal resize cursor', timeCursor || 'none');

  await page.mouse.down();
  await page.mouse.move(forTime.left - 60, (forTime.top + forTime.bottom) / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterTime = await paintedBounds(page, '.draw-canvas');
  say(
    afterTime.left < forTime.left - 40,
    'dragging the left edge changes time only',
    `left ${Math.round(forTime.left)} -> ${Math.round(afterTime.left)}`,
  );
  say(
    Math.abs(afterTime.top - forTime.top) < 4 && Math.abs(afterTime.bottom - forTime.bottom) < 4,
    'and leaves the price span alone',
  );

  // A corner: both axes.
  const forCorner = await paintedBounds(page, '.draw-canvas');
  await page.mouse.move(forCorner.right, forCorner.bottom);
  await page.waitForTimeout(200);
  const cornerCursor = await page.locator('.chart-canvas').evaluate((node) => node.style.cursor);
  say(/resize/.test(cornerCursor), 'a corner offers a resize cursor', cornerCursor || 'none');
  await page.mouse.down();
  await page.mouse.move(forCorner.right + 50, forCorner.bottom + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterCorner = await paintedBounds(page, '.draw-canvas');
  say(
    afterCorner.right > forCorner.right + 30 && afterCorner.bottom > forCorner.bottom + 20,
    'dragging a corner changes both',
    `${Math.round(forCorner.right)},${Math.round(forCorner.bottom)} -> ${Math.round(
      afterCorner.right,
    )},${Math.round(afterCorner.bottom)}`,
  );

  // ------------------------------------------- 6. anchored to time/price ---
  const pricesBeforePan = await anchorPrices();
  /*
   * Deselected BEFORE measuring.
   *
   * A selected object paints handles, which stick out by the handle radius on
   * every side - so measuring a selected shape and then an unselected one
   * reports a width change of exactly two handles and looks like drift.
   */
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const beforePan = await paintedBounds(page, '.draw-canvas');
  await page.mouse.move(at(0.9, 0.06).x, at(0.9, 0.06).y);
  await page.mouse.down();
  await page.mouse.move(at(0.6, 0.06).x, at(0.9, 0.06).y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const afterPan = await paintedBounds(page, '.draw-canvas');
  say(
    Math.abs(afterPan.left - beforePan.left) > 50,
    'panning carries the rectangle with the bars it was drawn on',
    `left ${Math.round(beforePan.left)} -> ${Math.round(afterPan.left)}`,
  );
  const widthBefore = beforePan.right - beforePan.left;
  const widthAfter = afterPan.right - afterPan.left;
  say(
    Math.abs(widthAfter - widthBefore) <= 3,
    'and a pan does not stretch it',
    `${Math.round(widthBefore)}px -> ${Math.round(widthAfter)}px`,
  );
  // The pixels move; the anchors must not. This is the assertion that matters.
  say(
    JSON.stringify(await anchorPrices()) === JSON.stringify(pricesBeforePan),
    'the anchors are still the same prices after panning',
    (await anchorPrices()).join(' / '),
  );

  // ------------------------------------------------------ 7. settings ------
  const forSettings = await paintedBounds(page, '.draw-canvas');
  await page.mouse.dblclick(
    (forSettings.left + forSettings.right) / 2,
    (forSettings.top + forSettings.bottom) / 2,
  );
  await page.waitForTimeout(600);
  say(
    (await page.locator('[data-testid=drawing-properties]').count()) === 1,
    'double-clicking opens its settings',
  );
  const rows = await page.locator('[data-testid=drawing-properties] .st-row-label').allTextContents();
  for (const wanted of ['Border', 'Thickness', 'Line style', 'Fill', 'Extend left', 'Extend right', 'Text']) {
    say(rows.includes(wanted), `settings offer ${wanted.toLowerCase()}`);
  }

  // Border opacity and fill opacity are separate controls.
  const borderAlpha = page.locator('[data-testid=drawing-properties] input[aria-label="Border opacity"]');
  const fillAlpha = page.locator('[data-testid=drawing-properties] input[aria-label="Fill opacity"]');
  say((await borderAlpha.count()) === 1 && (await fillAlpha.count()) === 1, 'border and fill have their own opacity');

  await fillAlpha.fill('40');
  await page.waitForTimeout(500);
  const heavier = await alphaProfile({ x0: 0.36, x1: 0.44, y0: 0.4, y1: 0.48 });
  say(
    heavier.meanAlpha > inside.meanAlpha,
    'raising fill opacity paints more of it',
    `${Math.round(inside.meanAlpha)} -> ${Math.round(heavier.meanAlpha)}`,
  );
  await fillAlpha.fill('8');
  await page.waitForTimeout(300);

  await page.click('[data-testid=drawing-properties] button[aria-label="Close object settings"]');
  await page.waitForTimeout(400);

  // ---------------------------------------------------- 8. lock and hide ---
  const forMenu = await paintedBounds(page, '.draw-canvas');
  await page.mouse.click(
    (forMenu.left + forMenu.right) / 2,
    (forMenu.top + forMenu.bottom) / 2,
    { button: 'right' },
  );
  await page.waitForTimeout(500);
  say(
    (await page.locator('[data-testid=drawing-context-menu]').count()) === 1,
    'right-click opens the context menu',
  );
  await page.click('[data-testid=drawing-context-menu] .dm-item:has-text("Lock")');
  await page.waitForTimeout(500);

  const pricesBeforeLock = await anchorPrices();
  const locked = await paintedBounds(page, '.draw-canvas');
  await page.mouse.move((locked.left + locked.right) / 2, (locked.top + locked.bottom) / 2);
  await page.mouse.down();
  await page.mouse.move((locked.left + locked.right) / 2 + 60, (locked.top + locked.bottom) / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterLocked = await paintedBounds(page, '.draw-canvas');
  /*
   * Dragging a locked object pans the chart - that is the intended behaviour,
   * and it means the painted position legitimately moves. What must not change
   * is the object: its anchors.
   */
  say(
    JSON.stringify(await anchorPrices()) === JSON.stringify(pricesBeforeLock),
    'dragging a locked rectangle pans the chart and leaves the object alone',
    (await anchorPrices()).join(' / '),
  );

  await page.mouse.click(
    (afterLocked.left + afterLocked.right) / 2,
    (afterLocked.top + afterLocked.bottom) / 2,
    { button: 'right' },
  );
  await page.waitForTimeout(400);
  await page.click('[data-testid=drawing-context-menu] .dm-item:has-text("Unlock")');
  await page.waitForTimeout(400);

  // ------------------------------------------------ 9. copy, paste, undo ---
  const treeCount = async () => {
    await page.click('.rail .rail-btn[aria-label="Object tree"]');
    await page.waitForTimeout(350);
    const rows = await page.locator('[data-testid=object-tree-row]').count();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    return rows;
  };

  const one = await treeCount();
  await page.mouse.click(
    (afterLocked.left + afterLocked.right) / 2,
    (afterLocked.top + afterLocked.bottom) / 2,
  );
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(600);
  say((await treeCount()) === one + 1, 'copy and paste make a second rectangle');

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(600);
  say((await treeCount()) === one, 'undo takes the pasted copy away');

  // ------------------------------------------------- 10. persistence -------
  const pricesBeforeReload = await anchorPrices();
  await page.waitForTimeout(1_200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(6_000);
  const reloaded = await paintedBounds(page, '.draw-canvas');
  say(reloaded !== null, 'it is still on the chart after a reload');
  // Pixels are not the test: a reload scrolls the view back to the newest
  // bars, so the rectangle is somewhere else on screen and on the same prices.
  say(
    JSON.stringify(await anchorPrices()) === JSON.stringify(pricesBeforeReload),
    'and on exactly the prices it was drawn on',
    (await anchorPrices()).join(' / '),
  );

  // ------------------------------------------------------- 11. delete ------
  await page.mouse.click((reloaded.left + reloaded.right) / 2, (reloaded.top + reloaded.bottom) / 2);
  await page.waitForTimeout(400);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  say((await litPixels(page, '.draw-canvas')) === 0, 'Delete removes it');

  await shot(page, 'rectangle-final');
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
