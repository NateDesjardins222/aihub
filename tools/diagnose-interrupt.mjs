/**
 * Pull the rug out at the worst possible moment.
 *
 *   node tools/diagnose-interrupt.mjs
 *
 * A trader's browser does not wait politely for a request to finish. Tabs are
 * reloaded, laptops sleep, wifi drops, and all of it happens while an order is
 * in flight - because that is when the trader is leaning on the machine.
 *
 * What is asserted is NOT that the order survives. Whether a request that was
 * cut off reached the server is genuinely unknown, and either answer is
 * legitimate. What must hold is that the two truths agree afterwards:
 *
 *   the terminal shows what the server has, and never anything else
 *
 * A ghost order in the blotter that the server does not have, or a position
 * the server holds and the screen does not, is the failure worth hunting -
 * because a trader who believes they are flat when they are not is the worst
 * thing this product can do to someone.
 */
import {
  apiFetch,
  createReport,
  launch,
  signIn,
  tradableMarket,
  useAccount,
  useSymbol,
} from '../tests/browser/harness.mjs';

const report = createReport('interrupt');
const ROUNDS = Number(process.env.ATLAS_INTERRUPT_ROUNDS ?? 5);
const SYMBOL = 'NQ';

const { browser, page, errors } = await launch({ width: 1500, height: 940 });

/*
 * A disconnect logs a fetch failure, and this test CAUSES a disconnect on
 * purpose. Those lines are the offline round working, not the product
 * throwing, so they do not count against "nothing threw" - anything else
 * still does.
 */
const causedByOffline = (line) =>
  /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Failed to fetch|NetworkError/i.test(line);

try {
  report.watch(page);
  await signIn(page);
  await useSymbol(page, SYMBOL);
  await useAccount(page, 'Practice 150K');
  const accountId = await page.inputValue('.abar-account');
  const market = await tradableMarket(page);

  const flatten = async () => {
    await apiFetch(page, '/api/v1/orders/cancel-all', { method: 'POST', body: { accountId } });
    await apiFetch(page, `/api/v1/positions/${SYMBOL}/flatten`, { method: 'POST', body: { accountId } });
    await market.fill();
  };

  /** What the server says, as a plain shape. */
  const truth = async () => {
    const [orders, positions] = await Promise.all([
      apiFetch(page, `/api/v1/orders?accountId=${accountId}`),
      apiFetch(page, `/api/v1/positions?accountId=${accountId}`),
    ]);
    if (!orders?.ok || !positions?.ok) throw new Error('could not read the server');
    const position = (positions.body.positions ?? []).find((p) => p.symbol === SYMBOL) ?? null;
    return {
      working: (orders.body.orders ?? []).filter(
        (o) => o.status === 'WORKING' || o.status === 'PARTIALLY_FILLED',
      ).length,
      qty: position ? Math.abs(position.signedQty) : 0,
    };
  };

  /** What the screen says. */
  const onScreen = async () => {
    const text = (await page.textContent('[data-testid=ticket-position]').catch(() => '')) ?? '';
    const match = /(\d+)\s*(?:contract|@)/i.exec(text);
    return { text: text.replace(/\s+/g, ' ').trim(), qty: match ? Number(match[1]) : 0 };
  };

  await flatten();
  report.say((await truth()).qty === 0, 'the account starts flat');

  /*
   * Reload WHILE the order is being sent. No timer: the reload is issued in
   * the same task as the click, which is as close to "mid-flight" as a test
   * can honestly get.
   */
  let disagreements = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    await page.click('[data-testid=buy]').catch(() => undefined);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForSelector('.chart-canvas canvas', { timeout: 30_000 });
    await page.waitForTimeout(3_500);
    await market.fill();
    await page.waitForTimeout(1_200);

    const server = await truth();
    const screen = await onScreen();
    const agrees = server.qty === screen.qty;
    if (!agrees) {
      disagreements += 1;
      report.say(
        false,
        `round ${round + 1}: the screen and the server disagree`,
        `server ${server.qty}, screen ${screen.qty} ("${screen.text.slice(0, 60)}")`,
      );
    }
    await flatten();
  }
  report.say(
    disagreements === 0,
    `${ROUNDS} reloads mid-order leave the screen agreeing with the server`,
  );

  // The same, on the way OUT of a position: a flatten interrupted by a reload.
  await page.click('[data-testid=buy]');
  await market.fill();
  await page.waitForTimeout(1_500);
  report.say((await truth()).qty > 0, 'a position is open to be flattened');

  await apiFetch(page, `/api/v1/positions/${SYMBOL}/flatten`, { method: 'POST', body: { accountId } });
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.waitForSelector('.chart-canvas canvas', { timeout: 30_000 });
  await page.waitForTimeout(3_500);
  await market.fill();
  await page.waitForTimeout(1_200);
  const afterFlatten = await truth();
  const screenAfter = await onScreen();
  report.say(afterFlatten.qty === 0, 'the server is flat after a flatten interrupted by a reload');
  report.say(
    screenAfter.qty === 0,
    'and the terminal says so too',
    `"${screenAfter.text.slice(0, 60)}"`,
  );
  report.say(
    afterFlatten.working === 0,
    'with nothing left working',
    `${afterFlatten.working} working order(s)`,
  );

  /*
   * The network dies mid-submit. The order may or may not have been created;
   * what may not happen is the terminal inventing an answer either way.
   */
  await flatten();
  await page.context().setOffline(true);
  await page.click('[data-testid=buy]').catch(() => undefined);
  await page.waitForTimeout(2_500);
  await page.context().setOffline(false);
  await page.waitForTimeout(4_000);
  await market.fill();
  await page.waitForTimeout(1_500);
  const offlineServer = await truth();
  const offlineScreen = await onScreen();
  report.say(
    offlineServer.qty === offlineScreen.qty,
    'an order sent while offline leaves the screen agreeing with the server',
    `server ${offlineServer.qty}, screen ${offlineScreen.qty}`,
  );

  await flatten();
  const unexpected = errors.filter((line) => !causedByOffline(line));
  report.say(
    unexpected.length === 0,
    'nothing threw through any of it, beyond the disconnect this test caused',
    unexpected.slice(0, 3).join(' | '),
  );
} finally {
  const failed = report.finish();
  await browser.close();
  process.exitCode = failed === 0 ? 0 : 1;
}
