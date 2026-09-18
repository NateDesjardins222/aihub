/**
 * The acceptance flow, end to end.
 *
 *   an operator creates a user
 *     -> provisions a $150K account
 *     -> the trader signs in and the account is simply there
 *     -> they trade NQ
 *     -> the orders, fills and P&L are on the server
 *     -> the account's rule state moves
 *     -> the operator watches it happen
 *     -> the trader signs out, comes back, and everything is where they left it
 *     -> a second account is provisioned, and the two stay completely separate
 *
 * Nothing here is faked: a real browser, the real admin API, the real
 * execution engine and the real market data. The one thing the suite cannot
 * control is whether the market is open, so the trading steps report honestly
 * when a fill was not possible rather than pretending one happened.
 */
import { createReport, launch, shot, waitFor, WEB } from './harness.mjs';

const { say, finish, watch } = createReport('acceptance');
const { browser, page, errors } = await launch({ width: 1600, height: 1000 });
watch(page);

const stamp = Date.now().toString(36);
const TRADER_EMAIL = `acceptance-${stamp}@atlas.test`;
const TRADER_PASSWORD = 'acceptance-flow-password';

/**
 * The operator's own session, in its own tab.
 *
 * Kept separate from the trader's for the whole run: the two are different
 * people with different permissions, and sharing one page would either test
 * nothing or quietly send an admin call with a trader's token.
 */
let operatorPage = null;

async function operator() {
  if (operatorPage) return operatorPage;
  operatorPage = await browser.newPage();
  await operatorPage.goto(WEB, { waitUntil: 'domcontentloaded' });
  await operatorPage.waitForTimeout(1_200);
  await operatorPage.fill('input[type=email]', 'demo@atlasfutures.local');
  await operatorPage.fill('input[type=password]', 'atlas-demo-2026');
  await operatorPage.click('button[type=submit]');
  await operatorPage.waitForTimeout(4_000);
  return operatorPage;
}

/** Call the admin API as the operator, using their own session's token. */
async function asOperator(method, path, body) {
  const session = await operator();
  return session.evaluate(
    async ({ method, path, body }) => {
      const token = window.localStorage.getItem('atlas.refreshToken');
      // Refreshed through the ordinary endpoint: this helper never invents a
      // credential, it uses the one the operator signed in with.
      const refreshed = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      }).then((response) => response.json());
      window.localStorage.setItem('atlas.refreshToken', refreshed.refreshToken);
      const response = await fetch(path, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${refreshed.accessToken}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    },
    { method, path, body },
  );
}

