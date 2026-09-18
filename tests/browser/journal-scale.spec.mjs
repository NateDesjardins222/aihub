/**
 * A journal with a career in it.
 *
 * Eleven trades prove the calendar renders. They prove nothing about the
 * trader who has been at this for two years: two thousand trades, three
 * hundred trading days, a month that has to be paged back through and a list
 * that has to be scrolled. The brief asks for "hundreds, then thousands", and
 * for the answer to be a number rather than an impression.
 *
 * The fixture is written straight into the database, because two thousand
 * trades placed through the engine would measure the engine. They are marked
 * so they can be taken out again, and they are taken out again: the suites
 * share one account and a stress fixture that outlives its test is a lie in
 * everybody else's results.
 */
import { execFileSync } from 'node:child_process';
import { createReport, launch, shot, signIn } from './harness.mjs';

const { say, finish, watch } = createReport('journal-scale');
const { browser, page, errors } = await launch({ width: 1680, height: 1000 });
watch(page);

const DB = process.env.DATABASE_URL ?? 'postgres://atlas:atlas@localhost:5432/atlas';
const MARK = 'journal-scale fixture';
const TRADES = 2_000;

const sql = (text) =>
  execFileSync('psql', [DB, '-t', '-A', '-c', text], { encoding: 'utf8' }).trim();

/**
 * The account the fixture goes into.
 *
 * Chosen from what the TERMINAL offers rather than from what the database
 * holds: two accounts can share a name, and one that is not in this trader's
 * dropdown cannot be reviewed however many trades are written into it. Empty,
 * so nobody else's checks are reading it.
 */
async function pickAccount() {
  const options = await page
    .locator('.abar-account option')
    .evaluateAll((nodes) => nodes.map((n) => ({ id: n.value, name: n.textContent?.trim() ?? '' })));
  for (const option of options) {
    const held = Number(sql(`select count(*) from trades where account_id = '${option.id}'::uuid`));
    if (held === 0) return option;
  }
  return options[options.length - 1] ?? null;
}

function seed(accountId, count) {
  /*
   * Spread over eighteen months, five days a week.
   *
   * A journal's work is grouping by day and by month, so a fixture that put
   * every trade on one day would exercise none of it. The prices and the P&L
   * are arithmetic rather than random: a fixture that changes between runs
   * cannot be compared between runs.
   */
  const started = Date.now();
  sql(`
    insert into trades (
      account_id, symbol, side, qty,
      entry_ticks_scaled, exit_ticks_scaled,
      entry_time, exit_time,
      gross_pnl_micros, fees_micros, net_pnl_micros,
      mae_micros, mfe_micros, initial_risk_micros,
      notes, trade_date
    )
    select
      '${accountId}'::uuid,
      (array['NQ','ES','CL','GC'])[1 + (n % 4)],
      case when n % 3 = 0 then 'SHORT' else 'LONG' end,
      1 + (n % 4),
      (1190000 + (n % 400))::bigint * 1000000,
      (1190000 + (n % 400) + ((n % 17) - 8))::bigint * 1000000,
      d + interval '9 hours' + (n % 300) * interval '1 minute',
      d + interval '9 hours' + (n % 300) * interval '1 minute' + interval '12 minutes',
      ((n % 21) - 10)::bigint * 25000000,
      -2500000::bigint,
      ((n % 21) - 10)::bigint * 25000000 - 2500000,
      -1::bigint * ((n % 7) + 1) * 12500000,
      ((n % 9) + 1)::bigint * 12500000,
      125000000::bigint,
      '${MARK}',
      d::date
    from (
      select
        n,
        (current_date - ((n / 7) || ' days')::interval) as d
      from generate_series(0, ${count - 1}) as n
    ) rows
    where extract(dow from d) between 1 and 5
  `);
  const made = Number(sql(`select count(*) from trades where notes = '${MARK}'`));
  return { made, ms: Date.now() - started };
}

function cleanUp() {
  sql(`delete from trades where notes = '${MARK}'`);
}

/** How long a click takes to show its result, and what it cost in frames. */
async function timed(action) {
  const started = Date.now();
  await action();
  return Date.now() - started;
}

