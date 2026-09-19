/**
 * The two ways a terminal loses a trader's trust in a single click.
 *
 * ONE: it sends the order twice. A double click, a button pressed together
 * with its hotkey, a touch that fired both events - all of them are one
 * intention, and a platform that turns them into two contracts has taken a
 * position the trader did not ask for. Atlas keys its idempotency on the
 * client order id, and the ticket used to mint a NEW one for every click,
 * throwing away the one mechanism that could have stopped it.
 *
 * TWO: it shows the wrong account's money. Six authoritative reads are in
 * flight when the trader switches accounts; they come back afterwards and used
 * to be written whatever account was on screen by then.
 *
 * Both are proved here against the real server, and both are proved NOT to
 * have been fixed by making Atlas slow or lossy: a deliberate second press,
 * after the first is acknowledged, must still be a second order, because that
 * is how a trader scales into a position.
 */
import {
  apiFetch,
  createReport,
  launch,
  signIn,
  tradableMarket,
  useAccount,
  useSymbol,
} from './harness.mjs';

const { say, finish, watch } = createReport('execution-safety');
const { browser, page, errors } = await launch({ width: 1600, height: 950 });
watch(page);

/** Every order this account holds, newest first. */
async function orders(accountId) {
  const result = await apiFetch(page, `/api/v1/orders?accountId=${accountId}`);
  return result?.body?.orders ?? [];
}

async function positionQty(accountId, symbol) {
  const result = await apiFetch(page, `/api/v1/positions?accountId=${accountId}`);
  const found = (result?.body?.positions ?? []).find((p) => p.symbol === symbol);
  return found ? Math.abs(found.qty) : 0;
}

/**
 * The id of the account the terminal is attached to, read from the control
 * that chooses it. Accounts are allowed to share a name, so the id is the only
 * thing that identifies one.
 */
const currentAccountId = () => page.inputValue('.abar-account');

async function flatten(accountId, symbol) {
  await apiFetch(page, '/api/v1/orders/cancel-all', { method: 'POST', body: { accountId } });
  await apiFetch(page, `/api/v1/positions/${symbol}/flatten`, {
    method: 'POST',
    body: { accountId },
  });
}

