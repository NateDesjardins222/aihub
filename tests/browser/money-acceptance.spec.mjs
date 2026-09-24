/**
 * V5 money acceptance — the real product, not a unit fixture.
 *
 * The oracle and the engine suites prove the math on the server. This proves the
 * TERMINAL a trader actually looks at: that a full round trip to flat leaves the
 * money honest, that the account bar never shows a phantom open P&L once the
 * position is gone, that BAL always equals starting + realized (the invariant
 * the bar promises), and — Phase 3 — that the money reads in DM Sans, not the
 * old JetBrains Mono.
 *
 *   node tests/browser/money-acceptance.spec.mjs
 */
import {
  apiFetch,
  createReport,
  launch,
  shot,
  signIn,
  tradableMarket,
  useAccount,
  useSymbol,
} from './harness.mjs';

const { say, finish, watch } = createReport('money-acceptance');
const { browser, page, errors } = await launch({ width: 1680, height: 950 });
watch(page);

const currentAccountId = () => page.inputValue('.abar-account');

async function pnl(accountId) {
  const r = await apiFetch(page, `/api/v1/accounts/${accountId}/pnl`);
  return r?.body ?? null;
}

async function positionQty(accountId, symbol) {
  const r = await apiFetch(page, `/api/v1/positions?accountId=${accountId}`);
  const found = (r?.body?.positions ?? []).find((p) => p.symbol === symbol);
  return found ? found.qty : 0;
}

async function flatten(accountId, symbol) {
  await apiFetch(page, '/api/v1/orders/cancel-all', { method: 'POST', body: { accountId } });
  await apiFetch(page, `/api/v1/positions/${symbol}/flatten`, { method: 'POST', body: { accountId } });
}

/** The computed font a DOM element actually paints in, resolved by the browser. */
async function fontOf(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).fontFamily : null;
  }, selector);
}

/** The text of a money box, e.g. account-box-upl. */
async function boxText(label) {
  return (await page.textContent(`[data-testid=account-box-${label}] .abar-box-value`).catch(() => '')) ?? '';
}

try {
  await signIn(page);
  await useSymbol(page, 'NQ');
  await useAccount(page, 'Practice 150K');
  await page.waitForTimeout(1_000);

  const accountId = await currentAccountId();
  say(Boolean(accountId), 'the terminal is attached to an account', accountId);

  // --- Phase 3: the money reads in DM Sans, not monospace -------------------
  const balFont = (await fontOf('[data-testid=account-box-bal] .abar-box-value')) ?? '';
  say(/DM Sans/i.test(balFont), 'the account money is set in DM Sans', balFont);
  say(
    !/mono/i.test(balFont) && !/jetbrains/i.test(balFont),
    'the account money is NOT a monospace face',
    balFont,
  );

  // --- a clean slate --------------------------------------------------------
  const market = await tradableMarket(page);
  say(true, `the checks run against the ${market.mode} market`);
  await flatten(accountId, 'NQ');
  await market.fill();
  await page.waitForTimeout(1_200);

  const flatBefore = await pnl(accountId);
  say((await positionQty(accountId, 'NQ')) === 0, 'starts flat', 'no NQ exposure');
  say(
    flatBefore?.balanceMicros ===
      flatBefore?.startingBalanceMicros + flatBefore?.realizedPnlMicros - flatBefore?.feesMicros,
    'BAL = starting + realized − fees, while flat',
    `${flatBefore?.balanceMicros}`,
  );
  say(
    flatBefore?.liquidation === 'NOT_REQUIRED',
    'a healthy account reports liquidation NOT_REQUIRED',
    String(flatBefore?.liquidation),
  );

  // --- open one contract ----------------------------------------------------
  // The dev feed is delayed one-minute bars, so a fill can land a beat after any
  // single wait window. The real gate is that the position opens, not that one
  // 90s window happened to catch the print, so we give it up to three windows.
  await page.click('[data-testid=buy]');
  let openQty = 0;
  for (let attempt = 0; attempt < 3 && openQty !== 1; attempt += 1) {
    await market.fill();
    await page.waitForTimeout(1_500);
    openQty = await positionQty(accountId, 'NQ');
  }
  say(openQty === 1, 'BUY opened exactly one contract', `qty ${openQty}`);

  const held = await pnl(accountId);
  // Open P&L is either a real number (marked) or explicitly unknown (null +
  // NOT PRICED). It must never be a stale carry-over.
  say(
    held?.marked === false || typeof held?.openPnlMicros === 'number',
    'open P&L is a live number or an honest unknown',
    `marked=${held?.marked} open=${held?.openPnlMicros}`,
  );

  // --- flatten and check the money is honest again --------------------------
  await flatten(accountId, 'NQ');
  await market.fill();
  await page.waitForTimeout(1_500);

  const flatQty = await positionQty(accountId, 'NQ');
  say(flatQty === 0, 'flatten closed the position', `qty ${flatQty}`);

  const after = await pnl(accountId);
  // The phantom +$8,000 bug: a closed position must not leave a non-zero open
  // P&L behind. Flat means open P&L is 0 or unknown, never a retained figure.
  say(
    after?.openPnlMicros === 0 || after?.openPnlMicros === null,
    'no phantom open P&L once flat',
    `open=${after?.openPnlMicros}`,
  );
  say(
    after?.balanceMicros ===
      after?.startingBalanceMicros + after?.realizedPnlMicros - after?.feesMicros,
    'BAL still equals starting + realized − fees after the round trip',
    `${after?.balanceMicros}`,
  );

  // The account bar must agree with the server: UP&L reads a dash or zero, and
  // there is no NOT PRICED phantom on a healthy flat account.
  await page.waitForTimeout(600);
  const uplBox = await boxText('upl');
  say(
    uplBox.trim() === '—' || /\$0\.00$/.test(uplBox.trim()) || uplBox.trim() === '',
    'the UP&L box shows a dash or zero when flat, not a stale number',
    uplBox,
  );
  const notPriced = await page.locator('[data-testid=unpriced-warning]').count();
  say(notPriced === 0, 'no phantom NOT PRICED badge on a healthy flat account');

  // Console errors are a product defect too.
  say(errors.length === 0, 'no console errors during the money round trip', errors.slice(0, 2).join(' | '));

  await shot(page, 'money-acceptance-terminal');
} catch (error) {
  say(false, 'the suite ran without throwing', String(error).slice(0, 300));
} finally {
  await browser.close();
  process.exit(finish());
}
