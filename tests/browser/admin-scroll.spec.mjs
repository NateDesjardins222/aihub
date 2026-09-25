/**
 * Owner Console scrolling — with a REAL mouse wheel.
 *
 * The regression this guards: the console was reported "cannot scroll with the
 * mouse wheel — nothing happens", even after an earlier fix that made an inner
 * element the scroll container. An automated test that scrolled by SETTING
 * scrollTop passed while the real wheel did nothing, so this test refuses to do
 * that. It drives `page.mouse.wheel`, which dispatches a trusted wheel event
 * through the browser's input pipeline exactly like a physical wheel, and asserts
 * the VISIBLE PAGE actually moved (window.scrollY changed). It also checks
 * PageDown, wheel-up, the sticky header, and — critically — that the trading
 * terminal keeps its fixed, non-scrolling layout (the console must not leak its
 * document-scroll release onto the terminal).
 */
import { createReport, launch, shot, WEB } from './harness.mjs';

const { say, finish, watch } = createReport('admin-scroll');
const { browser, page } = await launch({ width: 1440, height: 900 });
watch(page);

const EMAIL = process.env.ATLAS_OWNER_EMAIL ?? 'owner@atlasfutures.local';
const PASSWORD = process.env.ATLAS_OWNER_PASSWORD ?? 'atlas-owner-2026';

const scrollY = () => page.evaluate(() => Math.round(window.scrollY));
const pageIsTall = () =>
  page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 50);

async function go(path) {
  await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_000);
}

// Sign in via the console itself (navigating to /admin renders the login screen
// when signed out) — no dependency on the trading terminal's chart rendering.
async function signInToConsole() {
  await page.goto(`${WEB}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type=email]', { timeout: 20_000 });
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('.adm-brand', { timeout: 20_000 });
  await page.waitForTimeout(1_500);
}

try {
  await signInToConsole();

  for (const [w, h] of [
    [1920, 1080],
    [1440, 900],
    [1366, 768],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await go('/admin/products');
    await page.waitForSelector('.adm-main', { timeout: 15_000 });
    await page.waitForTimeout(800);

    say(await pageIsTall(), `[${w}x${h}] Products is taller than the viewport (something to scroll)`);

    // Real mouse wheel over the middle of the page.
    await page.mouse.move(w / 2, h / 2);
    const y0 = await scrollY();
    for (let i = 0; i < 4; i += 1) {
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(120);
    }
    const y1 = await scrollY();
    say(y1 > y0 + 100, `[${w}x${h}] the mouse WHEEL scrolls the page down`, `y ${y0} -> ${y1}`);

    // Wheel back up.
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(150);
    const y2 = await scrollY();
    say(y2 < y1, `[${w}x${h}] the wheel scrolls back up`, `y ${y1} -> ${y2}`);

    // PageDown (keyboard) also moves the document.
    await page.evaluate(() => document.body.focus());
    const y3a = await scrollY();
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(200);
    const y3 = await scrollY();
    say(y3 > y3a, `[${w}x${h}] PageDown scrolls the page`, `y ${y3a} -> ${y3}`);

    // The header stays put while the body scrolls (sticky).
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(200);
    const header = await page.evaluate(() => {
      const t = document.querySelector('.adm-top');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { top: Math.round(r.top), h: Math.round(r.height) };
    });
    say(
      header != null && header.top <= 2 && header.h > 40,
      `[${w}x${h}] the header stays pinned to the top while scrolled`,
      JSON.stringify(header),
    );
  }

  await shot(page, 'admin-scroll-products');

  // The terminal must NOT inherit the console's document scrolling: it stays a
  // fixed, viewport-locked surface (body overflow hidden, no document scroll).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);
  const terminal = await page.evaluate(() => ({
    ownerClass: document.documentElement.classList.contains('owner-console'),
    bodyOverflowY: getComputedStyle(document.body).overflowY,
  }));
  say(
    !terminal.ownerClass && terminal.bodyOverflowY === 'hidden',
    'the trading terminal keeps its fixed viewport layout (no document-scroll leak)',
    JSON.stringify(terminal),
  );
} catch (err) {
  say(false, 'admin-scroll suite ran without throwing', String(err).slice(0, 200));
} finally {
  await browser.close();
  finish();
}