try {
  await signIn(page);
  await useSymbol(page, 'NQ');
  await useAccount(page, 'Practice 150K');

  const market = await tradableMarket(page);
  say(true, `the checks run against the ${market.mode} market`);

  const accountId = await currentAccountId();
  say(Boolean(accountId), 'the terminal knows which account it is trading', accountId ?? 'none');

  await flatten(accountId, 'NQ');
  await market.fill();
  await page.click('.tk-preset:text-is("1")');
  await page.waitForTimeout(600);

  // --- one intention, one order -------------------------------------------
  const before = (await orders(accountId)).length;
  await page.dblclick('[data-testid=buy]');
  await market.fill();
  await page.waitForTimeout(1_500);
  const afterDouble = await orders(accountId);
  const sentByDoubleClick = afterDouble.length - before;
  say(
    sentByDoubleClick === 1,
    'a double click on BUY sends ONE order',
    `${sentByDoubleClick} order(s) created`,
  );
  const qtyAfterDouble = await positionQty(accountId, 'NQ');
  say(
    qtyAfterDouble <= 1,
    'and the position is the size that was asked for',
    `${qtyAfterDouble} contract(s)`,
  );

  await flatten(accountId, 'NQ');
  await market.fill();
  await page.waitForTimeout(1_200);

  // --- a button and its keyboard, together --------------------------------
  /*
   * Two events dispatched in the same task, which is the hardest case: there
   * is no gap for a React state update to land in, so a guard that lives in
   * component state cannot help. The guard that does is a synchronous map of
   * intents in flight.
   */
  const beforeBoth = (await orders(accountId)).length;
  await page.evaluate(() => {
    const buy = document.querySelector('[data-testid=buy]');
    buy?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    buy?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    buy?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await market.fill();
  await page.waitForTimeout(1_500);
  const sentByThree = (await orders(accountId)).length - beforeBoth;
  say(
    sentByThree === 1,
    'three clicks dispatched in one task send ONE order',
    `${sentByThree} order(s) created`,
  );

  await flatten(accountId, 'NQ');
  await market.fill();
  await page.waitForTimeout(1_200);

  // --- and a deliberate second press is still a second order --------------
  const beforeTwo = (await orders(accountId)).length;
  await page.click('[data-testid=buy]');
  await page.waitForTimeout(1_400);
  await market.fill();
  await page.click('[data-testid=buy]');
  await page.waitForTimeout(1_400);
  await market.fill();
  await page.waitForTimeout(1_200);
  const sentByTwo = (await orders(accountId)).length - beforeTwo;
  say(
    sentByTwo === 2,
    'two deliberate presses are still two orders - scaling in is not a bug',
    `${sentByTwo} order(s) created`,
  );
  const scaled = await positionQty(accountId, 'NQ');
  say(scaled === 2, 'and the position carries both', `${scaled} contract(s)`);

  await flatten(accountId, 'NQ');
  await market.fill();
  await page.waitForTimeout(1_500);

  // --- the pending row ----------------------------------------------------
  /*
   * What the terminal says while it is waiting. It must not say "filled" -
   * only the server can say that - and it must disappear once the answer
   * arrives rather than becoming a second, fainter version of the truth.
   */
  await page.route('**/api/v1/orders', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await route.continue().catch(() => undefined);
  });
  await page.click('[data-testid=buy]');
  await page.waitForTimeout(900);
  const pending = await page.locator('[data-testid=ticket-pending]').count();
  const pendingText = pending
    ? ((await page.textContent('[data-testid=ticket-pending]')) ?? '').replace(/\s+/g, ' ').trim()
    : '';
  say(pending === 1, 'a submission in flight is shown as in flight', pendingText);
  say(
    /sending/i.test(pendingText) && !/fill/i.test(pendingText),
    'and it says it is sending rather than claiming a fill',
    pendingText,
  );
  await page.unroute('**/api/v1/orders');
  await market.fill();
  await page.waitForTimeout(2_500);
  say(
    (await page.locator('[data-testid=ticket-pending]').count()) === 0,
    'and it is gone once the server has answered',
  );

  await flatten(accountId, 'NQ');
  await market.fill();

  // --- the answer to a question nobody is asking any more -----------------
  /*
   * Account A's authoritative read is deliberately held, the trader switches
   * to account B, and the read lands afterwards. Account B must be untouched.
   */
  const accounts = await apiFetch(page, '/api/v1/accounts');
  const list = accounts?.body?.accounts ?? [];
  const other = list.find((a) => a.id !== accountId);
  say(Boolean(other), 'there is a second account to switch to', other?.name ?? 'none');

  if (other) {
    // Open a position on A so its state is distinctive.
    await page.click('[data-testid=buy]');
    await market.fill();
    await page.waitForTimeout(1_500);
    const onA = await positionQty(accountId, 'NQ');
    say(onA >= 1, 'account A holds a position', `${onA} contract(s)`);

    // Hold every positions read for three seconds, then switch.
    await page.route('**/api/v1/positions**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.continue().catch(() => undefined);
    });
    // By id, not by name: accounts are allowed to share a name, and this check
    // is worthless if it "switches" to the account it is already on.
    await page.selectOption('.abar-account', other.id);
    await page.waitForTimeout(5_000);
    await page.unroute('**/api/v1/positions**');
    await page.waitForTimeout(2_000);

    const shown = ((await page.textContent('[data-testid=ticket-position]')) ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const bQty = await positionQty(other.id, 'NQ');
    say(
      bQty === 0 ? /No active position/.test(shown) : /LONG|SHORT/.test(shown),
      "the terminal shows the NEW account's position, not the old one's",
      `server says ${bQty}, screen says "${shown.slice(0, 40)}"`,
    );

    const blotter = ((await page.textContent('.panel-body')) ?? '').replace(/\s+/g, ' ');
    say(
      bQty === 0 ? /No open positions/i.test(blotter) : true,
      'and the blotter agrees with it',
      blotter.slice(0, 60),
    );

    // Put things back.
    await page.selectOption('.abar-account', accountId);
    await page.waitForTimeout(1_500);
    await flatten(accountId, 'NQ');
    await market.fill();
    await page.waitForTimeout(1_500);
    say((await positionQty(accountId, 'NQ')) === 0, 'account A is left flat', 'cleanup');
  }

  say(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

process.exit(finish());
