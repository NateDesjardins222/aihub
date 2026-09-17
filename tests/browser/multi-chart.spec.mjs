/**
 * Multi-chart layouts.
 *
 * The brief: "Multi-chart layouts do not appear to exist. There must be an
 * obvious chart layout control - 1, 2 vertical, 2 horizontal, 3, 4 - and each
 * chart must be independent: its own symbol, interval, indicators and
 * settings, with an optional synchronisation menu."
 *
 * Independence is the thing worth testing, so every check here reads TWO panes
 * and compares them. A layout that shows four copies of the same chart is not
 * four charts.
 */
import { createReport, launch, shot, signIn } from './harness.mjs';

const { say, finish } = createReport('multi-chart');
const { browser, page, errors } = await launch({ width: 1680, height: 950 });

async function chooseLayout(kind) {
  await page.click('[data-testid=layout-button]');
  await page.waitForTimeout(400);
  await page.click(`[data-testid=layout-choices] button[data-layout=${kind}]`);
  // Every pane loads its own history, so this is a real wait, not a flourish.
  await page.waitForTimeout(kind === 'ONE' ? 2_500 : 6_000);
}

async function setSync(label, on) {
  await page.click('[data-testid=layout-button]');
  await page.waitForTimeout(400);
  const box = page.locator(`input[aria-label="Sync ${label}"]`);
  if (on) await box.check();
  else await box.uncheck();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

const paneCount = () => page.locator('[data-testid=chart-pane]').count();

/** What a pane's own status line says: symbol, interval and the last bar. */
async function statusOf(pane) {
  return (await page.locator(`[data-pane=${pane}] [data-testid=status-line]`).innerText())
    .replace(/\s+/g, ' ')
    .trim();
}

async function setPaneTimeframe(pane, tf) {
  await page.click(`[data-pane=${pane}] .chdr-tf:has-text("${tf}")`);
  await page.waitForTimeout(2_500);
}

async function setPaneSymbol(pane, root) {
  await page.click(`[data-pane=${pane}] .chdr-symbol`);
  await page.waitForTimeout(500);
  await page.click(`.popover .pop-item:has(.chdr-pop-root:text-is("${root}"))`);
  await page.waitForTimeout(3_500);
}

try {
  await signIn(page);
  await page.waitForTimeout(4_000);
  await chooseLayout('ONE');

  // --- the control itself ---------------------------------------------------
  say(
    (await page.locator('[data-testid=layout-button]').count()) === 1,
    'the terminal has a chart layout control, in its own top bar',
  );
  await page.click('[data-testid=layout-button]');
  await page.waitForTimeout(400);
  const choices = await page
    .locator('[data-testid=layout-choices] button')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-layout')));
  say(
    JSON.stringify(choices) === JSON.stringify(['ONE', 'TWO_V', 'TWO_H', 'THREE', 'FOUR']),
    'offering one, two side by side, two stacked, three and four',
    choices.join(' / '),
  );
  const syncLabels = await page
    .locator('.lm-sync span')
    .allTextContents();
  say(
    ['Crosshair', 'Time range', 'Symbol', 'Interval'].every((label) =>
      syncLabels.includes(label),
    ),
    'and a synchronisation menu beside it',
    syncLabels.join(' / '),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // --- the layouts ---------------------------------------------------------
  for (const [kind, expected] of [
    ['TWO_V', 2],
    ['TWO_H', 2],
    ['THREE', 3],
    ['FOUR', 4],
  ]) {
    await chooseLayout(kind);
    const count = await paneCount();
    say(count === expected, `${kind} shows ${expected} charts`, `${count} panes`);
  }

  // The shapes differ, not just the count: two side by side are the same
  // height, two stacked are the same width.
  await chooseLayout('TWO_V');
  const vertical = await page.locator('[data-testid=chart-pane]').evaluateAll((nodes) =>
    nodes.map((n) => ({ w: Math.round(n.clientWidth), h: Math.round(n.clientHeight) })),
  );
  say(
    vertical.length === 2 && vertical[0].h === vertical[1].h && vertical[0].w < 900,
    'two side by side split the width',
    JSON.stringify(vertical),
  );
  await chooseLayout('TWO_H');
  const stacked = await page.locator('[data-testid=chart-pane]').evaluateAll((nodes) =>
    nodes.map((n) => ({ w: Math.round(n.clientWidth), h: Math.round(n.clientHeight) })),
  );
  say(
    stacked.length === 2 && stacked[0].w === stacked[1].w && stacked[0].h < 500,
    'and two stacked split the height',
    JSON.stringify(stacked),
  );

  // --- independence --------------------------------------------------------
  await chooseLayout('TWO_V');
  await setSync('interval', false);
  await setSync('symbol', false);

  await setPaneTimeframe('p1', '1m');
  await setPaneTimeframe('p2', '15m');
  const p1 = await statusOf('p1');
  const p2 = await statusOf('p2');
  say(
    / 1m /.test(p1) && / 15m /.test(p2),
    'each chart keeps its own interval',
    `${p1.slice(0, 40)} || ${p2.slice(0, 40)}`,
  );

  await setPaneSymbol('p2', 'ES');
  const symbols = [await statusOf('p1'), await statusOf('p2')];
  say(
    /^NQ /.test(symbols[0]) && /^ES /.test(symbols[1]),
    'and its own instrument',
    `${symbols[0].slice(0, 24)} || ${symbols[1].slice(0, 24)}`,
  );

  // The order ticket follows the ACTIVE pane, and only that one.
  const contract = async () =>
    (await page.locator('.tk-contract, [data-testid=ticket-contract]').first().innerText()).trim();
  const beforeActivate = await contract();
  await page.click('[data-pane=p2] .chart-canvas', { position: { x: 60, y: 60 } });
  await page.waitForTimeout(1_200);
  say(
    (await page.locator('[data-pane=p2].grid-pane-active').count()) === 1,
    'clicking a chart makes it the active one, and says so',
  );
  say(
    beforeActivate === (await contract()),
    'and does NOT re-point the order ticket by itself',
    `${beforeActivate} -> ${await contract()}`,
  );

  // --- indicators are per chart -------------------------------------------
  await page.click('[data-pane=p1] .chdr-btn:has-text("Indicators")');
  await page.waitForTimeout(600);
  await page.click('[data-testid=indicator-catalogue] .pop-item:has-text("Relative strength")');
  await page.waitForTimeout(1_500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const rows = async (pane) =>
    (await page.locator(`[data-pane=${pane}] [data-testid=indicator-row]`).allTextContents()).map(
      (t) => t.replace(/\s+/g, ' ').trim(),
    );
  const p1Rows = await rows('p1');
  const p2Rows = await rows('p2');
  say(
    p1Rows.some((row) => /RSI 14/.test(row)) && !p2Rows.some((row) => /RSI/.test(row)),
    'an indicator added to one chart appears on that chart alone',
    `p1: ${p1Rows.join(', ') || '(none)'} | p2: ${p2Rows.join(', ') || '(none)'}`,
  );

  await shot(page, 'multi-chart-two');

  // --- synchronisation -----------------------------------------------------
  await setSync('crosshair', true);
  await setSync('time range', true);
  const box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5);
  await page.waitForTimeout(700);
  const synced = await page.evaluate(() => window.__atlasPaneSync?.() ?? null);
  say(
    synced !== null && typeof synced.crosshair.p2 === 'number',
    'with the crosshair synced, pointing at one chart moves the other',
    synced ? `p2 followed to ${new Date(synced.crosshair.p2).toISOString()}` : 'no diagnostics',
  );

  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1_000);
  const afterPan = await page.evaluate(() => window.__atlasPaneSync?.() ?? null);
  say(
    afterPan?.range?.p2 !== undefined && afterPan.range.p2.toMs > afterPan.range.p2.fromMs,
    'and panning one chart moves the other to the same window of time',
    afterPan?.range?.p2
      ? `${new Date(afterPan.range.p2.fromMs).toISOString()} -> ${new Date(
          afterPan.range.p2.toMs,
        ).toISOString()}`
      : 'no range applied',
  );
  // A runaway feedback loop between two synced panes zooms them both into a
  // few minutes within a second; this is the check that it does not.
  const span = afterPan?.range?.p2
    ? afterPan.range.p2.toMs - afterPan.range.p2.fromMs
    : 0;
  say(
    span > 20 * 60_000,
    'without the two of them zooming each other into the ground',
    `${Math.round(span / 60_000)} minutes of range`,
  );

  await setSync('interval', true);
  await setPaneTimeframe('p1', '5m');
  const both = [await statusOf('p1'), await statusOf('p2')];
  say(
    / 5m /.test(both[0]) && / 5m /.test(both[1]),
    'with the interval synced, one change moves both',
    `${both[0].slice(0, 24)} || ${both[1].slice(0, 24)}`,
  );
  await setSync('interval', false);
  await setSync('crosshair', false);
  await setSync('time range', false);

  // --- maximize and restore ------------------------------------------------
  await page.click('[data-pane=p2] button[aria-label="Maximize this chart"]');
  await page.waitForTimeout(1_500);
  say((await paneCount()) === 1, 'a chart can fill the layout');
  say(
    (await page.locator('[data-testid=chart-pane][data-pane=p2]').count()) === 1,
    'and it is the one that was maximized',
  );
  await page.click('[data-pane=p2] button[aria-label="Restore the layout"]');
  await page.waitForTimeout(2_500);
  say((await paneCount()) === 2, 'and the layout comes back');

  // --- persistence ---------------------------------------------------------
  await page.waitForTimeout(2_000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(8_000);
  say((await paneCount()) === 2, 'the layout survives a reload', `${await paneCount()} panes`);
  const reloaded = [await statusOf('p1'), await statusOf('p2')];
  say(
    /^NQ /.test(reloaded[0]) && /^ES /.test(reloaded[1]),
    'and so does what each chart was showing',
    `${reloaded[0].slice(0, 24)} || ${reloaded[1].slice(0, 24)}`,
  );

  // Put the terminal back to one chart on NQ for the suites that follow.
  await setPaneSymbol('p2', 'NQ');
  await chooseLayout('ONE');
  say((await paneCount()) === 1, 'and it goes back to a single chart');
  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  await browser.close();
}

process.exit(finish());
