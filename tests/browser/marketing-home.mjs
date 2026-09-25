/*
 * Public marketing homepage — browser acceptance (Milestone 13).
 *
 * Standalone (NOT part of run.mjs, which signs in — a signed-in "/" shows the
 * terminal, not the marketing site). Run it against a preview of the built web app:
 *
 *   pnpm --filter @atlas/web build
 *   pnpm --filter @atlas/web exec vite preview --port 4177 --strictPort &
 *   node tests/browser/marketing-home.mjs
 *
 * Verifies: brand header + animating candles, authoritative pricing, no fabricated
 * trust signals, family switching, tab-hidden catch-up (no flat candles), FAQ,
 * mobile layout (burger + no overflow), reduced-motion, and that authed routes
 * (/portal) still show the sign-in gate rather than the marketing page.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:4177';
const EXE = process.env.ATLAS_CHROMIUM ?? '/opt/pw-browsers/chromium';
const results = [];
const say = (ok, name, detail = '') => { results.push({ ok, name, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const browser = await chromium.launch({ executablePath: EXE });

async function canvasVaried(page, selector) {
  // Sample the canvas pixels and confirm it is not blank / not uniform.
  return page.evaluate((sel) => {
    const c = document.querySelector(sel);
    if (!c) return { ok: false, reason: 'no canvas' };
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    if (!w || !h) return { ok: false, reason: 'zero size' };
    const d = ctx.getImageData(0, 0, w, h).data;
    let nonZero = 0; const vals = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) { // sparse sample
      const a = d[i + 3];
      if (a > 4) nonZero += 1;
      vals.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
    }
    return { ok: nonZero > 20 && vals.size > 3, nonZero, distinct: vals.size };
  }, selector);
}

try {
  // ---- Desktop homepage ----
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 160)));

  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.ht', { timeout: 15000 });

  // Candle animation — sampled first, before any interaction, like a fresh visit.
  const grab = () => page.evaluate(() => {
    const c = document.querySelector('.ht-band-canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let h = 0; for (let i = 0; i < d.length; i += 101) h = (h * 31 + d[i]) >>> 0;
    return h;
  });
  const samples = [];
  for (let i = 0; i < 6; i += 1) { samples.push(await grab()); await page.waitForTimeout(320); }
  say(new Set(samples).size > 1, 'candle strip is animating (frames differ)', `${new Set(samples).size} distinct of ${samples.length}`);

  say(await page.locator('.ht-band-wordmark').count() > 0, 'branded candle header renders');
  say((await page.locator('.ht-band-wordmark .line1').innerText()).includes('HAPPY TRADER'), 'wordmark reads HAPPY TRADER');
  say(await page.locator('.ht-nav').count() > 0, 'top navigation renders');
  say(await page.locator('#accounts .ht-family-tab').count() === 3, 'three family tabs (Core/Select/Daily)');

  // Authoritative pricing present in the DOM.
  const body = await page.locator('.ht').innerText();
  say(body.includes('$599'), 'flagship 300K price $599 shown');
  say(body.includes('$15,000'), 'flagship target $15,000 shown');
  say(body.includes('90%'), '90% split shown');
  say(await page.locator('.ht-acct-badge').count() > 0, 'Gold badge present');

  // No fabricated trust signals.
  const lowered = body.toLowerCase();
  const banned = ['payouts paid', 'traders funded', 'trustpilot', 'as seen on', 'testimonial', '5-star', 'reviews from'];
  const foundBanned = banned.filter((b) => lowered.includes(b));
  say(foundBanned.length === 0, 'no fabricated trust/testimonial/stat signals', foundBanned.join(','));

  // Switch family tab → matrix updates.
  await page.locator('.ht-family-tab', { hasText: 'Daily' }).click();
  await page.waitForTimeout(400);
  say((await page.locator('.ht-accounts').innerText()).includes('Payout buffer'), 'Daily shows payout buffer rule');

  const varied = await canvasVaried(page, '.ht-band-canvas');
  say(varied.ok, 'candle strip has real, varied content', JSON.stringify(varied));

  // Tab hidden → visible: still varied (no flat wipeout).
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(400);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(600);
  const afterHide = await canvasVaried(page, '.ht-band-canvas');
  say(afterHide.ok, 'candle strip recovers with varied candles after tab switch (no flats)', JSON.stringify(afterHide));

  // FAQ accordion toggles.
  await page.locator('.ht-faq-q').nth(1).click();
  await page.waitForTimeout(300);
  say((await page.locator('.ht-faq-item').nth(1).getAttribute('data-open')) === 'true', 'FAQ item opens');

  await page.screenshot({ path: '/tmp/claude-0/ht-desktop.png', fullPage: true });

  // ---- Mobile ----
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const mp = await mctx.newPage();
  await mp.goto(BASE + '/', { waitUntil: 'networkidle' });
  await mp.waitForSelector('.ht', { timeout: 15000 });
  say(await mp.locator('.ht-nav-burger').isVisible(), 'mobile: burger visible');
  say(!(await mp.locator('.ht-nav-links a').first().isVisible().catch(() => false)), 'mobile: desktop nav links hidden');
  await mp.locator('.ht-nav-burger').click();
  await mp.waitForTimeout(200);
  say((await mp.locator('.ht-mobile-menu').getAttribute('data-open')) === 'true', 'mobile: menu opens');
  const scrollW = await mp.evaluate(() => document.documentElement.scrollWidth);
  const clientW = await mp.evaluate(() => document.documentElement.clientWidth);
  say(scrollW <= clientW + 2, 'mobile: no horizontal overflow', `${scrollW} vs ${clientW}`);
  await mp.screenshot({ path: '/tmp/claude-0/ht-mobile.png', fullPage: true });
  await mctx.close();

  // ---- Reduced motion ----
  const rctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const rp = await rctx.newPage();
  await rp.goto(BASE + '/', { waitUntil: 'networkidle' });
  await rp.waitForSelector('.ht', { timeout: 15000 });
  await rp.waitForTimeout(300);
  const revealShown = await rp.evaluate(() => {
    const els = Array.from(document.querySelectorAll('.ht-reveal'));
    if (!els.length) return false;
    return els.every((e) => getComputedStyle(e).opacity === '1');
  });
  say(revealShown, 'reduced-motion: content is fully visible (no hidden reveals)');
  await rctx.close();

  // ---- Authed routes intact ----
  const actx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ap = await actx.newPage();
  await ap.goto(BASE + '/portal', { waitUntil: 'networkidle' });
  await ap.waitForTimeout(800);
  const portalBody = await ap.evaluate(() => document.body.innerText.toLowerCase());
  say(!portalBody.includes('happy trader funding') || (await ap.locator('.ht').count()) === 0, 'authed route /portal does NOT show the marketing homepage');
  say((await ap.locator('input[type=password], input[type=email]').count()) > 0 || portalBody.includes('sign in') || portalBody.includes('password'), '/portal shows the sign-in gate');
  await actx.close();

  say(errors.length === 0, 'no console errors on the homepage', errors.slice(0, 3).join(' | '));

  await ctx.close();
} catch (e) {
  say(false, 'validation ran without throwing', String(e).slice(0, 200));
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
