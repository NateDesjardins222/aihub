/**
 * The five tools that were not rebuilt individually: ray, extended line,
 * vertical line, text and measure.
 *
 * The rectangle established the interaction and the trend line, horizontal
 * line and fib were held to it one by one. These five share the same input
 * machine, the same paint routine and the same registry, so what is checked
 * here is that the shared architecture actually reaches them: each one places,
 * selects from its own body, moves, stays anchored through a pan, offers the
 * settings its registry entry declares, and deletes.
 *
 * It is NOT the full twenty-point pass - extensions, per-tool settings and the
 * finer behaviours of each remain owed, and `docs/terminal-quality-report.md`
 * says so.
 */
import { clearDrawings, createReport, launch, litPixels, shot, signIn } from './harness.mjs';

const { say, finish, watch } = createReport('remaining-tools');
const { browser, page, errors } = await launch({ width: 1600, height: 950 });
watch(page);

/** Arm a tool from the full catalogue rather than the rail's favourites. */
async function arm(category, label) {
  await page.click('.rail .rail-btn[aria-label="All drawing tools"]');
  await page.waitForTimeout(350);
  const section = page.locator(`.popover .pop-item:has-text("${category}")`).first();
  const expanded = await section.getAttribute('aria-expanded');
  if (expanded !== 'true') {
    await section.click();
    await page.waitForTimeout(300);
  }
  await page.click(`.popover .rail-tool-item:text-is("${label}")`);
  await page.waitForTimeout(400);
}

const styleBar = () => page.locator('[data-testid=drawing-style-bar]:not([hidden])').count();

/**
 * The painted bounding box, at an alpha a thin glyph can reach.
 *
 * The shared helper counts pixels above 40/255, which a 9px anti-aliased
 * letter never manages - so a text object read through it looks like an empty
 * canvas. This threshold is the same one `litPixels` uses.
 */
