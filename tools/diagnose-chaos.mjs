/**
 * Corrupt everything the browser remembers, then reload.
 *
 *   node tools/diagnose-chaos.mjs
 *
 * Atlas keeps preferences in localStorage: which account, which symbol, which
 * panels are open, which timeframes are favourites, and the refresh token. All
 * of it is written by the application and read back by the application, which
 * is exactly the assumption worth attacking. Storage gets corrupted - by a
 * crash mid-write, by a half-finished migration, by another tab of an older
 * build, by a human with devtools open.
 *
 * The standard a terminal has to meet is not "it handles the values it wrote".
 * It is: WHATEVER IS IN STORAGE, THE TERMINAL STARTS, and a trader is never
 * locked out of their account by a preference.
 *
 * Nothing here is a mock. The values are written into the real page's real
 * storage and the real application is reloaded on top of them.
 */
import { chromium } from 'playwright';
import { createReport, EMAIL, PASSWORD, WEB } from '../tests/browser/harness.mjs';

const report = createReport('chaos');

const KEYS = [
  'atlas.activeSymbol',
  'atlas.selectedAccountId',
  'atlas.timeframes.favourites',
  'atlas.panel.bottom',
  'atlas.panel.bottom.open',
  'atlas.panel.right',
  'atlas.panel.right.open',
  'atlas.panel.rail.open',
  'atlas.motion',
];

/** The shapes a corrupted value actually takes. */
const POISONS = [
  ['an empty string', ''],
  ['truncated JSON', '{"a":'],
  ['the word undefined', 'undefined'],
  ['the word null', 'null'],
  ['a JSON null', 'null'],
  ['an array where an object belongs', '[1,2,3]'],
  ['an object where a string belongs', '{"nope":true}'],
  ['a number', '-1'],
  ['a huge number', '999999999999999999999'],
  ['NaN', 'NaN'],
  ['a 100KB string', `"${'x'.repeat(100_000)}"`],
  ['a script tag', '<script>alert(1)</script>'],
  ['a uuid nobody owns', '00000000-0000-4000-8000-000000000000'],
  ['a newline', '\n'],
];

const browser = await chromium.launch({
  executablePath: process.env.ATLAS_CHROMIUM ?? '/opt/pw-browsers/chromium',
});
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page = await context.newPage();

const errors = [];
page.on('pageerror', (error) => errors.push(String(error).slice(0, 200)));

/** Did the terminal come up, with a chart and an account? */
async function startsUp(timeout = 30_000) {
  try {
    await page.waitForSelector('.chart-canvas canvas', { timeout });
    await page.waitForTimeout(2_000);
    return (await page.locator('.abar-account').count()) > 0;
  } catch {
    return false;
  }
}

try {
  report.watch(page);
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  if (await page.locator('input[type=email]').count()) {
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('button[type=submit]');
  }
  report.say(await startsUp(40_000), 'the terminal starts from clean storage');

  /*
   * One key at a time, so a failure names the key. The refresh token is left
   * alone here: losing it means signing in again, which is correct behaviour
   * and a different question - it gets its own check at the end.
   */
  let survived = 0;
  let attempted = 0;
  for (const key of KEYS) {
    for (const [name, value] of POISONS) {
      attempted += 1;
      const before = errors.length;
      await page.evaluate(
        ([k, v]) => window.localStorage.setItem(k, v),
        [key, value],
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      const ok = await startsUp(20_000);
      if (ok) survived += 1;
      else report.say(false, `${key} holding ${name} still starts the terminal`);
      if (errors.length > before) {
        report.say(false, `${key} holding ${name} threw nothing`, errors.slice(before).join(' | '));
      }
      // Clear it again so the next poison is tested on its own.
      await page.evaluate((k) => window.localStorage.removeItem(k), key);
    }
  }
  report.say(
    survived === attempted,
    `${attempted} corrupted preferences all still start the terminal`,
    survived === attempted ? '' : `${attempted - survived} did not`,
  );

  // Everything poisoned at once, which is what a bad migration looks like.
  await page.evaluate((keys) => {
    for (const key of keys) window.localStorage.setItem(key, '{"broken":');
  }, KEYS);
  await page.reload({ waitUntil: 'domcontentloaded' });
  report.say(await startsUp(25_000), 'every preference corrupted at once still starts the terminal');
  await page.evaluate((keys) => {
    for (const key of keys) window.localStorage.removeItem(key);
  }, KEYS);

  // Storage that refuses to be written at all: a private window with site data
  // blocked, or a quota that is already full.
  await page.addInitScript(() => {
    const deny = () => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: () => null, setItem: deny, removeItem: deny, clear: deny, key: () => null, length: 0 },
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const signInShown =
    (await page.locator('input[type=password]').count()) > 0 || (await startsUp(15_000));
  report.say(
    signInShown,
    'storage that throws on every write still shows a usable page, not a blank one',
  );

  report.say(
    errors.length === 0,
    'nothing threw into the console through any of it',
    errors.slice(0, 3).join(' | '),
  );
} finally {
  const failed = report.finish();
  await browser.close();
  process.exitCode = failed === 0 ? 0 : 1;
}
