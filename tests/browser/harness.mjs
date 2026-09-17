/**
 * Shared harness for the browser suites.
 *
 * These drive the REAL application against the real server and the real
 * database. Nothing here stubs a price, an order or an account: a check that
 * passes here passed against the same code a trader would use.
 *
 * Run them with `pnpm test:browser`, or one at a time with
 * `node tests/browser/<name>.spec.mjs`.
 */
// A development dependency of the workspace root, not of the application.
// These suites are not part of `pnpm test`: they need a running server, a
// database and a browser, so they have their own command.
import { chromium } from 'playwright';

export const WEB = process.env.ATLAS_WEB_URL ?? 'http://localhost:5173';
export const EMAIL = process.env.ATLAS_EMAIL ?? 'demo@atlasfutures.local';
export const PASSWORD = process.env.ATLAS_PASSWORD ?? 'atlas-demo-2026';
export const SHOTS = process.env.ATLAS_SHOTS ?? '/tmp/atlas-shots';

/** A suite's running tally. */
export function createReport(suite) {
  const results = [];
  const say = (ok, name, detail = '') => {
    results.push({ ok, name, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };
  const finish = () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${suite}: ${results.length - failed.length}/${results.length} passed`);
    return failed.length;
  };
  return { say, finish, results };
}

export async function launch({ width = 1680, height = 950 } = {}) {
  const browser = await chromium.launch({
    executablePath: process.env.ATLAS_CHROMIUM ?? '/opt/pw-browsers/chromium',
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`PAGEERROR: ${String(error).slice(0, 300)}`));
  page.on('console', (message) => {
    // 401s are expected before sign-in and 404s come from optional resources.
    if (message.type() === 'error' && !/401|404/.test(message.text())) {
      errors.push(message.text().slice(0, 200));
    }
  });
  return { browser, page, errors };
}

export async function signIn(page) {
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  if (await page.locator('input[type=email]').count()) {
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('button[type=submit]');
  }
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(3_500);
}

/** Select an account by its display name and let the stores settle. */
export async function useAccount(page, name) {
  await page.selectOption('.abar-account', { label: name });
  await page.waitForTimeout(1_800);
}

/** Flatten and cancel, so a suite starts from a known state. */
export async function reset(page) {
  const cancel = page.locator('.tk-grid2 button:has-text("Cancel")');
  if (await cancel.isEnabled().catch(() => false)) {
    await cancel.click();
    await page.waitForTimeout(2_000);
  }
  const close = page.locator('.tk-grid2 button:has-text("Close position")');
  if (await close.isEnabled().catch(() => false)) {
    await close.click();
    await page.waitForTimeout(3_500);
  }
}

/** How many pixels the drawing canvas has painted. Zero means nothing drawn. */
export function litPixels(page, selector = '.draw-layer') {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel);
    if (!canvas) return 0;
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 20) lit += 1;
    return lit;
  }, selector);
}

export async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => undefined);
}

/** Poll until `read()` satisfies `until`, or give up. Returns the last value. */
export async function waitFor(page, read, until, { tries = 40, every = 1_500 } = {}) {
  let value = null;
  for (let i = 0; i < tries; i += 1) {
    await page.waitForTimeout(every);
    value = await read();
    if (until(value)) return { ok: true, value, waitedMs: (i + 1) * every };
  }
  return { ok: false, value, waitedMs: tries * every };
}
