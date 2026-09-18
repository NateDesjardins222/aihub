/**
 * The trend line, the horizontal line and the Fibonacci retracement.
 *
 * The rectangle established the interaction; this suite is where the other
 * three tools of the brief are held to the same standard. The checks are the
 * rectangle's, tool by tool: create, select, move, reshape, stay anchored
 * through a pan, settle in settings, persist, delete - plus what is particular
 * to each tool, which for the fib is its levels.
 *
 * Read from PIXELS and from the object tree rather than from application
 * state: what a trader sees is the thing under test.
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

const { say, finish, watch } = createReport('line-tools');
const { browser, page, errors } = await launch({ width: 1600, height: 950 });
watch(page);

/**
 * The horizontal lines the canvas painted, in canvas rows.
 *
 * A fib level is a full-width rule, so a row that is painted nearly all the
 * way across a column strip IS a level. Rows within two pixels of each other
 * are one line: a 1px stroke lands on two rows once it is anti-aliased.
 */
async function paintedRows(x0 = 0.35, x1 = 0.6) {
  return page.evaluate(
    ({ x0, x1 }) => {
      const canvas = document.querySelector('.draw-canvas');
      const ctx = canvas.getContext('2d');
      const { width, height } = canvas;
      const data = ctx.getImageData(0, 0, width, height).data;
      const from = Math.floor(width * x0);
      const to = Math.ceil(width * x1);
      const span = to - from;
      const rows = [];
      for (let y = 0; y < height; y += 1) {
        let painted = 0;
        let sum = 0;
        for (let x = from; x < to; x += 1) {
          const alpha = data[(y * width + x) * 4 + 3];
          if (alpha > 8) {
            painted += 1;
            sum += alpha;
          }
        }
        if (painted > span * 0.7) rows.push({ y, alpha: sum / painted });
      }
      const merged = [];
      for (const row of rows) {
        const last = merged[merged.length - 1];
        if (last && row.y - last.y <= 2) {
          last.alpha = Math.max(last.alpha, row.alpha);
          continue;
        }
        merged.push({ ...row });
      }
      return merged;
    },
    { x0, x1 },
  );
}

/** Painted pixels in a region, as a fraction of it. */
async function coverage(region) {
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
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if (data[(y * width + x) * 4 + 3] > 4) painted += 1;
      }
    }
    return painted / Math.max(1, (x1 - x0) * (y1 - y0));
  }, region);
}

const styleBar = () => page.locator('[data-testid=drawing-style-bar]:not([hidden])').count();

/** The anchor prices, from the object tree: the view-independent truth. */
async function anchorPrices() {
  await page.click('.rail .rail-btn[aria-label="Object tree"]');
  await page.waitForTimeout(350);
  const rows = await page.locator('[data-testid=object-tree-row] .ot-detail').allTextContents();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  return rows;
}

async function treeRows() {
  await page.click('.rail .rail-btn[aria-label="Object tree"]');
  await page.waitForTimeout(350);
  const rows = await page.locator('[data-testid=object-tree-row]').count();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  return rows;
}

/**
 * Double-click where an object is, and say whether its settings opened.
 *
 * `find` is re-read between attempts because the price scale is LIVE: the
 * market moves, the scale rescales, and an object's pixel position a second
 * ago is not where it is now. A double-click six pixels off hits nothing, and
 * that is the test being wrong rather than the terminal.
 */
async function openSettings(x, y, find = null) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const point = attempt === 0 || !find ? { x, y } : await find();
    if (!point) break;
    await page.mouse.dblclick(point.x, point.y);
    await page.waitForTimeout(600);
    const open = await page.locator('[data-testid=drawing-properties]').count();
    if (open === 1) return 1;
    await page.waitForTimeout(400);
  }
  return page.locator('[data-testid=drawing-properties]').count();
}

const closeSettings = async () => {
  await page.click('[data-testid=drawing-properties] button[aria-label="Close object settings"]');
  await page.waitForTimeout(400);
};

const settingRows = () =>
  page.locator('[data-testid=drawing-properties] .st-row-label').allTextContents();

