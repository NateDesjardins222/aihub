/**
 * Two tabs, one session.
 *
 *   node tools/diagnose-multitab.mjs
 *
 * Traders keep more than one window open. Tabs of the same origin share
 * localStorage, and Atlas keeps the refresh token there - so everything one
 * tab writes, the other inherits, including a write that says "you are signed
 * out".
 *
 * This exists because of D-009. The torture harness was broken by refresh
 * token rotation: the server revokes a refresh token in the same statement
 * that accepts it, which is correct, and means TWO SIMULTANEOUS EXCHANGES OF
 * THE SAME TOKEN LEAVE ONE CALLER HOLDING A REVOKED ONE. Inside a single tab
 * the application shares one in-flight refresh and cannot collide with itself.
 * Two tabs are two of those, and nothing coordinates them.
 *
 * A reload is the honest trigger: the access token lives in memory, so a tab
 * that has just reloaded MUST exchange the stored refresh token before it can
 * read anything. Reload both tabs at the same moment and they race for real -
 * no stubbing, no clock manipulation, no simulated client.
 *
 * What is asserted is what the trader would see: is either tab looking at a
 * sign-in form, does the session survive in storage, and can both tabs still
 * read the account.
 */
import { chromium } from 'playwright';
import { createReport, EMAIL, PASSWORD, WEB } from '../tests/browser/harness.mjs';

const report = createReport('multi-tab');
const ROUNDS = Number(process.env.ATLAS_MULTITAB_ROUNDS ?? 4);

const browser = await chromium.launch({
  executablePath: process.env.ATLAS_CHROMIUM ?? '/opt/pw-browsers/chromium',
});
/*
 * ONE context. Two contexts would be two browsers and would share nothing,
 * which is a different and much easier question than the one worth asking.
 */
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

/** Is this page showing the terminal, or the door? */
const signedIn = async (page) =>
  (await page.locator('.abar-account').count()) > 0 &&
  (await page.locator('input[type=password]').count()) === 0;

const storedToken = (page) =>
  page.evaluate(() => window.localStorage.getItem('atlas.refreshToken'));

try {
  const a = await context.newPage();
  await a.goto(WEB, { waitUntil: 'domcontentloaded' });
  await a.waitForTimeout(800);
  if (await a.locator('input[type=email]').count()) {
    await a.fill('input[type=email]', EMAIL);
    await a.fill('input[type=password]', PASSWORD);
    await a.click('button[type=submit]');
  }
  await a.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await a.waitForTimeout(2_500);
  report.watch(a);

  const b = await context.newPage();
  await b.goto(WEB, { waitUntil: 'domcontentloaded' });
  await b.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await b.waitForTimeout(2_500);

  report.say(await signedIn(a), 'the first tab is signed in');
  report.say(
    await signedIn(b),
    'a second tab opens already signed in, without asking again',
  );

  /*
   * The race, repeated. Once is an anecdote: whichever tab happens to be
   * scheduled first may well finish before the other starts.
   */
  let lostSession = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const before = await storedToken(a);
    await Promise.all([
      a.reload({ waitUntil: 'domcontentloaded' }),
      b.reload({ waitUntil: 'domcontentloaded' }),
    ]);
    await a.waitForTimeout(4_000);

    const [okA, okB] = await Promise.all([signedIn(a), signedIn(b)]);
    const after = await storedToken(a);
    if (!okA || !okB || after === null) lostSession += 1;
    if (!okA || !okB) {
      report.say(false, `round ${round + 1}: a tab was signed out`, `A ${okA ? 'in' : 'OUT'}, B ${okB ? 'in' : 'OUT'}`);
    }
    if (after === null && before !== null) {
      report.say(false, `round ${round + 1}: the stored session was cleared`);
    }
  }
  report.say(
    lostSession === 0,
    `${ROUNDS} simultaneous reloads of both tabs leave both signed in`,
    lostSession === 0 ? '' : `${lostSession} round(s) lost the session`,
  );

  // A tab that survived the race must still be able to READ, not merely look
  // signed in: a stale in-memory token shows a terminal that cannot refresh.
  for (const [name, page] of [
    ['the first tab', a],
    ['the second tab', b],
  ]) {
    const ok = await page.evaluate(async () => {
      const token = window.localStorage.getItem('atlas.refreshToken');
      if (!token) return false;
      const session = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
      if (!session.ok) return false;
      const { accessToken, refreshToken } = await session.json();
      window.localStorage.setItem('atlas.refreshToken', refreshToken);
      const accounts = await fetch('/api/v1/accounts', {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      return accounts.ok;
    });
    report.say(ok, `${name} can still read the account after the races`);
  }

  // And the two tabs must agree about the money.
  const balances = await Promise.all(
    [a, b].map((page) =>
      page.textContent('.abar-box:has(.abar-box-label:text-is("BAL")) .abar-box-value').catch(() => null),
    ),
  );
  report.say(
    balances[0] !== null && balances[0] === balances[1],
    'both tabs show the same balance',
    `${balances[0]} vs ${balances[1]}`,
  );
} finally {
  const failed = report.finish();
  await browser.close();
  process.exitCode = failed === 0 ? 0 : 1;
}
