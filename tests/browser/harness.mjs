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
/**
 * A suite's report, and its camera.
 *
 * `watch(page)` makes a failing check photograph the terminal. A suite that
 * fails only when it runs after five others is otherwise diagnosed by guesswork
 * - which market the chart was showing, and where the position marker had been
 * pushed to, was exactly the information the log did not carry.
 */
export function createReport(suite) {
  const results = [];
  let watched = null;
  let shots = 0;
  const say = (ok, name, detail = '') => {
    results.push({ ok, name, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    if (!ok && watched && shots < 4) {
      shots += 1;
      const file = `fail-${suite}-${shots}`;
      // Fire and forget: a report must not become async for every caller.
      void shot(watched, file)
        .then(() => console.log(`      photographed as ${file}.png`))
        .catch(() => {});
    }
  };
  const watch = (page) => {
    watched = page;
  };
  const finish = () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${suite}: ${results.length - failed.length}/${results.length} passed`);
    return failed.length;
  };
  return { say, finish, results, watch };
}

/**
 * `args` and `initScript` exist for the performance harness.
 *
 * Precise heap numbers need a Chromium flag, and the probe has to be installed
 * before the application script runs or it misses everything up to the first
 * paint. Neither is on by default: an ordinary suite should launch the browser
 * a trader would have.
 */
export async function launch({
  width = 1680,
  height = 950,
  args = [],
  initScript = null,
  /**
   * A touch screen, for the tablet pass.
   *
   * Not the same question as a narrow window: a pointer that cannot hover has
   * no way to reach a control that only appears on hover, and a 44px target is
   * a different requirement from a 22px one.
   */
  touch = false,
  deviceScaleFactor = 1,
} = {}) {
  const browser = await chromium.launch({
    executablePath: process.env.ATLAS_CHROMIUM ?? '/opt/pw-browsers/chromium',
    ...(args.length > 0 ? { args } : {}),
  });
  const page = await browser.newPage({
    viewport: { width, height },
    ...(touch ? { hasTouch: true } : {}),
    ...(deviceScaleFactor !== 1 ? { deviceScaleFactor } : {}),
  });
  if (initScript) await page.addInitScript(initScript);
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
  // The REPLAY pill, not merely a warn-toned one: outside trading hours the
  // feed's own MARKET CLOSED pill is warn too, and reading that as "a previous
  // run left us in a replay" sent every sign-in through the practice drawer.
  if (await page.locator('[data-testid=replay-pill]').count()) {
    await page.click('[data-testid=apprail-practice]');
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
      const auth = {
        authorization: `Bearer ${session.accessToken}`,
        'content-type': 'application/json',
      };
      const toLive = () =>
        fetch('/api/v1/marketdata/provider', {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ provider: 'live' }),
        });

      if ((await toLive()).ok) return;

      /*
       * Refused, which means something is still open.
       *
       * A suite that died mid-trade leaves a position and its protective
       * orders behind, and the platform - correctly - will not change the
       * market underneath them. For a TEST account that is not a decision to
       * respect: it is the previous run's litter, and every suite after it
       * would be handed a chart with three bars on it. Cancel, flatten in the
       * market the position belongs to, and then go home.
       */
      const accounts = await fetch('/api/v1/accounts', { headers: auth })
        .then((r) => r.json())
        .catch(() => ({ accounts: [] }));
      for (const account of accounts.accounts ?? []) {
        const summary = await fetch(`/api/v1/accounts/${account.id}/pnl`, { headers: auth })
          .then((r) => r.json())
          .catch(() => null);
        if (!summary || (summary.openContracts ?? 0) === 0) continue;
        await fetch('/api/v1/orders/cancel-all', {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ accountId: account.id }),
        }).catch(() => undefined);
        for (const symbol of ['NQ', 'ES', 'MNQ', 'MES']) {
          await fetch(`/api/v1/positions/${symbol}/flatten`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ accountId: account.id }),
          }).catch(() => undefined);
        }
        // A paused recording needs events before a market order can fill.
        for (let i = 0; i < 10; i += 1) {
          await fetch('/api/v1/marketdata/replay/step', {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ count: 10 }),
          }).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 400));
          const now = await fetch(`/api/v1/accounts/${account.id}/pnl`, { headers: auth })
            .then((r) => r.json())
            .catch(() => null);
          if (!now || (now.openContracts ?? 0) === 0) break;
        }
      }
      await toLive();
    })
    .catch(() => undefined);
  await page.waitForTimeout(2_500);
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
/**
 * Remove every indicator from every pane.
 *
 * A suite that adds indicators must take them away again: an RSI in its own
 * pane moves the price plot, and the next suite's crosshair and price-axis
 * gestures are aimed at pixels. Workspace state persists across a reload by
 * design, so "the browser closed" is not a cleanup.
 */
export async function clearIndicators(page) {
  for (let i = 0; i < 40; i += 1) {
    const row = page.locator('[data-testid=indicator-row]').first();
    if ((await row.count()) === 0) return i;
    /*
     * Hover the ROW first, the way a hand does.
     *
     * The row's controls are revealed on hover with an opacity transition, so
     * reaching straight for the button asks to click something that is still
     * fading in - which is not actionable, and retrying restarts the fade. A
     * trader hovers the row and then aims; so does this.
     */
    await row.hover().catch(() => {});
    await page.waitForTimeout(160);
    const remove = row.locator('.ind-btn-danger').first();
    if ((await remove.count()) === 0) return i;
    await remove.click({ timeout: 5_000 }).catch(async () => {
      await remove.click({ force: true }).catch(() => {});
    });
    await page.waitForTimeout(400);
  }
  return 40;
}

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

/**
 * Call the API from inside the page, as the signed-in user.
 *
 * Some checks need to ask the server something the UI does not show, or to
 * nudge a paused recording. The access token lives in memory in the app, so
 * the refresh token in storage is exchanged for a fresh one here - and stored
 * back, because the exchange rotates it.
 */
export async function apiFetch(page, path, init = {}) {
  return page
    .evaluate(
      async ({ path, init }) => {
        const refreshToken = window.localStorage.getItem('atlas.refreshToken');
        if (!refreshToken) return null;
        const session = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        }).then((r) => (r.ok ? r.json() : null));
        if (!session?.accessToken) return null;
        window.localStorage.setItem('atlas.refreshToken', session.refreshToken);
        const response = await fetch(path, {
          method: init.method ?? 'GET',
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            'content-type': 'application/json',
          },
          body: init.body ? JSON.stringify(init.body) : undefined,
        });
        const text = await response.text();
        try {
          return { ok: response.ok, status: response.status, body: JSON.parse(text) };
        } catch {
          return { ok: response.ok, status: response.status, body: text };
        }
      },
      { path, init },
    )
    .catch(() => null);
}

/**
 * A market that will actually fill an order, whatever the hour.
 *
 * The platform refuses order entry when the feed is closed or stale, which is
 * correct and is not something a test should route around. But it means that
 * every suite which opens a position - the terminal workflow, the new-user
 * walkthrough, the manual pass - could only run while the exchange was open,
 * and outside those hours failed with "No active position", which reads like a
 * broken product rather than a shut market.
 *
 * So: if the live feed blocks entry, load a paused recording and trade that
 * instead. The returned `fill` is what a caller waits on after sending an
 * order - a few seconds of real market, or a nudge of the recording.
 */
export async function tradableMarket(page, { symbol = 'NQ' } = {}) {
  const status = await apiFetch(page, `/api/v1/marketdata/quote?symbol=${encodeURIComponent(symbol)}`);
  const blocked = status?.body?.freshness?.blocksOrderEntry === true;

  if (!blocked) {
    return { mode: 'live', fill: async () => page.waitForTimeout(6_000) };
  }

  await page.click('[data-testid=apprail-practice]');
  await page.waitForSelector('[data-testid=drawer-practice]', { timeout: 15_000 });
  await page.waitForTimeout(2_500);
  if (await page.locator('.practice-active').count()) {
    await page.click('.practice-active .chip');
    await page.waitForTimeout(6_000);
  }
  await page.locator('.practice-session').first().click();
  await page.waitForTimeout(9_000);
  await page.click('.practice-row .chip:has-text("Restart")').catch(() => undefined);
  await page.waitForTimeout(2_500);
  await page.click('[data-testid=drawer-practice] .drawer-close').catch(() => undefined);
  await page.waitForTimeout(1_000);

  return {
    mode: 'replay',
    fill: async (count = 12) => {
      await stepReplay(page, count);
      await page.waitForTimeout(1_500);
    },
  };
}

/** Advance a paused recording by `count` market events. */
export async function stepReplay(page, count = 10) {
  await apiFetch(page, '/api/v1/marketdata/replay/step', {
    method: 'POST',
    body: { count },
  });
  await page.waitForTimeout(900);
}
