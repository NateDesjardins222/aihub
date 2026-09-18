/**
 * The journal: a real trading month, and the way into a single trade.
 *
 * The brief: "The journal calendar must be a real monthly calendar - Sunday to
 * Saturday cells, daily net P&L, trade count, green and red days, weekly and
 * monthly totals. Clicking a day shows its trades. Clicking a trade shows its
 * full detail including MAE and MFE, and can rebuild the chart."
 *
 * The account used here is whichever one has trades in it, because a calendar
 * of an empty account proves nothing.
 */
import { createReport, launch, shot, signIn } from './harness.mjs';

const { say, finish, watch } = createReport('journal-calendar');
const { browser, page, errors } = await launch({ width: 1680, height: 950 });
watch(page);

/** Pick the account with the most trades: the journal needs something to show. */
async function useBusiestAccount() {
  const options = await page
    .locator('.abar-account option')
    .evaluateAll((nodes) => nodes.map((n) => ({ value: n.value, label: n.textContent?.trim() })));
  let best = null;
  for (const option of options) {
    await page.selectOption('.abar-account', option.value);
    await page.waitForTimeout(1_800);
    // count() first: innerText on an element that is not there waits out the
    // whole default timeout, which turned six accounts into three minutes.
    const badge = page.locator('.tab:has-text("Trades") .tab-count');
    const count = (await badge.count()) > 0 ? Number((await badge.innerText()) || 0) : 0;
    if (best === null || count > best.count) best = { ...option, count };
  }
  if (best) {
    await page.selectOption('.abar-account', best.value);
    await page.waitForTimeout(2_000);
  }
  return best;
}

async function openJournal(tab) {
  if ((await page.locator('[data-testid=drawer-journal]').count()) === 0) {
    await page.click('.abar-icon[aria-label=Journal]');
    await page.waitForSelector('[data-testid=drawer-journal]', { timeout: 15_000 });
    await page.waitForTimeout(2_500);
  }
  await page.click(`.journal-tabs .chip:has-text("${tab}")`);
  await page.waitForTimeout(1_200);
}

try {
  await signIn(page);
  await page.waitForTimeout(3_500);
  const account = await useBusiestAccount();
  say(
    account !== null && account.count > 0,
    'an account with trades in it is available to review',
    account ? `${account.label}, ${account.count} trades` : 'none',
  );

  await openJournal('Calendar');

  // --- the shape of a calendar ---------------------------------------------
  const weekdays = await page.locator('.cal-weekday').allTextContents();
  say(
    JSON.stringify(weekdays) ===
      JSON.stringify(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Week']),
    'the calendar runs Sunday to Saturday, with a weekly total',
    weekdays.join(' '),
  );

  const month = await page.locator('[data-testid=calendar-month]').innerText();
  say(/\w+ \d{4}/.test(month), 'it names the month it is showing', month);

  const cells = await page.locator('.cal-grid .cal-cell').count();
  say(cells % 8 === 0 && cells >= 32, 'and lays the month out in whole weeks', `${cells} cells`);

  // --- what a traded day says ----------------------------------------------
  const days = page.locator('[data-testid=calendar-day]');
  const dayCount = await days.count();
  say(dayCount > 0, 'the days that were traded are marked', `${dayCount} traded days`);

  const first = days.first();
  const text = (await first.innerText()).replace(/\s+/g, ' ');
  say(
    /\d/.test(text) && /\$|—/.test(text) && /trade/.test(text),
    'each with its date, its net result and how many trades it took',
    text,
  );
  const tone = await days.evaluateAll((nodes) =>
    nodes.map((n) => (n.classList.contains('up') ? 'green' : 'red')),
  );
  say(tone.length > 0, 'and coloured by whether the day made money', tone.join(' / '));

  const weekTotals = await page.locator('[data-testid=calendar-week]').count();
  say(weekTotals >= 4, 'every week carries its own total', `${weekTotals} weekly totals`);
  const monthTotal = (await page.locator('[data-testid=calendar-total]').innerText()).replace(
    /\s+/g,
    ' ',
  );
  say(
    /\$/.test(monthTotal) && /day/.test(monthTotal) && /trade/.test(monthTotal),
    'and the month carries its own',
    monthTotal,
  );

  // The arrows only walk to months there is something to see in.
  const back = page.locator('button[aria-label="Previous month"]');
  const forward = page.locator('button[aria-label="Next month"]');
  say(
    (await back.count()) === 1 && (await forward.count()) === 1,
    'the month can be walked backwards and forwards',
  );
  say(
    await forward.isDisabled(),
    'and it opens on the most recent month, with nothing ahead of it',
  );

  await shot(page, 'journal-calendar');

  // --- a day, and then a trade ---------------------------------------------
  const picked = await first.getAttribute('data-date');
  await first.click();
  await page.waitForTimeout(1_500);
  const filter = (await page.locator('[data-testid=journal-day-filter]').innerText()).replace(
    /\s+/g,
    ' ',
  );
  say(
    filter.includes(picked),
    'clicking a day opens the trades taken on that day',
    filter,
  );

  const rows = await page.locator('.journal-trades > li').count();
  say(rows > 0, 'and there are trades in it', `${rows} trades`);

  await page.click('.journal-trades > li:first-child .journal-trade-head');
  await page.waitForTimeout(900);
  const detail = (await page.locator('.journal-trades > li.expanded').innerText()).replace(
    /\s+/g,
    ' ',
  );
  say(/MAE/.test(detail) && /MFE/.test(detail), 'a trade opens its own detail, with MAE and MFE', detail.slice(0, 160));

  const recall = page.locator('.journal-trades > li.expanded button:has-text("Show on chart")');
  say((await recall.count()) > 0, 'and an offer to put it back on the chart');
  if ((await recall.count()) > 0) {
    await recall.first().click();
    await page.waitForTimeout(2_500);
    const status = (await page.locator('[data-pane=p1] [data-testid=status-line]').innerText())
      .replace(/\s+/g, ' ')
      .trim();
    // The chart being worked in takes the TRADE's instrument, not whatever it
    // happened to be showing: a reconstruction on the wrong symbol is a lie.
    const symbol = (await page.locator('.journal-trades > li.expanded .journal-trade-head').innerText())
      .replace(/\s+/g, ' ')
      .match(/\b(NQ|MNQ|ES|MES|GC|MGC|CL|MCL|YM|RTY)\b/)?.[1];
    say(
      symbol !== undefined && status.startsWith(symbol),
      'which puts the chart on the instrument that trade was taken on',
      `trade in ${symbol ?? '?'}, chart shows ${status.slice(0, 30)}`,
    );
  }
  await shot(page, 'journal-day-trades');

  await page.locator('[data-testid=journal-day-filter] button').click();
  await page.waitForTimeout(900);
  say(
    (await page.locator('[data-testid=journal-day-filter]').count()) === 0 &&
      (await page.locator('.journal-trades > li').count()) >= rows,
    'and the whole list comes back',
  );

  /*
   * Put the chart back on NQ.
   *
   * Recalling a trade changes the chart's instrument - that is the feature -
   * and the suites that follow draw on whatever the terminal is showing. A
   * suite that leaves the terminal somewhere else is a suite that makes the
   * next one's screenshots confusing.
   */
  await page.click('[data-testid=drawer-journal] .drawer-close').catch(() => {});
  await page.waitForTimeout(600);
  await page.click('[data-pane=p1] .chdr-symbol');
  await page.waitForTimeout(500);
  await page.click('.popover .pop-item:has(.chdr-pop-root:text-is("NQ"))');
  await page.waitForTimeout(3_000);

  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  await browser.close();
}

process.exit(finish());
