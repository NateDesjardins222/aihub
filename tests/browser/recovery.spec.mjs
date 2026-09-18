/**
 * Starting up, over and over, and failing on purpose.
 *
 * A terminal is reloaded more often than any other kind of application: a
 * trader refreshes after a data hiccup, after a deploy, out of habit. Ten
 * reloads have to be indistinguishable from the first one, five reloads in
 * quick succession must not leave the workspace half-written, and the things
 * that can fail underneath - the bars endpoint, the save endpoint - have to
 * fail visibly rather than silently or fatally.
 *
 * Every check here is about what the trader can SEE: a chart with candles on
 * it, their own drawing back where they left it, or a message saying what went
 * wrong. "No exception was thrown" is not a passing grade.
 */
import { createReport, launch, signIn, clearDrawings, shot, useSymbol } from './harness.mjs';

const { say, finish, watch } = createReport('recovery');
const { browser, page, errors } = await launch({ width: 1600, height: 950 });
watch(page);

const WEB = process.env.ATLAS_WEB_URL ?? 'http://localhost:5174';

/** Time from reload to a chart with candles actually painted. */
async function reloadToUsable(waitUntil = 'domcontentloaded') {
  const started = Date.now();
  await page.reload({ waitUntil });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForFunction(
    () => {
      const view = window.__atlasChartView?.();
      return view !== null && view !== undefined && view.span > 0;
    },
    { timeout: 40_000 },
  );
  return Date.now() - started;
}

const resources = () =>
  page.evaluate(() => ({
    dom: document.querySelectorAll('*').length,
    canvases: document.querySelectorAll('canvas').length,
  }));

/** One drawing of the trader's own, so a reload has something to lose. */
async function seedDrawing() {
  return page.evaluate(async () => {
    const refreshToken = window.localStorage.getItem('atlas.refreshToken');
    const session = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).then((r) => r.json());
    window.localStorage.setItem('atlas.refreshToken', session.refreshToken);
    const auth = {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
    };
    const bars = await fetch('/api/v1/marketdata/bars?symbol=NQ&timeframe=1m&limit=120', {
      headers: auth,
    }).then((r) => r.json());
    const all = bars.bars ?? [];
    const at = all[all.length - 30];
    if (!at) return false;
    const drawing = {
      id: 'recovery-anchor',
      kind: 'HORIZONTAL_LINE',
      symbol: 'NQ',
      anchors: [{ time: at.time, price: at.low }],
      style: {
        color: '#5b9dff',
        opacity: 1,
        width: 1,
        dash: 'SOLID',
        filled: false,
        fillColor: '#5b9dff',
        fillOpacity: 0.1,
        fontSize: 11,
        showPrice: false,
      },
      options: {},
      text: '',
      locked: false,
      hidden: false,
      timeframes: [],
    };
    const response = await fetch('/api/v1/drawings', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ drawings: [drawing] }),
    });
    return response.ok;
  });
}

const objectsInTree = async () => {
  await page.click('.rail .rail-btn[aria-label="Object tree"]');
  await page.waitForTimeout(400);
  const rows = await page.locator('[data-testid=object-tree-row]').count();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  return rows;
};

try {
  await signIn(page);
  // The object tree lists the objects of the instrument on the chart, so the
  // chart has to be on the instrument the drawing below is anchored to.
  await useSymbol(page, 'NQ');
  await clearDrawings(page);
  say(await seedDrawing(), 'a drawing is stored to survive the reloads');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(4_000);

  // --- ten reloads --------------------------------------------------------
  const times = [];
  const before = await resources();
  let intact = 0;
  const errorsAtStart = errors.length;
  for (let i = 0; i < 10; i += 1) {
    times.push(await reloadToUsable());
    await page.waitForTimeout(2_500);
    if ((await objectsInTree()) === 1) intact += 1;
  }
  const after = await resources();
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const worst = times[times.length - 1];
  say(worst < median * 3, 'ten reloads stay as quick as the first', `median ${median}ms, worst ${worst}ms`);
  say(intact === 10, 'and the workspace comes back every single time', `${intact}/10`);
  say(
    after.dom < before.dom * 1.25 && after.canvases === before.canvases,
    'with no drift in nodes or canvases',
    `dom ${before.dom} → ${after.dom}, canvases ${before.canvases} → ${after.canvases}`,
  );
  say(
    errors.length === errorsAtStart,
    'and nothing on the console',
    errors.slice(errorsAtStart, errorsAtStart + 2).join(' | '),
  );

  // --- reloads that interrupt each other -----------------------------------
  const errorsBeforeRapid = errors.length;
  for (let i = 0; i < 5; i += 1) {
    await page.goto(WEB, { waitUntil: 'commit' });
    await page.waitForTimeout(400 + i * 120);
  }
  const settled = await reloadToUsable();
  await page.waitForTimeout(3_000);
  say(settled < 15_000, 'a reload interrupted four times still comes up', `${settled}ms`);
  say((await objectsInTree()) === 1, 'and the workspace is not half-written');
  say(
    errors.length === errorsBeforeRapid,
    'and the interruptions produce no errors',
    errors.slice(errorsBeforeRapid, errorsBeforeRapid + 2).join(' | '),
  );

  // --- the bars endpoint, failing ------------------------------------------
  await page.route('**/api/v1/marketdata/bars**', (route) => route.abort('failed'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9_000);
  const alive = await page.evaluate(() => ({
    canvases: document.querySelectorAll('canvas').length,
    body: (document.body.innerText ?? '').length,
  }));
  say(alive.canvases > 0 && alive.body > 200, 'a dead bars endpoint does not blank the terminal', JSON.stringify(alive));
  const toldTheTrader =
    (await page.locator('.chart-overlay-error, .chart-history-note').count()) > 0;
  say(toldTheTrader, 'and it says so rather than showing an empty chart');
  if (!toldTheTrader) await shot(page, 'recovery-bars-down');

  await page.unroute('**/api/v1/marketdata/bars**');
  const recovered = await reloadToUsable();
  await page.waitForTimeout(2_500);
  say(recovered < 20_000, 'and the terminal returns once the endpoint does', `${recovered}ms`);

  // --- the save endpoint, failing ------------------------------------------
  await page.route('**/api/v1/preferences', (route) =>
    route.request().method() === 'PUT' ? route.abort('failed') : route.continue(),
  );
  // Something small and real: a different interval.
  const other = await page.locator('.chdr-tf:not(.chdr-tf-on):not(.chdr-tf-more)').first().innerText();
  await page.click(`.chdr-tf:text-is("${other}")`);
  await page.waitForTimeout(4_000);
  const warned = (await page.locator('[data-testid=save-error]').count()) > 0;
  say(warned, 'a failed save is shown to the trader, not swallowed');
  if (!warned) await shot(page, 'recovery-save-down');

  await page.unroute('**/api/v1/preferences');
  await page.click('.chdr-tf:text-is("1m")').catch(() => {});
  await page.waitForTimeout(4_000);
  const cleared = (await page.locator('[data-testid=save-error]').count()) === 0;
  say(cleared, 'and the warning goes away when saving works again');

  say(errors.length < 40, 'the console is not a wall of noise', `${errors.length} messages in all`);
} finally {
  await browser.close();
}

process.exit(finish());
