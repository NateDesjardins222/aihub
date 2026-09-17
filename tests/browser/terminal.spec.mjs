/**
 * The terminal: what was removed, what replaced it, and the order workflow.
 *
 * The removals are asserted as strongly as the additions. A redesign that
 * leaves the old controls behind is not a redesign, and a test that only
 * checks the new ones would not notice.
 */
import { createReport, launch, reset, shot, signIn, useAccount } from './harness.mjs';

const { say, finish } = createReport('terminal');
const { browser, page, errors } = await launch();

try {
  await signIn(page);
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
  const slack = (column?.height ?? 0) - (ticket?.height ?? 0);
  say(slack < 280, 'no enormous blank area below the ticket', `${Math.round(slack)}px of slack`);
  const quote = ((await page.textContent('[data-testid=quote-block]')) ?? '').replace(/\s+/g, ' ');
  say(/no bid\/ask on this feed/.test(quote), 'bid and ask are not fabricated', quote.slice(0, 60));

  // --- order, marker, bracket ---------------------------------------------
  // Wide levels: this is a live delayed feed and NQ can travel ten points while
  // the test is typing, which would fill a close stop mid-run.
  await page.fill('#tk-sl', '400');
  await page.fill('#tk-tp', '600');
  await page.click('.tk-modes .tk-chip:text-is("Manual")');
  await page.click('.tk-chip:text-is("2")');
  await page.click('[data-testid=buy]');
  await page.waitForTimeout(6_000);

  const position = ((await page.textContent('[data-testid=ticket-position]')) ?? '').replace(/\s+/g, ' ');
  say(/LONG 2/.test(position), 'a market order opens a position', position.slice(0, 50));
  say((await page.locator('[data-marker=position]').count()) === 1, 'the position marker appears');
  say(
    (await page.locator('[data-marker=stop], [data-marker=target]').count()) === 0,
    'NO protective line appears merely because bracket mode is on',
  );

  await page.click('[data-testid=marker-position] .pm-act:text-is("+SL")');
  await page.waitForTimeout(4_000);
  say((await page.locator('[data-marker=stop]').count()) === 1, '+SL on the position marker creates a stop');
  await page.click('[data-testid=marker-position] .pm-act:text-is("+TP")');
  await page.waitForTimeout(4_000);
  say((await page.locator('[data-marker=target]').count()) === 1, '+TP on the position marker creates a target');

  await page.click('.tab:text-is("Orders")');
  await page.waitForTimeout(1_500);
  const orders = ((await page.textContent('.panel-body')) ?? '').replace(/\s+/g, ' ');
  say(
    /STOP LOSS/.test(orders) && /TAKE PROFIT/.test(orders),
    'both legs are real working orders on the server',
    orders.slice(0, 140),
  );
  await page.click('.tab:text-is("Positions")');
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
  say(!overlap && labels.length >= 3, 'no two marker labels overlap', `${labels.length} labels`);

  // --- dragging changes the AUTHORITATIVE order ----------------------------
  const tag = page.locator('[data-testid=marker-stop]');
  const before = ((await page.locator('[data-testid=marker-stop] .pm-price').textContent()) ?? '').trim();
  const box = await tag.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(4_500);
  const after = ((await page.locator('[data-testid=marker-stop] .pm-price').textContent()) ?? '').trim();
  say(before !== after, 'dragging a stop moves it', `${before} -> ${after}`);

  await page.click('.tab:text-is("Orders")');
  await page.waitForTimeout(1_500);
  const afterOrders = ((await page.textContent('.panel-body')) ?? '').replace(/\s+/g, ' ');
  say(afterOrders.includes(after), 'the dragged price is the price the server holds', after);
  await page.click('.tab:text-is("Positions")');

  // --- close up ------------------------------------------------------------
  await page.click('.tk-grid2 button:has-text("Close position")');
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
