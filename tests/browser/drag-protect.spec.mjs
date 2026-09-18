/**
 * Pulling a stop or a target off the position marker.
 *
 * All four directional cases, plus modification, cancellation and execution.
 * Run inside a REPLAY so the market can be held still between steps: on a live
 * feed NQ can travel ten points while the test is dragging, and the assertion
 * would be about timing rather than about the gesture.
 *
 * Nothing here is graphical. Every assertion about a level is checked against
 * the working ORDER the server holds.
 */
import { createReport, launch, shot, signIn, useAccount, useSymbol, waitFor } from './harness.mjs';

const { say, finish, watch } = createReport('drag-protect');
const { browser, page, errors } = await launch();
watch(page);


const positionText = async () =>
  ((await page.textContent('[data-testid=ticket-position]')) ?? '').replace(/\s+/g, ' ');

const orderText = async () => {
  await page.click('.tab:text-is("Orders")');
  await page.waitForTimeout(1200);
  return ((await page.textContent('.panel-body')) ?? '').replace(/\s+/g, ' ');
};

/** Drag from the position marker by a number of pixels; up is negative. */
async function dragOffMarker(dy) {
  const marker = await page.locator('[data-testid=marker-position]').boundingBox();
  const from = { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Several steps so the threshold is crossed and the preview is live.
  await page.mouse.move(from.x - 60, from.y + dy / 2, { steps: 6 });
  await page.mouse.move(from.x - 60, from.y + dy, { steps: 6 });
  const preview = await page.locator('[data-testid=marker-preview]').count();
  await page.mouse.up();
  await page.waitForTimeout(3500);
  return preview;
}

/** Drag from the position marker to an absolute page y. */
async function dragToY(y) {
  const marker = await page.locator('[data-testid=marker-position]').boundingBox();
  const from = { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const half = from.y + (y - from.y) / 2;
  await page.mouse.move(from.x - 60, half, { steps: 6 });
  await page.mouse.move(from.x - 60, y, { steps: 6 });
  const preview = await page.locator('[data-testid=marker-preview]').count();
  await page.mouse.up();
  await page.waitForTimeout(3500);
  return preview;
}

/**
 * The price the POSITION is marked at.
 *
 * Not the chart's last close, which can be a few ticks away from it while a
 * paused replay is being stepped - and a few ticks is a long way once the
 * chart is zoomed in. Which leg a drag creates is decided against the mark, so
 * the mark is what the gesture is aimed at.
 */
async function markPrice() {
  await page.click('.tab:text-is("Positions")');
  await page.waitForTimeout(500);
  const cell = ((await page.locator('.data-table tbody tr td').nth(4).textContent()) ?? '').trim();
  const value = Number(cell.replace(/,/g, ''));
  if (!Number.isFinite(value)) throw new Error(`no mark price in the blotter: ${cell}`);
  return value;
}

/** Where a price sits on the page, in absolute pixels. */
async function priceY(price) {
  const box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
  const y = await page.evaluate((p) => window.__atlasChartView?.(undefined, p)?.yAtPrice ?? null, price);
  if (y === null) throw new Error(`the chart cannot place ${price}`);
  return box.y + y;
}

/** Advance the paused replay by one market event. */
async function step() {
  await page.click('.abar-icon[aria-label=Practice]');
  await page.waitForTimeout(700);
  await page.click('.practice-row .chip:has-text("Step")');
  await page.waitForTimeout(800);
  await page.click('[data-testid=drawer-practice] .drawer-close');
  await page.waitForTimeout(600);
}

/** Step until the position text satisfies `until`, or give up. */
async function stepUntil(until, tries = 14) {
  for (let i = 0; i < tries; i += 1) {
    if (until(await positionText())) return true;
    await step();
  }
  return until(await positionText());
}

/**
 * Close out and cancel.
 *
 * The replay is paused, so a market order placed to close does not fill until
 * the market moves: the helper steps it until the position is actually gone.
 */
async function flatten() {
  const close = page.locator('.tk-grid2 button:has-text("Close")');
  if (await close.isEnabled().catch(() => false)) {
    await close.click();
    await page.waitForTimeout(1500);
    await stepUntil((text) => /No active position/.test(text));
  }
  const cancel = page.locator('.tk-grid2 button:has-text("Cancel orders")');
  if (await cancel.isEnabled().catch(() => false)) {
    await cancel.click();
    await page.waitForTimeout(2000);
  }
}

/** Open a position in a paused replay by stepping until the entry fills. */
async function openPosition(side) {
  await page.click(`[data-testid=${side}]`);
  await page.waitForTimeout(1200);
  const want = side === 'buy' ? /LONG/ : /SHORT/;
  return stepUntil((text) => want.test(text));
}

try {
  await signIn(page);
  // This suite trades NQ, so the ticket has to be pointed at NQ.
  await useSymbol(page, 'NQ');
  await useAccount(page, 'Practice 150K');

  // --- a replay, paused ----------------------------------------------------
  await page.click('.abar-icon[aria-label=Practice]');
  await page.waitForSelector('[data-testid=drawer-practice]', { timeout: 15_000 });
  await page.waitForTimeout(2500);
  if (await page.locator('.practice-active').count()) {
    await page.click('.practice-active .chip');
    await page.waitForTimeout(6000);
  }
  await page.locator('.practice-session').first().click();
  await page.waitForTimeout(9000);
  await page.click('.practice-row .chip:has-text("Restart")');
  await page.waitForTimeout(2500);
  await page.click('.practice-row .chip:has-text("+30")');
  await page.waitForTimeout(3000);
  await page.click('[data-testid=drawer-practice] .drawer-close');
  await page.waitForTimeout(800);
  say(true, 'a paused replay is loaded');

  await flatten();
  await page.click('.tk-preset:text-is("1")');

  // ===== LONG ==============================================================
  say(await openPosition('buy'), 'a long position opens', await positionText());

  const pnlOnly = ((await page.textContent('[data-testid=marker-position]')) ?? '').replace(/\s+/g, ' ');
  say(
    /^[+−-]?\$[\d,.]+/.test(pnlOnly.trim()),
    'the position marker leads with the open P&L',
    pnlOnly.slice(0, 40),
  );
  say(!/LONG|SHORT/.test(pnlOnly), 'it does not carry the side, the entry price or +SL/+TP', pnlOnly.slice(0, 40));

  // Drag UP on a long -> take profit.
  const previewUp = await dragOffMarker(-140);
  say(previewUp === 1, 'a live preview line follows the drag');
  say((await page.locator('[data-marker=target]').count()) === 1, 'dragging above a long creates a TARGET');
  let orders = await orderText();
  say(/TAKE PROFIT/.test(orders) && /SELL/.test(orders), 'it exists as a working SELL limit on the server', orders.slice(0, 120));

  // Drag DOWN on a long -> stop loss.
  await page.click('.tab:text-is("Positions")');
  await dragOffMarker(140);
  say((await page.locator('[data-marker=stop]').count()) === 1, 'dragging below a long creates a STOP');
  orders = await orderText();
  say(/STOP LOSS/.test(orders), 'the stop exists on the server too');
  await page.click('.tab:text-is("Positions")');

  // Modify: drag the stop further away and check the server followed.
  const before = ((await page.locator('[data-testid=marker-stop] .pm-price').textContent()) ?? '').trim();
  const stopBox = await page.locator('[data-testid=marker-stop]').boundingBox();
  await page.mouse.move(stopBox.x + stopBox.width / 2, stopBox.y + stopBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(stopBox.x + stopBox.width / 2, stopBox.y + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(3500);
  const after = ((await page.locator('[data-testid=marker-stop] .pm-price').textContent()) ?? '').trim();
  say(before !== after, 'dragging the stop moves it', `${before} -> ${after}`);
  orders = await orderText();
  say(orders.includes(after), 'the moved price is the price the server holds', after);
  await page.click('.tab:text-is("Positions")');

  // Cancel the target from its own label.
  await page.click('[data-testid=marker-target] .pm-act-close');
  await page.waitForTimeout(3500);
  say((await page.locator('[data-marker=target]').count()) === 0, 'the target cancels from its label');
  say((await page.locator('[data-marker=stop]').count()) === 1, 'cancelling one leg leaves the other working');

  await shot(page, 'drag-protect-long');
  await flatten();

  // ===== SHORT =============================================================
  say(await openPosition('sell'), 'a short position opens', await positionText());

  // Drag DOWN on a short -> take profit.
  await dragOffMarker(140);
  say((await page.locator('[data-marker=target]').count()) === 1, 'dragging below a short creates a TARGET');

  // Drag UP on a short -> stop loss.
  await dragOffMarker(-140);
  say((await page.locator('[data-marker=stop]').count()) === 1, 'dragging above a short creates a STOP');
  orders = await orderText();
  say(/STOP LOSS/.test(orders) && /BUY/.test(orders), 'a short is protected by BUY orders', orders.slice(0, 120));
  await page.click('.tab:text-is("Positions")');
  await shot(page, 'drag-protect-short');

  // ===== EXECUTION =========================================================
  // A fresh position with ONE level, dragged close enough that the replay
  // reaches it: the earlier levels are a hundred points away, which is the
  // right place for them and the wrong place for this assertion.
  await flatten();

  // Zoom in first. The price scale follows the bars in view, so on a tight
  // view a few pixels is a few ticks - which is where a stop has to be for the
  // remaining recording to reach it.
  const plot = await page.locator('.chart-canvas').boundingBox();
  await page.mouse.move(plot.x + plot.width * 0.7, plot.y + plot.height * 0.5);
  /*
   * Eight notches, not fourteen.
   *
   * A wheel notch is a deliberate 9.4% of the visible range since the
   * navigation work; fourteen of them is nearly four times the zoom it used to
   * be, and at that scale the thirty pixels below the entry that this stop is
   * placed at is a tick or two - close enough that the replay reached it
   * between placing it and looking at it, and the check found no stop because
   * it had already filled.
   */
  for (let i = 0; i < 8; i += 1) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(1200);

  say(await openPosition('buy'), 'a fresh long for the execution check');

  /*
   * A STOP, created by the gesture and then moved to within a few points of
   * the market. At 100x the replay advances about one bar every 0.6s, so a
   * level twenty points away is not reached inside a test; a level a few
   * points away is reached almost at once.
   *
   * Both the release and the later move are measured from the MARKET, not from
   * the position marker. Which leg a drag creates is decided by which side of
   * the market it lands on - that is the engine's rule, and the chart follows
   * it - so a gesture anchored to the entry asks for a stop and gets a target
   * whenever the position happens to be underwater at that moment. The market
   * is the thing the answer depends on, so the gesture is aimed at it.
   */
  const previewClose = await dragToY((await priceY(await markPrice())) + 46);
  say(previewClose === 1, 'a stop previews');
  say((await page.locator('[data-marker=stop]').count()) === 1, 'the stop is created by the drag');

  const stopTag = await page.locator('[data-testid=marker-stop]').boundingBox();
  await page.mouse.move(stopTag.x + stopTag.width / 2, stopTag.y + stopTag.height / 2);
  await page.mouse.down();
  await page.mouse.move(stopTag.x + stopTag.width / 2, (await priceY(await markPrice())) + 6, {
    steps: 10,
  });
  await page.mouse.up();
  await page.waitForTimeout(3500);
  const level = ((await page.locator('[data-testid=marker-stop] .pm-price').textContent()) ?? '').trim();
  say(level.length > 0, 'the stop is moved next to the market', level);

  const tradesBefore = await (async () => {
    await page.click('.tab:text-is("Trades")');
    await page.waitForTimeout(1000);
    return (await page.locator('.data-table tbody tr').count()) ?? 0;
  })();
  await page.click('.tab:text-is("Positions")');

  await page.click('.abar-icon[aria-label=Practice]');
  await page.waitForTimeout(1200);
  await page.click('.practice-speeds .chip:text-is("100×")');
  await page.waitForTimeout(500);
  await page.click('.practice-row .chip:has-text("Play")');
  await page.waitForTimeout(500);
  await page.click('[data-testid=drawer-practice] .drawer-close');

  const closed = await waitFor(page, positionText, (t) => /No active position/.test(t), {
    tries: 60,
    every: 1_500,
  });
  say(closed.ok, 'the dragged level closes the position by itself', `level ${level}, after ~${closed.waitedMs / 1000}s`);

  orders = await orderText();
  say(
    new RegExp(`${level.replace('.', '\\.')}[^A-Za-z]*FILLED`).test(orders),
    'the fill is the dragged leg, at the price it was dragged to',
    orders.slice(0, 150),
  );

  await page.click('.tab:text-is("Trades")');
  await page.waitForTimeout(1200);
  const tradesAfter = await page.locator('.data-table tbody tr').count();
  say(tradesAfter > tradesBefore, 'a new round-trip was recorded', `${tradesBefore} -> ${tradesAfter}`);
  await shot(page, 'drag-protect-filled');

  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  try {
    await page.click('.abar-icon[aria-label=Practice]');
    await page.waitForTimeout(1500);
    if (await page.locator('.practice-active .chip').count()) {
      await page.click('.practice-active .chip');
      await page.waitForTimeout(6000);
    }
  } catch {
    /* the browser may already be gone */
  }
  await browser.close();
}

process.exit(finish());
