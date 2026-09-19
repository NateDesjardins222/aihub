/**
 * The execution surface, as a trader touches it.
 *
 * What this suite is about is the INTERACTION, not the arithmetic: the
 * arithmetic is the engine's and is covered by the server suites. Here:
 *
 *   - a level being dragged reads out its price, its distance in ticks and
 *     what it is worth, and all three follow the pointer rather than arriving
 *     after the release;
 *   - a right-click on a level offers what can be done to it, and each item
 *     ends in a real change on the server;
 *   - an ordinary modification asks for no confirmation;
 *   - the five things on the chart - position, stop, target, working order and
 *     a reviewed entry - are told apart by sight.
 *
 * Run inside a PAUSED replay so the market holds still between steps. On a
 * live feed NQ can travel while the test is dragging, and the assertions would
 * be about timing rather than about the gesture.
 */
import { createReport, launch, shot, signIn, useAccount, useSymbol } from './harness.mjs';

const { say, finish, watch } = createReport('execution-interaction');
const { browser, page, errors } = await launch();
watch(page);

const positionText = async () =>
  ((await page.textContent('[data-testid=ticket-position]')) ?? '').replace(/\s+/g, ' ');

const orderText = async () => {
  await page.click('.tab:text-is("Orders")');
  await page.waitForTimeout(1_200);
  const text = ((await page.textContent('.panel-body')) ?? '').replace(/\s+/g, ' ');
  await page.click('.tab:text-is("Positions")');
  return text;
};

/** Advance the paused replay by one market event. */
async function step() {
  await page.click('[data-testid=apprail-practice]');
  await page.waitForTimeout(700);
  await page.click('.practice-row .chip:has-text("Step")');
  await page.waitForTimeout(800);
  await page.click('[data-testid=drawer-practice] .drawer-close');
  await page.waitForTimeout(600);
}

async function stepUntil(until, tries = 14) {
  for (let i = 0; i < tries; i += 1) {
    if (until(await positionText())) return true;
    await step();
  }
  return until(await positionText());
}

async function flatten() {
  const close = page.locator('.tk-grid2 button:has-text("Close")');
  if (await close.isEnabled().catch(() => false)) {
    await close.click();
    await page.waitForTimeout(1_500);
    await stepUntil((text) => /No active position/.test(text));
  }
  const cancel = page.locator('.tk-grid2 button:has-text("Cancel orders")');
  if (await cancel.isEnabled().catch(() => false)) {
    await cancel.click();
    await page.waitForTimeout(2_000);
  }
}

async function openPosition(side) {
  await page.click(`[data-testid=${side}]`);
  await page.waitForTimeout(1_200);
  const want = side === 'buy' ? /LONG/ : /SHORT/;
  return stepUntil((text) => want.test(text));
}

/** Pull a protective level off the position marker. */
/**
 * How many pixels are worth `ticks` ticks on the chart right now.
 *
 * A pixel is not a distance in a market. This suite trades a PAUSED replay,
 * whose chart holds a handful of bars, so the price axis can be six points
 * tall - and the 120 pixels that are forty ticks on an ordinary chart become
 * four, which is close enough that the engine refuses the level or the market
 * is already through it. Asking the chart how tall a tick is makes the same
 * gesture mean the same thing on every view.
 */
async function pixelsForTicks(ticks, tickSize = 0.25) {
  const range = await page
    .evaluate(() => window.__atlasChartView?.()?.priceRange ?? null)
    .catch(() => null);
  const box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
  if (!range || !box || range <= 0) return ticks * 3; // a sane fallback
  const pixelsPerPoint = box.height / range;
  const wanted = ticks * tickSize * pixelsPerPoint;
  /*
   * ...but never further than the chart can show.
   *
   * Forty ticks is ten NQ points, and this replay's axis is six points tall:
   * asking for it drags the pointer off the plot entirely, and the level is
   * dropped somewhere the chart never saw. A third of the visible height is
   * far enough for the engine to accept the level and close enough that the
   * gesture stays on the chart.
   */
  return Math.max(24, Math.round(Math.min(wanted, box.height * 0.33)));
}