let account = null;
try {
  await signIn(page);
  await page.waitForTimeout(2_500);
  account = await pickAccount();
  say(Boolean(account?.id), 'there is an account to fill', `${account?.name}`);
  const seeded = seed(account.id, TRADES);
  say(seeded.made > 1_000, 'a career of trades is written', `${seeded.made} trades in ${seeded.ms}ms`);

  await page.selectOption('.abar-account', account.id);
  await page.waitForTimeout(3_500);

  // --- opening it ----------------------------------------------------------
  const openMs = await timed(async () => {
    await page.click('[data-testid=apprail-journal]');
    await page.waitForSelector('[data-testid=calendar-grid]', { timeout: 30_000 });
  });
  await page.waitForTimeout(2_000);
  say(openMs < 4_000, 'the journal opens on a calendar, not on a spinner', `${openMs}ms`);

  /*
   * Only the TRADED days carry a test id, because only they are buttons. What
   * matters at this scale is that the month is full of them: a partial month
   * has as many traded days as it has had weekdays so far.
   */
  const shown = await page.locator('[data-testid=calendar-day]').count();
  const cells = await page.locator('[data-testid=calendar-grid] .cal-cell').count();
  say(shown >= 10 && cells >= 35, 'the month is drawn and full of traded days', `${shown} traded of ${cells} cells`);
  const total = await page.locator('[data-testid=calendar-total]').innerText();
  say(/trade/.test(total), 'and the month carries its own totals', total.replace(/\s+/g, ' '));
  await shot(page, 'journal-scale-calendar');

  // --- paging back through the year ---------------------------------------
  const backs = [];
  const monthsBack = Number(
    sql(
      `select greatest(1, count(distinct date_trunc('month', trade_date)) - 1)
         from trades where notes = '${MARK}'`,
    ),
  );
  for (let i = 0; i < Math.min(12, monthsBack); i += 1) {
    backs.push(
      await timed(async () => {
        await page.click('[aria-label="Previous month"]');
        await page.waitForTimeout(120);
      }),
    );
  }
  const slowest = Math.max(...backs);
  const median = [...backs].sort((a, b) => a - b)[Math.floor(backs.length / 2)];
  say(slowest < 1_200, `${backs.length} months page back without a stall`, `median ${median}ms, worst ${slowest}ms`);

  const oldMonth = await page.locator('[data-testid=calendar-month]').innerText();
  const oldTotal = await page.locator('[data-testid=calendar-total]').innerText();
  say(
    /\d/.test(oldTotal),
    'and the oldest month still has its figures',
    `${oldMonth}: ${oldTotal.replace(/\s+/g, ' ')}`,
  );

  for (let i = 0; i < backs.length; i += 1) {
    await page.click('[aria-label="Next month"]');
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(600);

  // --- the list of every trade --------------------------------------------
  const listMs = await timed(async () => {
    await page.click('.journal-tabs .chip:has-text("Trades")');
    await page.waitForSelector('.journal-trades li', { timeout: 30_000 });
  });
  await page.waitForTimeout(1_200);
  const rows = await page.locator('.journal-trades li').count();
  say(listMs < 4_000, 'the trade list opens quickly at this size', `${listMs}ms, ${rows} rows`);

  /*
   * The list is paged, and it says so.
   *
   * It asked for five hundred and showed five hundred with nothing to suggest
   * there were another nine hundred behind them - a trader scrolling to the
   * bottom of what looked like their whole history.
   */
  const held = Number(sql(`select count(*) from trades where notes = '${MARK}'`));
  const notice = page.locator('[data-testid=journal-more]');
  say(
    (await notice.count()) === 1,
    'and says so when it is not showing everything',
    `${rows} of ${held} trades`,
  );
  if ((await notice.count()) === 1) {
    const grew = await timed(async () => {
      await notice.locator('button').click();
      await page.waitForTimeout(1_200);
    });
    const after = await page.locator('.journal-trades li').count();
    say(after > rows, 'and loading more actually loads more', `${rows} → ${after} in ${grew}ms`);
  }

  const scroll = await page.evaluate(async () => {
    const list = document.querySelector('.journal-body');
    if (!list) return null;
    const frames = [];
    let last = performance.now();
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    for (let i = 0; i < 40; i += 1) {
      list.scrollTop += 240;
      await new Promise((resolve) => setTimeout(resolve, 24));
    }
    cancelAnimationFrame(raf);
    frames.sort((a, b) => a - b);
    return {
      p50: Math.round(frames[Math.floor(frames.length / 2)] ?? 0),
      p95: Math.round(frames[Math.floor(frames.length * 0.95)] ?? 0),
      worst: Math.round(frames[frames.length - 1] ?? 0),
      over50: frames.filter((f) => f > 50).length,
      scrolled: Math.round(list.scrollTop),
    };
  });
  say(
    scroll !== null && scroll.over50 <= 2,
    'and it scrolls without stalling',
    JSON.stringify(scroll),
  );

  // --- a single day out of the pile ---------------------------------------
  await page.click('.journal-tabs .chip:has-text("Calendar")');
  await page.waitForTimeout(1_200);
  const busy = page.locator('[data-testid=calendar-day]:has(.cal-pnl)').first();
  const dayMs = await timed(async () => {
    await busy.click();
    await page.waitForTimeout(400);
  });
  const filtered = await page.locator('[data-testid=journal-day-filter]').count();
  say(filtered === 1 && dayMs < 2_500, 'clicking a day still narrows to that day', `${dayMs}ms`);
  const dayRows = await page.locator('.journal-trades li').count();
  say(dayRows > 0 && dayRows < 60, 'and shows that day rather than the year', `${dayRows} trades`);

  // --- the statistics over two thousand trades -----------------------------
  const statsMs = await timed(async () => {
    await page.click('.journal-tabs .chip:has-text("Overview")').catch(async () => {
      await page.click('.journal-tabs .chip').catch(() => {});
    });
    await page.waitForTimeout(600);
  });
  say(statsMs < 4_000, 'the overview computes over the whole history in time', `${statsMs}ms`);

  say(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 200));
} finally {
  try {
    cleanUp();
    const left = Number(sql(`select count(*) from trades where notes = '${MARK}'`));
    say(left === 0, 'the fixture is taken out again', `${left} left behind`);
  } catch (err) {
    say(false, 'the fixture is taken out again', String(err).slice(0, 120));
  }
  await browser.close();
}

process.exit(finish());
