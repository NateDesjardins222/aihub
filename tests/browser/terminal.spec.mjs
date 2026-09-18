/**
 * The terminal: what was removed, what replaced it, and the order workflow.
 *
 * The removals are asserted as strongly as the additions. A redesign that
 * leaves the old controls behind is not a redesign, and a test that only
 * checks the new ones would not notice.
 */
import { createReport, launch, reset, shot, signIn, useAccount, useSymbol } from './harness.mjs';

const { say, finish, watch } = createReport('terminal');
const { browser, page, errors } = await launch();
watch(page);

try {
  await signIn(page);
  // This suite trades NQ, so the ticket has to be pointed at NQ.
  await useSymbol(page, 'NQ');
  await useAccount(page, 'Practice 150K');
  await reset(page);

  // --- removals ------------------------------------------------------------
  say((await page.locator('.chip:text-is("VOL")').count()) === 0, 'the VOL/LOG/RESET/NOW/PNG strip is gone');
  say((await page.locator('text=BUY MKT').count()) === 0, 'the second order toolbar above the chart is gone');
  say((await page.locator('.terminal-right .tab').count()) === 0, 'the Order/DOM/Risk/Practice/Replay/Sim tabs are gone');
  say((await page.locator('select.chart-type').count()) === 0, 'there is no Candles dropdown in the header');

  // --- the header ----------------------------------------------------------
  const header = await page.locator('.chdr').boundingBox();
  say((header?.height ?? 99) <= 30, 'the chart header is compact', `${header?.height}px tall`);
  const timeframes = await page.locator('.chdr-tf').allTextContents();
  say(timeframes.length >= 5, 'favourite timeframes are compact text controls', timeframes.join(' ').trim());
  const active = await page.locator('.chdr-tf-on').count();
  say(active === 1, 'exactly one interval is marked active');

  // A favourite can be added and removed, and the toolbar follows.
  await page.click('.chdr-tf-more');
  await page.waitForTimeout(400);
  await page.click('.chdr-tf-row:has(.pop-item:text-is("30m")) .chdr-fav');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const withThirty = await page.locator('.chdr-tf').allTextContents();
  say(withThirty.includes('30m'), 'favourite timeframes are configurable', withThirty.join(' ').trim());
  await page.click('.chdr-tf-more');
  await page.waitForTimeout(400);
  await page.click('.chdr-tf-row:has(.pop-item:text-is("30m")) .chdr-fav');
  await page.keyboard.press('Escape');

  // --- the ticket ----------------------------------------------------------
  const column = await page.locator('.terminal-right').boundingBox();
  say((column?.width ?? 999) <= 260, 'the order ticket is narrow', `${column?.width}px`);
  const ticket = await page.locator('.tk').boundingBox();
  // The ticket is COMPACT and anchored to the top. Measuring the space under it
  // stopped meaning anything once the ticket was stripped down - a short panel
  // with room under it is the intended shape; a tall panel padded out with gaps
  // was the problem.
  say(
    (ticket?.height ?? 999) < 430 && Math.abs((ticket?.y ?? 0) - (column?.y ?? 0)) < 40,
    'the ticket is compact and anchored to the top',
    `${Math.round(ticket?.height ?? 0)}px tall`,
  );

  // Nothing the brief asked to be removed is in it.
  const ticketText = ((await page.textContent('.tk')) ?? '').replace(/\s+/g, ' ');
  say(
    !/Last traded/.test(ticketText) &&
      !/no bid\/ask/.test(ticketText) &&
      !/Position bracket/.test(ticketText) &&
      !/Time in force/.test(ticketText) &&
      !/Round turn/.test(ticketText) &&
      !/Equity/.test(ticketText),
    'the ticket carries no quote block, bracket selector, time in force or fee table',
    ticketText.slice(0, 90),
  );
  say(
    (await page.locator('[data-testid=quote-block]').count()) === 0,
    'no bid/ask block: this feed has no book, and none is invented',
  );

  // --- order, marker, bracket ---------------------------------------------
  // Wide levels: this is a live delayed feed and NQ can travel ten points while
  // the test is typing, which would fill a close stop mid-run.
  await page.click('.tk-preset:text-is("3")');
  await page.click('[data-testid=buy]');
  await page.waitForTimeout(6_000);

  const position = ((await page.textContent('[data-testid=ticket-position]')) ?? '').replace(/\s+/g, ' ');
  say(/LONG 3/.test(position), 'a market order opens a position', position.slice(0, 50));
  say((await page.locator('[data-marker=position]').count()) === 1, 'the position marker appears');
  say(
    (await page.locator('[data-marker=stop], [data-marker=target]').count()) === 0,
    'NO protective line appears merely because bracket mode is on',
  );

  // Nothing protective is WORKING either: the ticket's cancel control is the
  // live count of working orders in this instrument.
  say(
    !(await page.locator('.tk-grid2 button:has-text("Cancel orders")').isEnabled()),
    'and there is nothing working on the server either',
  );
  await shot(page, 'terminal-position');


  // --- labels never stack --------------------------------------------------
  const labels = await page.locator('.pm-tag').evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }),
  );
  const sorted = labels.slice().sort((a, b) => a.top - b.top);
  let overlap = false;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].top < sorted[i - 1].bottom - 0.5) overlap = true;
  }
  say(!overlap, 'no two marker labels overlap', `${labels.length} labels`);

  // --- close up ------------------------------------------------------------
  await page.click('.tk-grid2 button:has-text("Close")');
  await page.waitForTimeout(5_000);
  const flat = ((await page.textContent('[data-testid=ticket-position]')) ?? '').replace(/\s+/g, ' ');
  say(/No active position/.test(flat), 'closing flattens the position');
  await page.waitForTimeout(2_500);
  say(
    (await page.locator('[data-marker=stop], [data-marker=target]').count()) === 0,
    'protection is cleaned up when the position closes',
  );

  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  await browser.close();
}

process.exit(finish());
