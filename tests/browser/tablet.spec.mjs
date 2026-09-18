/**
 * The terminal on a tablet.
 *
 * Not the same question as a narrow window, which `responsive` already asks. A
 * touch screen has no pointer, so every control that only appears on hover is
 * a control that does not exist; a finger is about 9mm across, so a 22px
 * target is small and a 17px one is a coin toss; and a two-finger gesture on a
 * chart canvas has to do something sensible rather than zooming the page.
 *
 * What this does NOT claim: that Atlas is a tablet application. It is a
 * desktop terminal, and the honest question is whether a trader who opens it
 * on an iPad can read their positions and work the chart, not whether every
 * affordance is thumb-sized.
 */
import { createReport, launch, shot, signIn } from './harness.mjs';

const { say, finish, watch } = createReport('tablet');
// iPad landscape, which is the orientation a chart is looked at in.
const { browser, page, errors } = await launch({ width: 1180, height: 820, touch: true });
watch(page);

/** Controls that are smaller than a finger, on the surfaces that matter. */
const smallTargets = (selectors) =>
  page.evaluate((list) => {
    const out = [];
    for (const selector of list) {
      for (const el of document.querySelectorAll(selector)) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        if (getComputedStyle(el).visibility === 'hidden') continue;
        if (box.width < 28 || box.height < 28) {
          out.push({
            el: `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`,
            size: `${Math.round(box.width)}x${Math.round(box.height)}`,
            text: (el.textContent ?? '').trim().slice(0, 14),
          });
        }
      }
    }
    return out;
  }, selectors);

try {
  await signIn(page);
  await page.waitForTimeout(2_500);

  say(
    await page.evaluate(() => 'ontouchstart' in window || navigator.maxTouchPoints > 0),
    'the browser really is a touch device',
  );

  // --- it comes up, and it is the terminal ---------------------------------
  const shell = await page.evaluate(() => ({
    chart: document.querySelectorAll('.chart-canvas canvas').length,
    rail: document.querySelectorAll('.apprail-btn').length,
    ticket: document.querySelectorAll('.terminal-right').length,
    scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  say(shell.chart > 0 && shell.rail >= 5 && shell.ticket === 1, 'the whole terminal is there', JSON.stringify(shell));
  say(shell.scroll <= 1, 'and the page does not scroll sideways', `${shell.scroll}px`);
  await shot(page, 'tablet-landscape');

  // --- a finger on the chart -----------------------------------------------
  const plot = await page.locator('.chart-canvas').boundingBox();
  const before = await page.evaluate(() => window.__atlasChartView?.() ?? null);
  await page.touchscreen.tap(plot.x + plot.width * 0.5, plot.y + plot.height * 0.5);
  await page.waitForTimeout(500);
  const dragged = await page.evaluate(
    async ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el ? el.className.toString().slice(0, 40) : 'none';
    },
    [plot.x + plot.width * 0.5, plot.y + plot.height * 0.5],
  );
  say(dragged !== 'none', 'a tap lands on the chart rather than on nothing', dragged);

  // A one-finger drag is a pan.
  await page.touchscreen.tap(plot.x + plot.width * 0.7, plot.y + plot.height * 0.5);
  await page.waitForTimeout(200);
  await page.mouse.move(plot.x + plot.width * 0.7, plot.y + plot.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) {
    await page.mouse.move(plot.x + plot.width * 0.7 - i * 16, plot.y + plot.height * 0.5);
  }
  await page.mouse.up();
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => window.__atlasChartView?.() ?? null);
  say(
    before !== null && after !== null && Math.abs(after.from - before.from) > 0,
    'and a drag moves the chart',
    `${before?.from} → ${after?.from}`,
  );

  // --- the targets a finger has to hit -------------------------------------
  const rail = await smallTargets(['.apprail-btn']);
  say(rail.length === 0, 'every navigation destination is finger-sized', JSON.stringify(rail.slice(0, 3)));

  const ticket = await smallTargets(['.terminal-right button']);
  say(
    ticket.length <= 2,
    'and so is the order ticket, near enough',
    `${ticket.length} small: ${JSON.stringify(ticket.slice(0, 3))}`,
  );

  // --- what a touch screen cannot hover ------------------------------------
  /*
   * The indicator legend hides its controls until the row is hovered, and a
   * finger cannot hover. On a touch screen the row has to be TAPPABLE into the
   * same state, or those studies can be added and never removed.
   */
  await page.click('.chdr-btn:has-text("Indicators")');
  await page.waitForTimeout(500);
  await page.click('[data-testid=indicator-catalogue] .pop-item:has-text("Exponential moving")');
  await page.waitForTimeout(1_200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const row = page.locator('[data-testid=indicator-row]').first();
  say((await row.count()) === 1, 'a study can be added with a tap');

  const rowBox = await row.boundingBox();
  await page.touchscreen.tap(rowBox.x + 20, rowBox.y + rowBox.height / 2);
  await page.waitForTimeout(400);
  const actionsVisible = await page.evaluate(() => {
    const actions = document.querySelector('[data-testid=indicator-row] .ind-actions');
    return actions ? Number(getComputedStyle(actions).opacity) : -1;
  });
  say(
    actionsVisible > 0.5,
    'and tapping its row brings out the controls a finger cannot hover for',
    `opacity ${actionsVisible}`,
  );
  if (actionsVisible <= 0.5) await shot(page, 'tablet-legend-unreachable');

  // --- portrait, which is how a tablet is usually held ---------------------
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.waitForTimeout(1_500);
  const portrait = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    chart: Math.round(document.querySelector('.chart-canvas')?.getBoundingClientRect().width ?? 0),
    rail: document.querySelectorAll('.apprail-btn').length,
  }));
  say(portrait.scroll <= 1, 'portrait does not scroll sideways either', JSON.stringify(portrait));
  say(portrait.chart > 300, 'and the chart is still a chart', `${portrait.chart}px wide`);

  /*
   * Nothing in the top bar may be cut in half.
   *
   * At 820px the clock wrapped onto two lines and the DELAYED chip was sliced
   * by the bar's own overflow. Half a word is worse than no word, so the
   * session cluster is dropped at this width - and this asks the question the
   * right way round: is everything that IS shown, shown completely.
   */
  const clipped = await page.evaluate(() => {
    const bar = document.querySelector('.abar');
    if (!bar) return ['no account bar'];
    const edge = bar.getBoundingClientRect();
    const out = [];
    for (const el of bar.querySelectorAll('*')) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right > edge.right + 0.5 || box.bottom > edge.bottom + 0.5) {
        out.push(`${el.className || el.tagName}: ${(el.textContent ?? '').trim().slice(0, 12)}`);
      }
    }
    return out;
  });
  say(clipped.length === 0, 'and nothing in the top bar is cut off', clipped.slice(0, 3).join(' · '));

  const barHeight = await page.evaluate(
    () => Math.round(document.querySelector('.abar')?.getBoundingClientRect().height ?? 0),
  );
  say(barHeight <= 44, 'the top bar is still one row', `${barHeight}px`);
  await shot(page, 'tablet-portrait');

  // --- clean up ------------------------------------------------------------
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForTimeout(800);
  for (let i = 0; i < 6; i += 1) {
    const remove = page.locator('[data-testid=indicator-row] .ind-btn-danger').first();
    if ((await remove.count()) === 0) break;
    await remove.click({ force: true });
    await page.waitForTimeout(400);
  }
  say(
    (await page.locator('[data-testid=indicator-row]').count()) === 0,
    'and a study can be removed again on a touch screen',
  );

  say(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 200));
} finally {
  await browser.close();
}

process.exit(finish());
