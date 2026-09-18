/**
 * What a study does while the market is moving.
 *
 * The live path is the one that used to recompute every study over every bar
 * the chart held, several times a second, and it is now the one that computes
 * over a declared window instead. Two things have to be true of that window,
 * and neither is visible from a screenshot:
 *
 *   - the newest value keeps moving, so the window really is being computed;
 *   - nothing ELSE shrinks to the window - a Bollinger band that quietly
 *     collapsed to its last twenty-two bars still looks like a Bollinger band.
 *
 * A replay is used rather than the live feed, because a test that only runs
 * when the market happens to be moving is not a test. The replay drives the
 * same code path a tick does.
 */
import { createReport, launch, signIn, clearIndicators, useSymbol } from './harness.mjs';

const { say, finish, watch } = createReport('live-indicators');
const { browser, page, errors } = await launch({ width: 1600, height: 950 });
watch(page);

const cost = () =>
  page.evaluate(() => window.__atlasIndicatorCost?.() ?? { tailCalls: 0, bars: 0 });
const studies = () => page.evaluate(() => window.__atlasIndicators?.() ?? []);
/** What the studies currently READ, from the adapter rather than from the DOM. */
const legendValues = async () =>
  JSON.stringify((await studies()).map((item) => item.values));

/** Wait until the replay has delivered at least n updates to the studies. */
async function waitForBars(n, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  let bars = 0;
  while (Date.now() < until) {
    bars = (await cost()).bars;
    if (bars >= n) return bars;
    await page.waitForTimeout(2_000);
  }
  return bars;
}

async function waitForTicks(n, timeoutMs = 60_000) {
  const start = (await cost()).tailCalls;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const now = (await cost()).tailCalls;
    if (now - start >= n) return now - start;
    await page.waitForTimeout(1_000);
  }
  return (await cost()).tailCalls - start;
}

try {
  await signIn(page);
  await useSymbol(page, 'NQ');
  await clearIndicators(page);

  // --- a replay, playing ---------------------------------------------------
  await page.click('[data-testid=apprail-practice]');
  await page.waitForSelector('[data-testid=drawer-practice]', { timeout: 15_000 });
  await page.waitForTimeout(2_500);
  if (await page.locator('.practice-active').count()) {
    await page.click('.practice-active .chip');
    await page.waitForTimeout(6_000);
  }
  const sessions = await page.locator('.practice-session').count();
  say(sessions > 0, 'there is a recording to replay', `${sessions}`);
  if (sessions === 0) throw new Error('no recording to replay');
  await page.locator('.practice-session').first().click();
  await page.waitForTimeout(9_000);
  await page.click('.practice-speeds .chip:text-is("50×")').catch(() => {});
  await page.waitForTimeout(500);
  await page.click('.practice-row .chip:has-text("Play")').catch(() => {});
  await page.waitForTimeout(600);
  await page.click('[data-testid=drawer-practice] .drawer-close');
  await page.waitForTimeout(3_000);

  // --- a band and a moving average ----------------------------------------
  const add = async (name) => {
    await page.click('.chdr-btn:has-text("Indicators")');
    await page.waitForTimeout(400);
    await page.click(`[data-testid=indicator-catalogue] .pop-item:has-text("${name}")`);
    await page.waitForTimeout(1_500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  };
  await add('Bollinger');
  await add('Moving average');

  /*
   * Enough bars for a twenty-period band to have a band.
   *
   * A replay opens on a handful of bars and builds up as it plays, and a
   * Bollinger over twenty bars has nothing to say until there are twenty-one
   * of them. Waiting for the bars rather than for a fixed number of seconds is
   * what makes the counts below mean something.
   */
  const waited = await waitForTicks(8, 90_000);
  /*
   * More bars than the window, with room to spare.
   *
   * What has to be true for this suite to mean anything is that the history is
   * LONGER than the twenty-two bars a Bollinger band's newest value is
   * computed over - otherwise the windowed path never runs and the checks
   * below are about nothing. Forty is that with margin; the replay's pace
   * decides how long it takes to get there, and asking for forty-five once
   * failed on a run that reached forty-four.
   */
  const grown = await waitForBars(40, 240_000);
  const held = await cost();
  say(waited >= 8, 'the replay delivers updates to the studies', `${waited} updates`);
  say(grown >= 40, 'and builds a history longer than the window', `${held.bars} bars, window 22`);

  const before = await studies();
  const bollBefore = before.find((s) => s.kind === 'BOLL');
  say(
    bollBefore !== undefined && Object.keys(bollBefore.fills).length > 0,
    'the band has a shaded fill',
    JSON.stringify(bollBefore?.fills ?? {}),
  );

  const legendBefore = await legendValues();
  await waitForTicks(10, 60_000);
  const after = await studies();
  const bollAfter = after.find((s) => s.kind === 'BOLL');
  const legendAfter = await legendValues();

  say(
    legendAfter !== legendBefore,
    'the values keep moving with the market',
    `${legendBefore.slice(0, 60)} → ${legendAfter.slice(0, 60)}`,
  );

  const fillBefore = Object.values(bollBefore?.fills ?? {})[0] ?? 0;
  const fillAfter = Object.values(bollAfter?.fills ?? {})[0] ?? 0;
  say(
    fillAfter >= fillBefore,
    'and the band does not shrink to the window it is computed over',
    `${fillBefore} → ${fillAfter} points`,
  );

  const plotBefore = Object.values(bollBefore?.plots ?? {})[0] ?? 0;
  const plotAfter = Object.values(bollAfter?.plots ?? {})[0] ?? 0;
  say(
    plotAfter >= plotBefore,
    'nor do the lines it is drawn from',
    `${plotBefore} → ${plotAfter} points`,
  );

  /*
   * A twenty-period band starts nineteen bars in, so the honest expectation is
   * "most of the history", not "all of it". The window it is computed over on
   * a tick is twenty-two bars: anything close to that number here would mean
   * the band had been replaced by its own window.
   */
  const bars = (await cost()).bars;
  say(
    fillAfter > bars - 30 && plotAfter > bars - 30,
    'the band still covers the chart rather than its last few bars',
    `${fillAfter} fill points and ${plotAfter} line points, over ${bars} bars`,
  );

  say(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 200));
} finally {
  await browser.close();
}

process.exit(finish());
