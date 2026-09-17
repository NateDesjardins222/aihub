/**
 * The Fibonacci level editor, item by item.
 *
 * The brief asked for a level editor a trader can actually live in: any level
 * they type, per-level colour, opacity, THICKNESS and LINE STYLE, labels on
 * either side, shading with its own opacity, and unusual custom sets. The
 * colour, opacity, naming and visibility checks live in `line-tools`; this
 * suite covers the ones added after it, and it reads the CANVAS, because a
 * setting that does not change what is painted has not been implemented.
 */
import { clearDrawings, createReport, launch, litPixels, paintedBounds, shot, signIn } from './harness.mjs';

const { say, finish } = createReport('fib-levels');
const { browser, page, errors } = await launch({ width: 1600, height: 950 });

/** Lit pixels, and their mean alpha, inside a fraction of the drawing canvas. */
function ink(page, x0, x1) {
  return page.evaluate(
    ({ x0, x1 }) => {
      const canvas = document.querySelector('.draw-canvas');
      const ctx = canvas?.getContext('2d');
      if (!ctx || !canvas) return { lit: 0, mean: 0, opaque: 0 };
      const from = Math.floor(canvas.width * x0);
      const to = Math.ceil(canvas.width * x1);
      const data = ctx.getImageData(from, 0, Math.max(1, to - from), canvas.height).data;
      let lit = 0;
      let total = 0;
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) {
        total += data[i];
        if (data[i] > 20) lit += 1;
        if (data[i] > 250) opaque += 1;
      }
      return { lit, mean: total / (data.length / 4), opaque };
    },
    { x0, x1 },
  );
}

async function openSettings() {
  await page.click('.rail .rail-btn[aria-label="Object tree"]');
  await page.waitForTimeout(400);
  await page.locator('[data-testid=object-tree-row] .ot-name').first().dblclick();
  await page.waitForTimeout(600);
}