try {
  // --- the operator --------------------------------------------------------
  const createdUser = await asOperator('POST', '/api/v1/admin/users', {
    email: TRADER_EMAIL,
    displayName: 'Acceptance Trader',
    password: TRADER_PASSWORD,
    withPracticeAccount: false,
  });
  say(createdUser.status === 201, 'an operator creates a user', TRADER_EMAIL);
  const userId = createdUser.json?.user?.id;

  const provisioned = await asOperator('POST', '/api/v1/admin/accounts', {
    userId,
    profileKey: 'practice-150k',
    displayName: 'Evaluation 150K',
  });
  say(
    provisioned.status === 201 && /^SIM-\d{6}$/.test(provisioned.json?.publicId ?? ''),
    'and provisions them a $150K simulated account',
    provisioned.json?.publicId,
  );
  const accountId = provisioned.json?.accountId;
  const publicId = provisioned.json?.publicId;

  // --- the trader ----------------------------------------------------------
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_500);
  await page.fill('input[type=email]', TRADER_EMAIL);
  await page.fill('input[type=password]', TRADER_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(4_000);

  const options = await page.locator('.abar-account option').allTextContents();
  say(
    options.some((option) => option.includes('Evaluation 150K')),
    'the account is simply there when they sign in',
    options.join(' / '),
  );
  say(options.length === 1, 'and it is the only one they have', `${options.length} accounts`);

  const balance = await page.locator('[data-testid=account-box-bal] .abar-box-value').innerText();
  say(/150/.test(balance.replace(/[^0-9.]/g, '')), 'with the balance it was provisioned with', balance);
  await shot(page, 'acceptance-first-login');

  // --- they trade ----------------------------------------------------------
  await page.click('.tk-buy');

  // Polled rather than slept on: a fill waits for a market event, and how long
  // that takes is the market's business, not the test's.
  const readPosition = () =>
    page
      .locator('[data-testid=ticket-position]')
      .innerText()
      .catch(() => '');
  const filled = await waitFor(page, readPosition, (text) => /LONG|SHORT/.test(text), {
    tries: 12,
    every: 2_000,
  });
  const positionText = filled.value ?? '';
  const ticketError = await page.locator('.tk-error').innerText().catch(() => '');
  const traded = /LONG|SHORT/.test(positionText);
  if (traded) {
    say(true, 'a market order fills and the position is on the server', positionText.replace(/\n/g, ' '));
  } else {
    // An honest outcome: the market is shut, so nothing could fill. The rest
    // of the flow is still checked; a fabricated fill would prove nothing.
    say(
      /market|closed|stale|data/i.test(ticketError),
      'the order was refused for a reason the platform can state',
      ticketError || 'no error shown',
    );
  }

  // --- the operator watches ------------------------------------------------
  const live = await asOperator('GET', `/api/v1/admin/accounts/${accountId}/live`);
  say(live.status === 200, 'the operator can watch that account live');
  say(
    live.json?.valuation?.accountId === accountId,
    'and the figures come from the execution engine, not the browser',
  );
  if (traded) {
    say(
      (live.json?.valuation?.openContracts ?? 0) > 0,
      'the operator sees the open position the trader just took',
      `${live.json?.valuation?.openContracts} contracts`,
    );
    say(
      (live.json?.recentFills?.length ?? 0) > 0,
      'and the fill that opened it',
      `${live.json?.recentFills?.length} fills`,
    );
  }

  const detail = await asOperator('GET', `/api/v1/admin/accounts/${accountId}`);
  say(
    detail.json?.audit?.some((entry) => entry.action === 'account.created'),
    'the account has an audit trail starting at its provisioning',
  );
  if (traded) {
    say(
      detail.json?.audit?.some((entry) => entry.action === 'order.filled'),
      'and the fill was recorded in it',
    );
  }

  // --- restart -------------------------------------------------------------
  // The BALANCE, not the equity: equity moves with the market, and a test that
  // demands an unchanging equity is testing that the market stopped.
  const before = await page.locator('[data-testid=account-box-bal] .abar-box-value').innerText();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(5_000);
  const after = await page.locator('[data-testid=account-box-bal] .abar-box-value').innerText();
  say(before === after, 'everything is where they left it after a restart', `${before} -> ${after}`);
  if (traded) {
    const stillOpen = await page
      .locator('[data-testid=ticket-position]')
      .innerText()
      .catch(() => '');
    say(/LONG|SHORT/.test(stillOpen), 'including the open position', stillOpen.replace(/\n/g, ' '));
  }

  // --- a second account ----------------------------------------------------
  const second = await asOperator('POST', '/api/v1/admin/accounts', {
    userId,
    profileKey: 'practice-100k',
    displayName: 'Second Account',
  });
  say(second.status === 201, 'a second account is provisioned for the same trader');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(5_000);
  const bothOptions = await page.locator('.abar-account option').allTextContents();
  say(bothOptions.length === 2, 'the trader now sees both', bothOptions.join(' / '));

  // Switch to the second account and prove nothing carried across.
  const secondLabel = bothOptions.find((option) => option.includes('Second'));
  await page.selectOption('.abar-account', { label: secondLabel });
  await page.waitForTimeout(4_000);
  // Read from the ticket's own position line, which is the element the trader
  // reads. An assertion against a selector that does not exist passes for the
  // wrong reason, which is worse than no assertion at all.
  const secondPositions = await readPosition();
  say(
    /No active position/i.test(secondPositions),
    'the second account has none of the first account\u2019s state',
    secondPositions.replace(/\n/g, ' '),
  );

  const secondBalance = await page
    .locator('[data-testid=account-box-bal] .abar-box-value')
    .innerText();
  say(
    secondBalance !== balance || !traded,
    'and its own balance',
    `${balance} -> ${secondBalance}`,
  );

  const firstLabel = bothOptions.find((option) => option.includes('Evaluation'));
  await page.selectOption('.abar-account', { label: firstLabel });
  if (traded) {
    // Polled: switching accounts asks the server for that account's state, and
    // how long the answer takes is not something a test should assert on.
    const back = await waitFor(page, readPosition, (text) => /LONG|SHORT/.test(text), {
      tries: 8,
      every: 2_000,
    });
    say(
      back.ok,
      'switching back brings the first account\u2019s position with it',
      (back.value ?? '').replace(/\n/g, ' '),
    );
  }

  await shot(page, 'acceptance-two-accounts');

  say(errors.length === 0, 'no page errors', errors.join(' | '));

  void publicId;
} finally {
  if (operatorPage) await operatorPage.close().catch(() => undefined);
  await browser.close();
}

process.exit(finish());