async function dragOffMarker(dy) {
  const marker = await page.locator('[data-testid=marker-position]').boundingBox();
  const from = { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 60, from.y + dy / 2, { steps: 6 });
  await page.mouse.move(from.x - 60, from.y + dy, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(3_500);
}

const read = async (selector) => ((await page.textContent(selector)) ?? '').trim();

/** Anything modal on screen. An ordinary modification must open none of these. */
const modals = () =>
  page.locator('.dp-scrim, .st-scrim, [role=dialog], [role=alertdialog]').count();

const rule = (marker) =>
  page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    const style = getComputedStyle(node);
    return `${style.borderTopColor}/${style.borderTopStyle}`;
  }, `[data-marker=${marker}] .pm-rule`);

try {
  await signIn(page);
  // This suite trades NQ, so the ticket has to be pointed at NQ.
  await useSymbol(page, 'NQ');
  await useAccount(page, 'Practice 150K');

  // --- a paused replay -----------------------------------------------------
  await page.click('[data-testid=apprail-practice]');
  await page.waitForSelector('[data-testid=drawer-practice]', { timeout: 15_000 });
  await page.waitForTimeout(2_500);
  if (await page.locator('.practice-active').count()) {
    await page.click('.practice-active .chip');
    await page.waitForTimeout(6_000);
  }
  await page.locator('.practice-session').first().click();
  await page.waitForTimeout(9_000);
  await page.click('.practice-row .chip:has-text("Restart")');
  await page.waitForTimeout(2_500);
  await page.click('.practice-row .chip:has-text("+30")');
  await page.waitForTimeout(3_000);
  await page.click('[data-testid=drawer-practice] .drawer-close');
  await page.waitForTimeout(800);
  say(true, 'a paused replay is loaded');

  await flatten();
  await page.click('.tk-preset:text-is("1")');

  // ===== 1. the readout on a dragged level =================================
  say(await openPosition('buy'), 'a long position opens', await positionText());
  const entryText = await read('.tk-pos-at');
  const entry = Number(entryText.replace(/[^0-9.]/g, ''));

  await dragOffMarker(120);
  say((await page.locator('[data-marker=stop]').count()) === 1, 'a stop is pulled off the marker');

  // Grab the stop and sample the three numbers MID-drag, without releasing.
  const stopBox = await page.locator('[data-testid=marker-stop]').boundingBox();
  const grab = { x: stopBox.x + stopBox.width / 2, y: stopBox.y + stopBox.height / 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x, grab.y + 30, { steps: 6 });
  await page.waitForTimeout(250);
  const first = {
    price: await read('[data-testid=marker-stop] .pm-price'),
    ticks: await read('[data-testid=marker-stop] .pm-ticks'),
    pnl: await read('[data-testid=marker-stop] .pm-pnl'),
  };
  await page.mouse.move(grab.x, grab.y + 90, { steps: 8 });
  await page.waitForTimeout(250);
  const second = {
    price: await read('[data-testid=marker-stop] .pm-price'),
    ticks: await read('[data-testid=marker-stop] .pm-ticks'),
    pnl: await read('[data-testid=marker-stop] .pm-pnl'),
  };
  const midDragModals = await modals();
  await shot(page, 'execution-dragging-stop');
  await page.mouse.up();
  await page.waitForTimeout(3_500);

  say(
    /^\d/.test(first.price) && /^[+-]\d+t$/.test(first.ticks) && /\$/.test(first.pnl),
    'a dragged level reads out price, ticks and dollars',
    `${first.price} / ${first.ticks} / ${first.pnl}`,
  );
  say(
    first.price !== second.price && first.ticks !== second.ticks && first.pnl !== second.pnl,
    'and all three update continuously while the pointer moves',
    `${first.ticks} ${first.pnl} -> ${second.ticks} ${second.pnl}`,
  );
  say(
    Number(second.price) < entry,
    'the stop on a long stays below the entry, where it was dragged',
    `entry ${entry}, stop ${second.price}`,
  );
  say(midDragModals === 0, 'nothing modal appears while dragging');

  /*
   * Read the price from the SERVER, not from the label.
   *
   * A protective label at rest carries its dollar P&L and nothing else - that
   * is the whole point of the redesign - so there is no price on it to compare
   * once the pointer is released. `second.price` is what the label showed at
   * the moment of release, which makes this a stronger claim than it was: the
   * price a trader reads while placing is the price the server ends up
   * holding.
   */
  const held = await orderText();
  say(
    second.price.length > 0 && held.includes(second.price),
    'the price shown while placing is the price the server holds',
    `${second.price} in ${held.slice(0, 90)}`,
  );
  const restingTag = ((await page.textContent('[data-testid=marker-stop]')) ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  say(
    /^[-\u2212+]?\$[\d,]+\.\d\d$/.test(restingTag),
    'and the label goes back to carrying only the dollars',
    restingTag,
  );

  // ===== 2. the menu on a protective level =================================
  await page.click('[data-testid=marker-stop]', { button: 'right' });
  await page.waitForSelector('[data-testid=order-context-menu]', { timeout: 4_000 });
  const stopMenu = ((await page.textContent('[data-testid=order-context-menu]')) ?? '').replace(
    /\s+/g,
    ' ',
  );
  say(/Stop loss/.test(stopMenu), 'right-clicking a stop names what was clicked', stopMenu.slice(0, 90));
  say(
    /Move stop to break even/.test(stopMenu) && /Remove stop loss/.test(stopMenu),
    'and offers the actions a stop has',
    stopMenu.slice(0, 140),
  );
  await shot(page, 'execution-stop-menu');

  await page.click('[data-testid=order-context-menu] button:has-text("Move stop to break even")');
  await page.waitForTimeout(3_500);
  // Again from the server: the resting label has no price on it to read.
  const beOrders = await orderText();
  say(
    beOrders.includes(String(entry)),
    'break even moves the real order to the entry price',
    `entry ${entry} in ${beOrders.slice(0, 110)}`,
  );

  await page.click('[data-testid=marker-stop]', { button: 'right' });
  await page.waitForTimeout(400);
  await page.click('[data-testid=order-context-menu] button:has-text("Remove stop loss")');
  await page.waitForTimeout(3_500);
  say((await page.locator('[data-marker=stop]').count()) === 0, 'and the menu can remove the stop');

  // ===== 2b. the menu on the position itself ==============================
  await page.click('[data-testid=marker-position]', { button: 'right' });
  await page.waitForSelector('[data-testid=order-context-menu]', { timeout: 4_000 });
  const positionMenu = ((await page.textContent('[data-testid=order-context-menu]')) ?? '').replace(
    /\s+/g,
    ' ',
  );
  say(
    /Close position at market/.test(positionMenu) &&
      /Reverse position/.test(positionMenu) &&
      /Remove stop and target/.test(positionMenu),
    'right-clicking the position offers what can be done to it',
    positionMenu.slice(0, 150),
  );
  // Dismissed rather than used: the rest of the suite needs this position.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  say(
    (await page.locator('[data-testid=order-context-menu]').count()) === 0,
    'and Escape closes the menu without doing anything',
    await positionText(),
  );
  say(/LONG/.test(await positionText()), 'the position is untouched by opening its menu');

  // ===== 3. the five things, told apart ====================================
  // Forty ticks either side, whatever the view happens to be showing.
  await dragOffMarker(-(await pixelsForTicks(40))); // a target above a long
  await dragOffMarker(await pixelsForTicks(40)); // and a stop below it
  const distinct = {
    position: await rule('position'),
    stop: await rule('stop'),
    target: await rule('target'),
  };
  say(
    Object.values(distinct).every(Boolean) &&
      new Set(Object.values(distinct)).size === Object.keys(distinct).length,
    'position, stop and target are drawn differently from each other',
    JSON.stringify(distinct),
  );
  await shot(page, 'execution-protected-position');

  // ===== 4. a working entry order ==========================================
  await flatten();
  await page.selectOption('#tk-type', 'LIMIT');
  // Forty points below a paused market: far enough that it rests rather than
  // filling, close enough to be on the chart.
  const resting = (entry - 40).toFixed(2);
  await page.fill('#tk-limit', resting);
  await page.click('[data-testid=buy]');
  await page.waitForTimeout(3_000);
  say(
    (await page.locator('[data-marker=order]').count()) === 1,
    'a limit order rests on the chart as a working order',
    resting,
  );
  const orderRule = await rule('order');
  say(
    orderRule !== distinct.position && orderRule !== distinct.stop && orderRule !== distinct.target,
    'and is drawn differently from a position and from protection',
    `${orderRule} vs ${JSON.stringify(distinct)}`,
  );

  // Drag it: a modification, with no confirmation anywhere.
  const orderBox = await page.locator('[data-testid=marker-order]').boundingBox();
  const beforeDrag = await read('[data-testid=marker-order] .pm-price');
  await page.mouse.move(orderBox.x + orderBox.width / 2, orderBox.y + orderBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(orderBox.x + orderBox.width / 2, orderBox.y + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(3_500);
  const afterDrag = await read('[data-testid=marker-order] .pm-price');
  say(beforeDrag !== afterDrag, 'dragging a working order moves it', `${beforeDrag} -> ${afterDrag}`);
  say((await modals()) === 0, 'an ordinary modification asks for no confirmation');
  const dragged = await orderText();
  say(dragged.includes(afterDrag), 'the server holds the dragged price', afterDrag);

  // The menu: quantity and cancel.
  await page.click('[data-testid=marker-order]', { button: 'right' });
  await page.waitForSelector('[data-testid=order-context-menu]', { timeout: 4_000 });
  const orderMenu = ((await page.textContent('[data-testid=order-context-menu]')) ?? '').replace(
    /\s+/g,
    ' ',
  );
  say(
    /Add one contract/.test(orderMenu) &&
      /Remove one contract/.test(orderMenu) &&
      /Cancel order/.test(orderMenu),
    'right-clicking a working order offers its options',
    orderMenu.slice(0, 160),
  );
  await shot(page, 'execution-order-menu');

  await page.click('[data-testid=order-context-menu] button:has-text("Add one contract")');
  await page.waitForTimeout(3_000);
  say(
    (await read('[data-testid=marker-order] .pm-qty')) === '2',
    'the quantity item modifies the order',
    await read('[data-testid=marker-order] .pm-qty'),
  );
  const resized = await orderText();
  // Matched on the order's OWN row - the table is a run of numbers once the
  // whitespace is gone, and a bare "2" in it could be anyone's.
  const row = new RegExp(`NQBUY2LIMIT${afterDrag.replace('.', '\\.')}WORKING`);
  say(row.test(resized), 'and the server holds the new quantity', resized.slice(0, 120));

  await page.click('[data-testid=marker-order]', { button: 'right' });
  await page.waitForTimeout(400);
  await page.click('[data-testid=order-context-menu] button:has-text("Cancel order")');
  await page.waitForTimeout(3_000);
  say((await page.locator('[data-marker=order]').count()) === 0, 'and the menu cancels it');
  const cancelled = await orderText();
  // The platform spells it CANCELED; the assertion accepts either spelling
  // rather than quietly testing one country's orthography.
  say(
    new RegExp(`NQBUY2LIMIT${afterDrag.replace('.', '\\.')}CANCELL?ED`, 'i').test(cancelled),
    'the cancel reached the server',
    cancelled.slice(0, 120),
  );

  // ===== 5. the ticket stays minimal ======================================
  const ticket = ((await page.textContent('[data-testid=order-ticket]')) ?? '').replace(/\s+/g, ' ');
  say(
    !/time in force|GTC|tick value|each tick/i.test(ticket),
    'the ticket carries no time-in-force, no tick-value explanation',
    ticket.slice(0, 160),
  );
  const types = await page.locator('#tk-type option').allTextContents();
  say(
    types.join('|') === 'Market|Limit|Stop market|Stop limit',
    'and offers exactly the four order types',
    types.join(' / '),
  );

  await page.selectOption('#tk-type', 'MARKET');
  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  try {
    await flatten();
    await page.click('[data-testid=apprail-practice]');
    await page.waitForTimeout(1_500);
    if (await page.locator('.practice-active .chip').count()) {
      await page.click('.practice-active .chip');
      await page.waitForTimeout(6_000);
    }
  } catch {
    /* the browser may already be gone */
  }
  await browser.close();
}

process.exit(finish());