try {
  await signIn(page);
  const box = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  await clearDrawings(page);

  // ======================================================== TREND LINE =====
  await page.click('.rail .rail-btn[aria-label="Trend line"]');
  const first = at(0.3, 0.6);
  const second = at(0.55, 0.35);
  await page.mouse.click(first.x, first.y);
  await page.mouse.move(second.x, second.y);
  await page.waitForTimeout(250);
  say((await litPixels(page, '.draw-canvas')) > 50, 'a trend line previews before the second click');
  await page.mouse.click(second.x, second.y);
  await page.waitForTimeout(600);
  say((await litPixels(page, '.draw-canvas')) > 100, 'the second click creates it');
  say(
    await page
      .locator('.rail .rail-btn[aria-label=Cursor]')
      .evaluate((node) => node.classList.contains('rail-btn-on')),
    'and the tool returns to the cursor',
  );
  say((await styleBar()) === 1, 'the new line is selected');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  say((await styleBar()) === 0, 'Escape deselects it');

  // Selecting a THIN object: the midpoint of the segment, which is where a
  // trader aims. A tool that can only be selected by its handles is broken.
  const mid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  await page.mouse.click(mid.x, mid.y);
  await page.waitForTimeout(400);
  say((await styleBar()) === 1, 'clicking the line itself selects it');

  // Move the whole line.
  const beforeMove = await paintedBounds(page, '.draw-canvas');
  const pricesBeforeMove = await anchorPrices();
  await page.mouse.click(mid.x, mid.y);
  await page.waitForTimeout(250);
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  for (let i = 1; i <= 16; i += 1) await page.mouse.move(mid.x + i * 3, mid.y + i * 2);
  await page.mouse.up();
  await page.waitForTimeout(600);
  const afterMove = await paintedBounds(page, '.draw-canvas');
  say(
    afterMove.left - beforeMove.left > 30 && afterMove.top - beforeMove.top > 15,
    'dragging the line moves the whole object',
    `${Math.round(afterMove.left - beforeMove.left)},${Math.round(afterMove.top - beforeMove.top)} for 48,32`,
  );
  say(
    Math.abs(
      afterMove.right - afterMove.left - (beforeMove.right - beforeMove.left),
    ) <= 4,
    'and does not change its slope or length',
  );
  say(
    JSON.stringify(await anchorPrices()) !== JSON.stringify(pricesBeforeMove),
    'the move is a real change to both anchors',
    (await anchorPrices()).join(' / '),
  );

  // Drag ONE end: the other must stay exactly where it was.
  const shape = await paintedBounds(page, '.draw-canvas');
  const endBefore = await anchorPrices();
  await page.mouse.move(shape.right, shape.top);
  await page.waitForTimeout(200);
  await page.mouse.down();
  await page.mouse.move(shape.right + 60, shape.top - 50, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const endAfter = await anchorPrices();
  say(endBefore[0] !== endAfter[0], 'dragging an end reshapes the line', `${endBefore[0]} -> ${endAfter[0]}`);

  // Zero drift: pan, and the anchors must be untouched.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const pricesBeforePan = await anchorPrices();
  const beforePan = await paintedBounds(page, '.draw-canvas');
  await page.mouse.move(at(0.92, 0.04).x, at(0.92, 0.04).y);
  await page.mouse.down();
  await page.mouse.move(at(0.62, 0.04).x, at(0.92, 0.04).y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const afterPan = await paintedBounds(page, '.draw-canvas');
  say(
    Math.abs(afterPan.left - beforePan.left) > 40,
    'panning carries the line with its bars',
    `left ${Math.round(beforePan.left)} -> ${Math.round(afterPan.left)}`,
  );
  say(
    JSON.stringify(await anchorPrices()) === JSON.stringify(pricesBeforePan),
    'and the anchors do not drift',
    (await anchorPrices()).join(' / '),
  );

  // Settings, including the extensions this tool now has.
  const forSettings = await paintedBounds(page, '.draw-canvas');
  const centre = {
    x: (forSettings.left + forSettings.right) / 2,
    y: (forSettings.top + forSettings.bottom) / 2,
  };
  say((await openSettings(centre.x, centre.y)) === 1, 'double-clicking the line opens its settings');
  const trendRows = await settingRows();
  for (const wanted of ['Colour', 'Thickness', 'Line style', 'Extend left', 'Extend right', 'Text', 'Price label']) {
    say(trendRows.includes(wanted), `trend line settings offer ${wanted.toLowerCase()}`);
  }

  /*
   * Measured with the settings already open, so the line is selected in both
   * readings: a selected object paints handles, which stick out by the handle
   * radius on each side and would read as 8px of drift.
   */
  const selectedBounds = await paintedBounds(page, '.draw-canvas');
  const widthBefore = selectedBounds.right - selectedBounds.left;
  await page.click('[data-testid=drawing-properties] input[aria-label="Extend right"]');
  await page.waitForTimeout(500);
  const extended = await paintedBounds(page, '.draw-canvas');
  say(
    extended.right - extended.left > widthBefore + 60,
    'extending right runs the line to the edge of the plot',
    `${Math.round(widthBefore)}px -> ${Math.round(extended.right - extended.left)}px`,
  );
  await page.click('[data-testid=drawing-properties] input[aria-label="Extend right"]');
  await page.waitForTimeout(500);
  const unextended = await paintedBounds(page, '.draw-canvas');
  say(
    Math.abs(unextended.right - unextended.left - widthBefore) <= 6,
    'and turning it off puts the line back exactly where it was',
    `${Math.round(unextended.right - unextended.left)}px vs ${Math.round(widthBefore)}px`,
  );
  await closeSettings();
  await shot(page, 'line-tools-trend');

  await page.mouse.click(centre.x, centre.y);
  await page.waitForTimeout(300);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  say((await litPixels(page, '.draw-canvas')) === 0, 'Delete removes the trend line');

  // =================================================== HORIZONTAL LINE =====
  await page.click('.rail .rail-btn[aria-label="Horizontal line"]');
  const level = at(0.5, 0.45);
  await page.mouse.click(level.x, level.y);
  await page.waitForTimeout(600);
  say((await litPixels(page, '.draw-canvas')) > 100, 'one click places a horizontal line');
  say((await styleBar()) === 1, 'and it is selected');

  const rule = await paintedBounds(page, '.draw-canvas');
  say(
    rule.right - rule.left > box.width * 0.9,
    'it spans the plot',
    `${Math.round(rule.right - rule.left)}px of ${Math.round(box.width)}px`,
  );

  /*
   * The line's OWN row, read on the left of the plot where nothing else is
   * painted. The whole-canvas bounds include the price chip, which is thirteen
   * pixels tall, so they are six pixels off the line itself - enough to miss a
   * one-pixel object when clicking it.
   */
  const ruleOnly = await paintedBounds(page, '.draw-canvas', { x0: 0.08, x1: 0.28 });
  const ruleY = (ruleOnly.top + ruleOnly.bottom) / 2;

  // The price chip: the height of a label rather than of a panel, and against
  // the price scale. The overlay itself is already inset by the axis, so the
  // chip is measured against the OVERLAY's right edge.
  const overlay = await page.locator('.draw-canvas').boundingBox();
  const tag = await paintedBounds(page, '.draw-canvas', { x0: 0.9, x1: 1 });
  say(
    tag !== null && tag.bottom - tag.top <= 16,
    'its price label is a compact chip, not an oversized box',
    tag ? `${Math.round(tag.bottom - tag.top)}px tall` : 'none',
  );
  say(
    tag !== null && overlay.x + overlay.width - tag.right < 12,
    'and it sits against the price scale',
    tag ? `${Math.round(overlay.x + overlay.width - tag.right)}px from the axis` : 'none',
  );

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await page.mouse.click(at(0.4, 0.45).x, ruleY);
  await page.waitForTimeout(400);
  say((await styleBar()) === 1, 'clicking anywhere along it selects it');

  const priceBeforeDrag = await anchorPrices();
  await page.mouse.move(at(0.4, 0.45).x, ruleY);
  await page.mouse.down();
  await page.mouse.move(at(0.4, 0.45).x, ruleY - 70, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const priceAfterDrag = await anchorPrices();
  const movedRule = await paintedBounds(page, '.draw-canvas', { x0: 0.08, x1: 0.28 });
  say(
    priceBeforeDrag[0] !== priceAfterDrag[0] && movedRule.top < ruleY - 50,
    'dragging it changes its price',
    `${priceBeforeDrag[0]} -> ${priceAfterDrag[0]}`,
  );
  const movedWhole = await paintedBounds(page, '.draw-canvas');
  say(
    movedWhole.right - movedWhole.left > box.width * 0.9,
    'and it is still a full-width rule afterwards',
    `${Math.round(movedWhole.right - movedWhole.left)}px`,
  );

  // A horizontal pan must not change a price.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await page.mouse.move(at(0.92, 0.04).x, at(0.92, 0.04).y);
  await page.mouse.down();
  await page.mouse.move(at(0.65, 0.04).x, at(0.92, 0.04).y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  say(
    JSON.stringify(await anchorPrices()) === JSON.stringify(priceAfterDrag),
    'panning leaves its price exactly where it was',
    (await anchorPrices()).join(' / '),
  );

  const whereIsTheRule = async () => {
    const box = await paintedBounds(page, '.draw-canvas', { x0: 0.08, x1: 0.28 });
    return box ? { x: at(0.45, 0.45).x, y: (box.top + box.bottom) / 2 } : null;
  };
  const rulePoint = await whereIsTheRule();
  say(
    (await openSettings(rulePoint.x, rulePoint.y, whereIsTheRule)) === 1,
    'double-clicking opens its settings',
  );
  const hlRows = await settingRows();
  for (const wanted of ['Colour', 'Thickness', 'Line style', 'Price label']) {
    say(hlRows.includes(wanted), `horizontal line settings offer ${wanted.toLowerCase()}`);
  }
  // The rule itself crosses the strip the chip sits in, so the check is the
  // DROP when the chip goes rather than an empty strip.
  const chipOn = await coverage({ x0: 0.93, x1: 1, y0: 0, y1: 1 });
  await page.click('[data-testid=drawing-properties] input[aria-label="Price label"]');
  await page.waitForTimeout(500);
  const chipOff = await coverage({ x0: 0.93, x1: 1, y0: 0, y1: 1 });
  say(
    chipOff < chipOn / 2,
    'turning the price label off removes the chip',
    `${chipOn.toFixed(4)} -> ${chipOff.toFixed(4)}`,
  );
  await page.click('[data-testid=drawing-properties] input[aria-label="Price label"]');
  await page.waitForTimeout(400);
  await closeSettings();
  await shot(page, 'line-tools-horizontal');

  const stillThere = await whereIsTheRule();
  await page.mouse.click(stillThere?.x ?? at(0.45, 0.45).x, stillThere?.y ?? at(0.45, 0.45).y);
  await page.waitForTimeout(300);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  say((await litPixels(page, '.draw-canvas')) === 0, 'Delete removes the horizontal line');

  // ==================================================== FIB RETRACEMENT ====
  await page.click('.rail .rail-btn[aria-label="Fib retracement"]');
  const low = at(0.35, 0.62);
  const high = at(0.6, 0.3);
  await page.mouse.click(low.x, low.y);
  await page.mouse.move(high.x, high.y);
  await page.waitForTimeout(250);
  say((await litPixels(page, '.draw-canvas')) > 200, 'the fib previews between the two clicks');
  await page.mouse.click(high.x, high.y);
  await page.waitForTimeout(700);

  const levels = await paintedRows(0.4, 0.55);
  say(
    levels.length >= 6,
    'it paints the classic set of levels',
    `${levels.length} level lines`,
  );
  say((await styleBar()) === 1, 'and the new fib is selected');
  await shot(page, 'line-tools-fib');

  // The levels editor: add, remove, recolour, hide, name, fade.
  const fibBox = await paintedBounds(page, '.draw-canvas');
  const fibMid = { x: (fibBox.left + fibBox.right) / 2, y: (fibBox.top + fibBox.bottom) / 2 };
  say((await openSettings(fibMid.x, fibMid.y)) === 1, 'double-clicking the fib opens its settings');
  const fibRows = await settingRows();
  for (const wanted of ['Reverse', 'Show levels', 'Show prices', 'Shade between levels', 'Extend left', 'Extend right']) {
    say(fibRows.includes(wanted), `fib settings offer ${wanted.toLowerCase()}`);
  }
  const groups = await page
    .locator('[data-testid=drawing-properties] .st-group-title')
    .allTextContents();
  say(groups.includes('Levels'), 'and the levels have a section of their own', groups.join(' / '));

  const editor = page.locator('[data-testid=level-editor]');
  const levelRow = editor.locator('.dp-level');
  const rowsBefore = await levelRow.count();
  say(rowsBefore >= 7, 'every level is editable on its own row', `${rowsBefore} rows`);
  say(
    (await editor.locator('input[type=color]').count()) === rowsBefore &&
      (await editor.locator('.dp-level-alpha').count()) === rowsBefore &&
      (await editor.locator('.dp-level-label').count()) === rowsBefore,
    'each row carries its own colour, opacity and name',
  );

  await editor.locator('.dp-level-add').click();
  await page.waitForTimeout(400);
  say((await levelRow.count()) === rowsBefore + 1, 'a level can be added');
  await levelRow.last().locator('.dp-level-del').click();
  await page.waitForTimeout(400);
  say((await levelRow.count()) === rowsBefore, 'and removed again');

  // Hiding a level takes exactly one line off the chart.
  const painted = (await paintedRows(0.42, 0.55)).length;
  await levelRow.nth(3).locator('input[type=checkbox]').uncheck();
  await page.waitForTimeout(500);
  const hidden = (await paintedRows(0.42, 0.55)).length;
  say(hidden === painted - 1, 'hiding a level removes its line only', `${painted} -> ${hidden}`);
  await levelRow.nth(3).locator('input[type=checkbox]').check();
  await page.waitForTimeout(500);

  // A level's own opacity fades its own line and nothing else.
  const alphaBefore = (await paintedRows(0.42, 0.55)).map((row) => Math.round(row.alpha));
  await levelRow.nth(3).locator('.dp-level-alpha').fill('0.15');
  await page.waitForTimeout(500);
  const alphaAfter = (await paintedRows(0.42, 0.55)).map((row) => Math.round(row.alpha));
  const faded = alphaBefore.filter((value, i) => alphaAfter[i] < value - 20).length;
  say(
    faded === 1,
    'lowering one level’s opacity fades that line alone',
    `${alphaBefore.join(',')} -> ${alphaAfter.join(',')}`,
  );
  await levelRow.nth(3).locator('.dp-level-alpha').fill('1');
  await page.waitForTimeout(400);

  // A name instead of a percentage.
  await levelRow.nth(3).locator('.dp-level-label').fill('OTE');
  await page.waitForTimeout(400);
  say(
    (await levelRow.nth(3).locator('.dp-level-label').inputValue()) === 'OTE',
    'a level can be given a name of its own',
  );

  /*
   * Reverse: the same two anchors, the levels the other way up.
   *
   * Checked against an ASYMMETRIC set, because the classic one is very nearly
   * symmetric - reversing it moves two lines by a few pixels, which a test
   * could pass while the option did nothing much. One level is moved to 10%
   * first, so reversing has to put it at 90% of the range instead.
   */
  await levelRow.nth(1).locator('.dp-level-value').fill('10');
  await page.waitForTimeout(500);
  const spread = async () => {
    const ys = (await paintedRows(0.42, 0.55)).map((row) => row.y);
    const top = Math.min(...ys);
    const span = Math.max(...ys) - top;
    return ys.map((y) => Number(((y - top) / span).toFixed(3))).sort((a, b) => a - b);
  };
  const before = await spread();
  await page.click('[data-testid=drawing-properties] input[aria-label=Reverse]');
  await page.waitForTimeout(600);
  const after = await spread();
  const shift = Math.max(...before.map((value, i) => Math.abs(value - (after[i] ?? value))));
  say(
    before.length === after.length && shift > 0.08,
    'reversing swaps which anchor counts as zero',
    `${before.join(' ')} -> ${after.join(' ')}`,
  );
  await page.click('[data-testid=drawing-properties] input[aria-label=Reverse]');
  await page.waitForTimeout(500);
  await levelRow.nth(1).locator('.dp-level-value').fill('23.6');
  await page.waitForTimeout(400);

  // Shading: bands between the levels, and light enough to read through.
  const bareBand = await coverage({ x0: 0.45, x1: 0.52, y0: 0.35, y1: 0.55 });
  await page.click('[data-testid=drawing-properties] input[aria-label="Shade between levels"]');
  await page.waitForTimeout(600);
  const shadedBand = await coverage({ x0: 0.45, x1: 0.52, y0: 0.35, y1: 0.55 });
  say(shadedBand > bareBand + 0.3, 'shading fills the bands between levels', `${bareBand.toFixed(2)} -> ${shadedBand.toFixed(2)}`);
  await page.click('[data-testid=drawing-properties] input[aria-label="Shade between levels"]');
  await page.waitForTimeout(500);

  // Extensions.
  const fibWidth = (await paintedBounds(page, '.draw-canvas')).right;
  await page.click('[data-testid=drawing-properties] input[aria-label="Extend right"]');
  await page.waitForTimeout(600);
  const fibExtended = (await paintedBounds(page, '.draw-canvas')).right;
  say(fibExtended > fibWidth + 60, 'the levels can be extended to the right', `${Math.round(fibWidth)} -> ${Math.round(fibExtended)}`);
  await page.click('[data-testid=drawing-properties] input[aria-label="Extend right"]');
  await page.waitForTimeout(500);

  // Save as default, and as a template: a set of levels worth having is worth
  // keeping.
  say(
    (await page.locator('[data-testid=drawing-properties] button:has-text("Use as default for this tool")').count()) === 1 &&
      (await page.locator('[data-testid=drawing-properties] button:has-text("Save template")').count()) === 1,
    'the settings can be saved as the default and as a template',
  );
  await closeSettings();

  // Anchored, like everything else.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const fibPricesBefore = await anchorPrices();
  await page.mouse.move(at(0.92, 0.04).x, at(0.92, 0.04).y);
  await page.mouse.down();
  await page.mouse.move(at(0.68, 0.04).x, at(0.92, 0.04).y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  say(
    JSON.stringify(await anchorPrices()) === JSON.stringify(fibPricesBefore),
    'the fib’s anchors do not drift when the chart is panned',
    (await anchorPrices()).join(' / '),
  );

  // Copy, paste, undo - the same keys as everywhere else.
  const fibNow = await paintedBounds(page, '.draw-canvas');
  await page.mouse.click((fibNow.left + fibNow.right) / 2, (fibNow.top + fibNow.bottom) / 2);
  await page.waitForTimeout(350);
  const oneFib = await treeRows();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(700);
  say((await treeRows()) === oneFib + 1, 'copy and paste make a second fib');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(700);
  say((await treeRows()) === oneFib, 'undo takes it away again');

  // Persistence, by anchor price rather than by pixel.
  const beforeReload = await anchorPrices();
  // The debounced save plus its round trip, for the same reason as above.
  await page.waitForTimeout(3_000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(6_000);
  // Give the stored drawings a chance to arrive: they are fetched after the
  // page renders, so an empty tree a moment after a reload means "not yet".
  let afterReload = await anchorPrices();
  for (let i = 0; i < 6 && afterReload.length === 0; i += 1) {
    await page.waitForTimeout(1_000);
    afterReload = await anchorPrices();
  }
  say(
    JSON.stringify(afterReload) === JSON.stringify(beforeReload),
    'the fib comes back on the prices it was drawn on',
    `${beforeReload.join(' / ') || '(none)'} -> ${afterReload.join(' / ') || '(none)'}`,
  );
  /*
   * A reload scrolls the view back to the newest bars, so the fib is off to
   * the left and may be only a sliver wide. Zooming out brings it back into
   * the plot; then the rows are read across the middle of wherever it is.
   */
  const canvasBox = await page.locator('.draw-canvas').boundingBox();
  const fx = (x) => Math.min(1, Math.max(0, (x - canvasBox.x) / canvasBox.width));
  await page.mouse.move(at(0.6, 0.5).x, at(0.6, 0.5).y);
  let reloadedFib = await paintedBounds(page, '.draw-canvas');
  /*
   * Zoom out until the object is back in view.
   *
   * The terminal opens on the recent session rather than on every bar it has
   * loaded, so an object drawn earlier in the run can be a long way off the
   * left edge after a reload - it is still on its own prices, which is what
   * the check above just proved. Twelve steps was enough when the chart opened
   * on twelve hundred bars; it is not enough now.
   */
  for (let i = 0; i < 40 && (!reloadedFib || reloadedFib.right - reloadedFib.left < 80); i += 1) {
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(200);
    reloadedFib = await paintedBounds(page, '.draw-canvas');
  }
  const rowsAfterReload =
    reloadedFib && reloadedFib.right - reloadedFib.left >= 80
      ? await paintedRows(fx(reloadedFib.left) + 0.015, fx(reloadedFib.right) - 0.015)
      : [];
  say(
    rowsAfterReload.length >= 6,
    'with its levels',
    `${rowsAfterReload.length} level lines across ${
      reloadedFib ? Math.round(reloadedFib.right - reloadedFib.left) : 0
    }px`,
  );

  await clearDrawings(page);
  say((await litPixels(page, '.draw-canvas')) === 0, 'and the chart can be cleared');

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