async function closeSettings() {
  await page.click('[data-testid=drawing-properties] button[aria-label="Close object settings"]');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

async function setNumber(label, value) {
  const input = page
    .locator(`[data-testid=drawing-properties] .st-row:has(.st-row-label:text-is("${label}")) input[type=number]`)
    .first();
  await input.fill(String(value));
  await input.dispatchEvent('change');
  await page.waitForTimeout(400);
}

try {
  await signIn(page);
  await page.waitForTimeout(4_000);
  await clearDrawings(page);

  const canvas = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: canvas.x + canvas.width * fx, y: canvas.y + canvas.height * fy });

  // --- a fib across the middle of the plot --------------------------------
  await page.click('.rail .rail-btn[aria-label="All drawing tools"]');
  await page.waitForTimeout(400);
  if ((await page.locator('.popover .rail-tool-item:has-text("Fib retracement")').count()) === 0) {
    await page.click('.popover .pop-item:has-text("Fibonacci")');
    await page.waitForTimeout(300);
  }
  await page.click('.popover .rail-tool-item:has-text("Fib retracement")');
  await page.waitForTimeout(400);
  await page.mouse.click(at(0.28, 0.62).x, at(0.28, 0.62).y);
  await page.mouse.move(at(0.62, 0.24).x, at(0.62, 0.24).y, { steps: 6 });
  await page.mouse.click(at(0.62, 0.24).x, at(0.62, 0.24).y);
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  const box = await paintedBounds(page, '.draw-canvas');
  say(box !== null && box.right - box.left > 200, 'a fib is painted across the plot');
  const fx = (x) => Math.min(1, Math.max(0, (x - canvas.x) / canvas.width));
  const leftThird = [fx(box.left), fx(box.left + (box.right - box.left) * 0.33)];
  const rightThird = [fx(box.right - (box.right - box.left) * 0.33), fx(box.right)];

  // --- labels on either side ----------------------------------------------
  const leftInk = await ink(page, leftThird[0], leftThird[1]);
  const rightInk = await ink(page, rightThird[0], rightThird[1]);
  say(
    leftInk.lit > rightInk.lit,
    'the labels default to the left of the object',
    `${leftInk.lit} lit pixels left, ${rightInk.lit} right`,
  );

  await openSettings();
  const labelRow = page.locator(
    '[data-testid=drawing-properties] .st-row:has(.st-row-label:text-is("Labels"))',
  );
  say((await labelRow.count()) === 1, 'the settings offer which side the labels go on');
  await labelRow.locator('.st-choice-btn:text-is("Right")').click();
  await page.waitForTimeout(500);
  await closeSettings();

  const leftAfter = await ink(page, leftThird[0], leftThird[1]);
  const rightAfter = await ink(page, rightThird[0], rightThird[1]);
  say(
    rightAfter.lit > leftAfter.lit,
    'and moving them right actually moves the painted labels',
    `${leftAfter.lit} lit pixels left, ${rightAfter.lit} right`,
  );

  // --- shading, with its own opacity --------------------------------------
  const plain = await ink(page, leftThird[0], rightThird[1]);
  await openSettings();
  await page
    .locator(
      '[data-testid=drawing-properties] .st-row:has(.st-row-label:text-is("Shade between levels")) input[type=checkbox]',
    )
    .first()
    .check();
  await page.waitForTimeout(500);
  await closeSettings();
  const shaded = await ink(page, leftThird[0], rightThird[1]);
  say(
    shaded.mean > plain.mean * 1.5,
    'shading fills the bands between the levels',
    `mean alpha ${plain.mean.toFixed(1)} -> ${shaded.mean.toFixed(1)}/255`,
  );
  say(
    shaded.mean < 45,
    'at a default faint enough to keep the candles readable',
    `mean alpha ${shaded.mean.toFixed(1)}/255 across the whole object`,
  );

  await openSettings();
  await setNumber('Shade opacity', 0.5);
  await closeSettings();
  const heavy = await ink(page, leftThird[0], rightThird[1]);
  say(
    heavy.mean > shaded.mean * 2,
    'and its own opacity, which is a real change to the paint',
    `mean alpha ${shaded.mean.toFixed(1)} -> ${heavy.mean.toFixed(1)}`,
  );
  await openSettings();
  await setNumber('Shade opacity', 0.07);
  await page
    .locator(
      '[data-testid=drawing-properties] .st-row:has(.st-row-label:text-is("Shade between levels")) input[type=checkbox]',
    )
    .first()
    .uncheck();
  await page.waitForTimeout(400);

  // --- one level's own thickness and line style ---------------------------
  const levels = page.locator('[data-testid=level-editor] .dp-level');
  say((await levels.count()) >= 7, 'the editor lists every level', `${await levels.count()} levels`);

  const fourth = levels.nth(4);
  say(
    (await fourth.locator('.dp-level-width').count()) === 1 &&
      (await fourth.locator('.dp-level-dash').count()) === 1,
    'each level has its own thickness and line style',
  );

  await closeSettings();
  const thin = await litPixels(page, '.draw-canvas');

  await openSettings();
  const width = levels.nth(4).locator('.dp-level-width');
  await width.fill('5');
  await width.dispatchEvent('change');
  await page.waitForTimeout(500);
  await closeSettings();
  const thick = await litPixels(page, '.draw-canvas');
  say(thick > thin + 300, 'thickening one level paints a thicker line', `${thin} -> ${thick} px`);

  await openSettings();
  await levels.nth(4).locator('.dp-level-dash').selectOption('DOTTED');
  await page.waitForTimeout(500);
  await closeSettings();
  const dotted = await litPixels(page, '.draw-canvas');
  say(
    dotted < thick * 0.9,
    'and dotting it breaks that same line into gaps',
    `${thick} solid -> ${dotted} dotted`,
  );

  // Put it back, and prove the OTHER levels never moved.
  await openSettings();
  await levels.nth(4).locator('.dp-level-dash').selectOption('');
  const back = levels.nth(4).locator('.dp-level-width');
  await back.fill('0');
  await back.dispatchEvent('change');
  await page.waitForTimeout(500);
  await closeSettings();
  const restored = await litPixels(page, '.draw-canvas');
  say(
    Math.abs(restored - thin) < thin * 0.05,
    'a level set back to the object default paints as it did',
    `${thin} -> ${restored} px`,
  );

  // --- an unusual custom set ----------------------------------------------
  await openSettings();
  const values = async () =>
    (await page.locator('[data-testid=level-editor] .dp-level-value').all()).length;
  const had = await values();
  await page.click('[data-testid=level-editor] .dp-level-add');
  await page.waitForTimeout(400);
  const odd = page.locator('[data-testid=level-editor] .dp-level-value').last();
  await odd.fill('161.8');
  await odd.dispatchEvent('change');
  await page.waitForTimeout(500);
  const oddLabel = page.locator('[data-testid=level-editor] .dp-level-label').last();
  await oddLabel.fill('ext');
  await page.waitForTimeout(400);
  say((await values()) === had + 1, 'a level can be added', `${had} -> ${await values()}`);
  await closeSettings();

  const extended = await paintedBounds(page, '.draw-canvas');
  say(
    extended !== null && extended.bottom - extended.top > box.bottom - box.top + 10,
    'a 161.8% level is drawn beyond the object, where it belongs',
    `${Math.round(box.bottom - box.top)}px tall -> ${Math.round(
      extended.bottom - extended.top,
    )}px`,
  );

  await shot(page, 'fib-levels');
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
