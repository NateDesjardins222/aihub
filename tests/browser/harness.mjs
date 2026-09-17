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
  await returnToLive(page);
}

/**
 * Leave the replay provider if a previous run left the terminal on it.
 *
 * Suites share one server, so one that dies mid-session would otherwise hand
 * every later suite a chart with three bars on it.
 */
export async function returnToLive(page) {
  if (await page.locator('.abar-pill-warn').count()) {
    await page.click('.abar-icon[aria-label=Practice]');
    await page.waitForTimeout(2_000);
    if (await page.locator('.practice-active .chip').count()) {
      await page.locator('.practice-active .chip').first().click();
      await page.waitForTimeout(6_000);
    }
    await page.click('[data-testid=drawer-practice] .drawer-close').catch(() => undefined);
    await page.waitForTimeout(2_500);
  }

  /*
   * And then say so to the server directly.
   *
   * Ending a practice session is not the same thing as putting the platform
   * back on the live feed: a suite that died mid-run, or one that switched the
   * provider itself, leaves the recording serving every later suite - which is
   * how `stress` came to be asked to seed drawings onto a chart with three
   * bars on it. Refused if an account still holds something, which is correct
   * and is left alone.
   */
  await page
    .evaluate(async () => {
      const refreshToken = window.localStorage.getItem('atlas.refreshToken');
      if (!refreshToken) return;
      const session = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }).then((r) => r.json());
      if (!session?.accessToken) return;
      window.localStorage.setItem('atlas.refreshToken', session.refreshToken);
      await fetch('/api/v1/marketdata/provider', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ provider: 'live' }),
      });
    })
    .catch(() => undefined);
  await page.waitForTimeout(2_000);
}

/** Select an account by its display name and let the stores settle. */
export async function useAccount(page, name) {
  await page.selectOption('.abar-account', { label: name });
  await page.waitForTimeout(1_800);
}

/**
 * Put the active chart - and with it the order ticket - on an instrument.
 *
 * The terminal remembers what each pane was showing, and a suite that recalls
 * a trade or changes a chart's symbol leaves it there for the next one. A
 * suite that assumes NQ has to SAY so: the alternative is an order ticket
 * pointed at ES while the suite waits for an NQ fill, which is thirty seconds
 * of timeout and a failure that reads like a broken feature.
 */
export async function useSymbol(page, root = 'NQ') {
  const header = page.locator('[data-pane=p1] .chdr-symbol, .chdr-symbol').first();
  if ((await header.count()) === 0) return false;
  const current = (await header.innerText()).replace(/\s+/g, ' ').trim();
  if (current.startsWith(root)) return true;
  await header.click();
  await page.waitForTimeout(500);
  const item = page.locator(`.popover .pop-item:has(.chdr-pop-root:text-is("${root}"))`);
  if ((await item.count()) === 0) {
    await page.keyboard.press('Escape');
    return false;
  }
  await item.first().click();
  await page.waitForTimeout(3_500);
  return true;
}

/** Flatten and cancel, so a suite starts from a known state. */
export async function reset(page) {
  const cancel = page.locator('.tk-grid2 button:has-text("Cancel")');
  if (await cancel.isEnabled().catch(() => false)) {
    await cancel.click();
    await page.waitForTimeout(2_000);
  }
  const close = page.locator('.tk-grid2 button:has-text("Close")');
  if (await close.isEnabled().catch(() => false)) {
    await close.click();
    await page.waitForTimeout(3_500);
  }
}

/** How many pixels the drawing canvas has painted. Zero means nothing drawn. */
export function litPixels(page, selector = '.draw-canvas') {
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

/**
 * The bounding box of what the drawing canvas has actually painted, in page
 * coordinates.
 *
 * Drawings are anchored to a PRICE, so they move on screen whenever the scale
 * changes - which it does by itself, because the market moves. A test that
 * clicks a fixed fraction of the chart is testing where a drawing used to be.
 * This reads where it is.
 */
export async function paintedBounds(page, selector = '.draw-canvas', region = null) {
  const box = await page.evaluate(({ sel, region }) => {
    const canvas = document.querySelector(sel);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    // A region isolates one drawing from another when several are on screen.
    const fromX = region ? Math.floor(width * region.x0) : 0;
    const toX = region ? Math.ceil(width * region.x1) : width;
    for (let y = 0; y < height; y += 1) {
      for (let x = fromX; x < toX; x += 1) {
        if (data[(y * width + x) * 4 + 3] > 40) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (minX === Infinity) return null;
    const ratio = canvas.width / canvas.clientWidth;
    const rect = canvas.getBoundingClientRect();
    return {
      left: rect.left + minX / ratio,
      right: rect.left + maxX / ratio,
      top: rect.top + minY / ratio,
      bottom: rect.top + maxY / ratio,
    };
  }, { sel: selector, region });
  return box;
}

/**
 * Remove every drawing on the instrument.
 *
 * The clear-all control lives in the object tree rather than on the rail, so
 * that the rail stays a TOOL bar. Suites clear through this helper so the
 * control can move again without rewriting five of them.
 */
export async function clearDrawings(page) {
  const tree = page.locator('.rail .rail-btn[aria-label="Object tree"]');
  if ((await tree.count()) === 0) return false;
  await tree.click();
  await page.waitForTimeout(350);
  const clear = page.locator('.popover .rail-clear');
  if ((await clear.count()) === 0) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    return false;
  }
  await clear.click();
  await page.waitForTimeout(600);
  return true;
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