async function looseBounds() {
  return page.evaluate(() => {
    const canvas = document.querySelector('.draw-canvas');
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (data[(y * width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (minX === Infinity) return null;
    const ratio = canvas.width / canvas.clientWidth;
    return {
      left: minX / ratio,
      right: maxX / ratio,
      top: minY / ratio,
      bottom: maxY / ratio,
    };
  });
}

async function treeRows() {
  await page.click('.rail .rail-btn[aria-label="Object tree"]');
  await page.waitForTimeout(350);
  const rows = await page.locator('[data-testid=object-tree-row]').count();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  return rows;
}

async function anchorPrices() {
  await page.click('.rail .rail-btn[aria-label="Object tree"]');
  await page.waitForTimeout(350);
  const rows = await page.locator('[data-testid=object-tree-row] .ot-detail').allTextContents();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  return rows.join('|');
}

const settingRows = () =>
  page.locator('[data-testid=drawing-properties] .st-row-label').allTextContents();

try {
  await signIn(page);
  const box = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  /*
   * One tool per entry: where it lives in the catalogue, where to click to
   * place it, where its body is afterwards, and the settings its registry
   * entry promises.
   */
  const TOOLS = [
    {
      name: 'Ray',
      category: 'Lines',
      points: [[0.3, 0.55], [0.5, 0.4]],
      body: [0.4, 0.475],
      settings: ['Colour', 'Thickness', 'Line style', 'Price label'],
      // A ray and an extended line run off the edge of the plot, so their
      // painted box is the canvas and says nothing about where they moved.
      followsPointer: false,
      pricesInTree: true,
    },
    {
      name: 'Extended line',
      category: 'Lines',
      points: [[0.35, 0.6], [0.55, 0.45]],
      body: [0.45, 0.525],
      settings: ['Colour', 'Thickness', 'Line style', 'Price label'],
      followsPointer: false,
      pricesInTree: true,
    },
    {
      name: 'Vertical line',
      category: 'Lines',
      points: [[0.45, 0.5]],
      body: [0.45, 0.3],
      settings: ['Colour', 'Thickness', 'Line style'],
      // A vertical line spans the whole plot, so its painted box only ever
      // moves sideways however far the pointer went.
      followsPointer: 'X',
      pricesInTree: true,
    },
    {
      name: 'Text',
      category: 'Annotation',
      points: [[0.45, 0.45]],
      body: [0.45, 0.45],
      settings: ['Text', 'Colour', 'Text size'],
      followsPointer: true,
      // The object tree shows a text object's CONTENT, not a price, so its
      // anchors cannot be read from there.
      pricesInTree: false,
    },
    {
      name: 'Measure',
      category: 'Measure',
      points: [[0.35, 0.55], [0.5, 0.42]],
      body: [0.425, 0.485],
      settings: ['Colour', 'Thickness', 'Text size'],
      followsPointer: true,
      pricesInTree: true,
    },
  ];

  for (const tool of TOOLS) {
    await clearDrawings(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // --- placement ---------------------------------------------------------
    await arm(tool.category, tool.name);
    for (const [fx, fy] of tool.points) {
      await page.mouse.click(at(fx, fy).x, at(fx, fy).y);
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(500);
    const lit = await litPixels(page, '.draw-canvas');
    say(lit > 20, `${tool.name}: ${tool.points.length} click(s) place it`, `${lit} px`);
    say(
      await page
        .locator('.rail .rail-btn[aria-label=Cursor]')
        .evaluate((node) => node.classList.contains('rail-btn-on')),
      `${tool.name}: the tool returns to the cursor`,
    );
    say((await styleBar()) === 1, `${tool.name}: it is selected when placed`);

    // --- selection ---------------------------------------------------------
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    say((await styleBar()) === 0, `${tool.name}: Escape deselects it`);
    // The pointer goes somewhere harmless first, so the click that follows is
    // a fresh press on the object rather than a continuation of a hover.
    await page.mouse.move(at(0.05, 0.95).x, at(0.05, 0.95).y);
    await page.mouse.click(at(tool.body[0], tool.body[1]).x, at(tool.body[0], tool.body[1]).y);
    await page.waitForTimeout(400);
    say((await styleBar()) === 1, `${tool.name}: clicking its body selects it`);

    // --- moving ------------------------------------------------------------
    const beforeMove = await anchorPrices();
    const boxBefore = await looseBounds();
    const grab = at(tool.body[0], tool.body[1]);
    const DX = 42;
    const DY = 28;
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    for (let i = 1; i <= 14; i += 1) await page.mouse.move(grab.x + i * 3, grab.y + i * 2);
    await page.mouse.up();
    await page.waitForTimeout(600);
    const boxAfter = await looseBounds();
    if (tool.pricesInTree) {
      say(
        (await anchorPrices()) !== beforeMove,
        `${tool.name}: dragging its body moves its anchors`,
        `${beforeMove} -> ${await anchorPrices()}`,
      );
    }
    if (tool.followsPointer) {
      const dx = boxAfter.left - boxBefore.left;
      const dy = boxAfter.top - boxBefore.top;
      const axis = tool.followsPointer === 'X';
      say(
        Math.abs(dx - DX) <= 6 && (axis || Math.abs(dy - DY) <= 6),
        `${tool.name}: and it follows the pointer exactly`,
        axis
          ? `moved ${Math.round(dx)}px sideways for a ${DX}px drag`
          : `moved ${Math.round(dx)},${Math.round(dy)} for a ${DX},${DY} drag`,
      );
    }

    // --- settings, while the object is at a known place ---------------------
    const settingsAt = { x: grab.x + DX, y: grab.y + DY };
    await page.mouse.dblclick(settingsAt.x, settingsAt.y);
    await page.waitForTimeout(600);
    const opened = (await page.locator('[data-testid=drawing-properties]').count()) === 1;
    say(opened, `${tool.name}: double-clicking opens its settings`);
    if (opened) {
      const rows = await settingRows();
      const missing = tool.settings.filter((row) => !rows.includes(row));
      say(
        missing.length === 0,
        `${tool.name}: its settings are the ones its registry entry declares`,
        rows.join(' / '),
      );
      await page.click('[data-testid=drawing-properties] button[aria-label="Close object settings"]');
      await page.waitForTimeout(400);
    }

    // --- anchored to time and price ---------------------------------------
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const beforePan = await anchorPrices();
    const beforePanBox = await looseBounds();
    /*
     * Panned BACKWARDS, into history.
     *
     * Forwards, the chart runs out of bars: by the fifth tool the view is
     * already at the newest bar and a forward pan moves it only as far as the
     * blank right margin allows, which is a fact about the chart's limits and
     * not about the drawing. There is always history to the left.
     */
    const panFrom = at(0.45, 0.04);
    const panTo = at(0.75, 0.04);
    await page.mouse.move(panFrom.x, panFrom.y);
    await page.mouse.down();
    await page.mouse.move(panTo.x, panTo.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    const afterPanBox = await looseBounds();
    if (tool.pricesInTree) {
      say(
        (await anchorPrices()) === beforePan,
        `${tool.name}: a pan does not move its anchors`,
        beforePan,
      );
    } else {
      // A text object shows its content rather than a price in the tree, so
      // what is checked for it is that the pan did not consume the object.
      say((await treeRows()) === 1, `${tool.name}: a pan does not remove it`);
    }
    if (tool.followsPointer && afterPanBox) {
      /*
       * Carried with its bars: the object moves left with the chart rather
       * than staying put on screen. Read on whichever edge is still inside the
       * plot - a wide object's left edge clips at zero, which would read as no
       * travel at all.
       *
       * Only checked when the object is still painted. A pan brings different
       * bars into view and the price scale follows them, so an object anchored
       * to a price the new view does not cover is legitimately off screen;
       * that it still EXISTS is what the anchor checks above establish.
       */
      const shift = Math.max(
        afterPanBox.left - beforePanBox.left,
        afterPanBox.right - beforePanBox.right,
      );
      say(
        shift > 100,
        `${tool.name}: and it travelled with the bars it was drawn on`,
        `${Math.round(shift)}px right for a ${Math.round(panTo.x - panFrom.x)}px pan`,
      );
    }

    // --- delete ------------------------------------------------------------
    // Selected from the object tree, because the pan has moved it and where it
    // is now is not what this check is about.
    await page.click('.rail .rail-btn[aria-label="Object tree"]');
    await page.waitForTimeout(350);
    await page.click('[data-testid=object-tree-row] .ot-name');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(500);
    say((await litPixels(page, '.draw-canvas')) === 0, `${tool.name}: Delete removes it`);
  }

  await shot(page, 'remaining-tools-final');
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
