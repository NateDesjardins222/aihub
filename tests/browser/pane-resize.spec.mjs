/**
 * The pane separator, end to end.
 *
 * Resizing a study pane was called out as explicitly incomplete. The renderer
 * does the drag itself - a nine pixel handle with a row-resize cursor - so
 * what this checks is everything around it: that the handle is really there
 * and really that size, that a drag changes the split, that a double-click
 * puts it back, that the split survives adding another study, that it
 * survives a reload, and that removing the last study gives the height back.
 */
import { createReport, launch, signIn, clearIndicators } from './harness.mjs';

const { say, finish, watch } = createReport('pane-resize');
const { browser, page, errors } = await launch({ width: 1680, height: 1000 });
watch(page);

/** The height of each pane's plot cell, top to bottom. */
const paneHeights = () =>
  page.evaluate(() => {
    const root = document.querySelector('[data-pane=p1] .chart-canvas') ?? document.querySelector('.chart-canvas');
    const seen = new Set();
    const out = [];
    for (const canvas of root?.querySelectorAll('td canvas') ?? []) {
      const cell = canvas.parentElement;
      if (!cell || seen.has(cell)) continue;
      seen.add(cell);
      const box = cell.getBoundingClientRect();
      // The time axis is a row too, and it is not a pane.
      if (box.width < 400 || box.height < 40) continue;
      out.push(Math.round(box.height));
    }
    return out;
  });

/** Where the renderer's own resize handles are, and how big. */
const handles = () =>
  page.evaluate(() => {
    const root = document.querySelector('[data-pane=p1] .chart-canvas') ?? document.querySelector('.chart-canvas');
    const out = [];
    for (const el of root?.querySelectorAll('td > div') ?? []) {
      const style = getComputedStyle(el);
      if (style.cursor !== 'row-resize' || style.position !== 'absolute') continue;
      const box = el.getBoundingClientRect();
      out.push({ y: Math.round(box.y + box.height / 2), h: Math.round(box.height), title: el.title });
    }
    return out;
  });

/**
 * The heights once they have stopped moving.
 *
 * A reload lays the panes out more than once - the chart mounts empty, the
 * stored workspace arrives, the studies open their panes - and a fixed wait
 * photographs whichever of those moments it lands on. This waits for two
 * identical reads instead, which is the resting state a trader sees.
 */
const settled = async (timeoutMs = 20_000) => {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    const now = (await paneHeights()).join('/');
    if (now !== '' && now === last) return now.split('/').map(Number);
    last = now;
    await page.waitForTimeout(300);
  }
  return (await paneHeights());
};

const addIndicator = async (text) => {
  await page.click('.chdr-btn:has-text("Indicators")');
  await page.waitForTimeout(400);
  await page.click(`[data-testid=indicator-catalogue] .pop-item:has-text("${text}")`);
  await page.waitForTimeout(1_600);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
};

try {
  await signIn(page);
  await clearIndicators(page);
  await page.waitForTimeout(1_200);

  const single = await paneHeights();
  say(single.length === 1, 'a chart with no study has one pane', `${single.join('/')}px`);

  await addIndicator('Relative strength');
  const withRsi = await paneHeights();
  say(withRsi.length === 2, 'a study opens a pane of its own', `${withRsi.join('/')}px`);
  say(
    withRsi[0] > withRsi[1] * 2,
    'and the price keeps most of the height',
    `${withRsi.join('/')}px`,
  );

  const grips = await handles();
  say(grips.length === 1, 'there is a grip between them', JSON.stringify(grips));
  say((grips[0]?.h ?? 0) >= 8, 'and it is a target a hand can hit', `${grips[0]?.h}px tall`);
  say(!!grips[0]?.title, 'which says what it does', grips[0]?.title ?? '');

  const box = await page.locator('.chart-canvas').boundingBox();
  const x = box.x + box.width * 0.4;

  // --- drag ---------------------------------------------------------------
  const dragTo = async (dy) => {
    const grip = (await handles())[0];
    await page.mouse.move(x, grip.y);
    await page.mouse.down();
    const steps = 12;
    for (let i = 1; i <= steps; i += 1) await page.mouse.move(x, grip.y + (dy * i) / steps);
    await page.mouse.up();
    await page.waitForTimeout(800);
  };
  await dragTo(-150);
  const dragged = await paneHeights();
  say(
    dragged[1] > withRsi[1] + 100,
    'dragging the grip up grows the study pane',
    `${withRsi.join('/')} -> ${dragged.join('/')}`,
  );

  // --- another study, same split -----------------------------------------
  await addIndicator('MACD');
  const three = await paneHeights();
  say(three.length === 3, 'a second oscillator opens a third pane', `${three.join('/')}px`);
  say(
    Math.abs(three[0] - dragged[0]) < 40,
    'and adding it does not undo the split the trader dragged',
    `price ${dragged[0]} -> ${three[0]}`,
  );

  // --- reload -------------------------------------------------------------
  await page.waitForTimeout(2_500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  const reloaded = await settled();
  say(
    reloaded.length === 3 && Math.abs(reloaded[0] - three[0]) < 40,
    'the split comes back after a reload',
    `${three.join('/')} -> ${reloaded.join('/')}`,
  );

  // --- double-click restores automatic ------------------------------------
  const grip = (await handles())[0];
  await page.mouse.dblclick(x, grip.y);
  await page.waitForTimeout(900);
  const reset = await paneHeights();
  say(
    reset[0] > reloaded[0] + 60,
    'a double-click puts the split back to automatic',
    `${reloaded.join('/')} -> ${reset.join('/')}`,
  );

  // --- removing the studies gives the height back -------------------------
  await clearIndicators(page);
  await page.waitForTimeout(1_500);
  const cleared = await paneHeights();
  say(cleared.length === 1, 'removing every study leaves one pane', `${cleared.join('/')}px`);
  say(
    Math.abs(cleared[0] - single[0]) <= 2,
    'and it is the whole chart again',
    `${single[0]} -> ${cleared[0]}`,
  );

  say(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 200));
} finally {
  await browser.close();
}

process.exit(finish());
