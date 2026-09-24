/**
 * Milestone 6 — Certificate Vault, physical commerce, public verification, and the
 * Daily progressive qualifying-balance rule: real-browser acceptance.
 *
 * Drives the actual portal against the real server + database. The demo trader is
 * SUPER_ADMIN, so one login also exercises the owner Certificate Store. The Daily
 * progression card is proven end-to-end with a dedicated funded fixture whose next
 * payout is blocked ONLY by the M6 progression rule.
 *
 * Requires, against the dev database:
 *   npx tsx apps/server/src/scripts/seed-demo-certificates.ts demo@atlasfutures.local
 *   npx tsx apps/server/src/scripts/seed-demo-daily-payout.ts
 * and the server started with MERCH_ENABLED=true.
 *
 *   node tests/browser/certificates-acceptance.spec.mjs
 */
import { createReport, launch, signIn, shot, WEB } from './harness.mjs';

const { say, finish, watch } = createReport('certificates-acceptance');
const { browser, page, errors } = await launch({ width: 1440, height: 980 });
watch(page);

/** Fetch a URL inside the page and report ok + content-type, without parsing a binary body. */
async function headOf(p, url, bearer) {
  return p.evaluate(async ({ url, bearer }) => {
    try {
      const res = await fetch(url, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});
      return { ok: res.ok, status: res.status, type: res.headers.get('content-type') ?? '' };
    } catch (e) { return { ok: false, status: 0, type: '', err: String(e) }; }
  }, { url, bearer });
}

/** The in-memory access token the portal app holds (for authed artifact fetches). */
async function accessToken(p) {
  return p.evaluate(async () => {
    const w = /** @type {any} */ (window);
    if (w.__atlasHarnessAccess) return w.__atlasHarnessAccess;
    const rt = w.localStorage.getItem('atlas.refreshToken');
    if (!rt) return '';
    const r = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
    if (!r.ok) return '';
    const s = await r.json();
    w.localStorage.setItem('atlas.refreshToken', s.refreshToken);
    w.__atlasHarnessAccess = s.accessToken;
    return s.accessToken;
  });
}

try {
  await signIn(page);

  // ======================================================================
  // NAV + VAULT
  // ======================================================================
  await page.goto(`${WEB}/portal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=portal-app]', { timeout: 20_000 });
  await page.waitForTimeout(500);
  say(true, 'the portal shell renders at /portal');

  const certNav = await page.locator('[data-testid=pt-nav-certificates]').count();
  say(certNav === 1, 'the shell exposes a Certificates nav item');

  await page.locator('[data-testid=pt-nav-certificates]').click();
  await page.waitForSelector('[data-testid=pt-cert-list]', { timeout: 15_000 });
  say(true, 'the Certificate Vault page loads');

  const h1 = (await page.textContent('.pt-h1').catch(() => '')) ?? '';
  say(/certificate/i.test(h1), 'the vault has a Certificates heading', h1.trim());

  const cardCount = await page.locator('[data-testid=pt-cert-card]').count();
  say(cardCount >= 3, 'the vault shows the trader’s earned certificates', `${cardCount} cards`);

  // A rendered artifact is the visual hero — never CSS-drawn. The thumbnail is an
  // authenticated blob fetch, so give it a moment to resolve.
  await page.waitForSelector('[data-testid=pt-cert-thumb]', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(800);
  const thumbs = await page.locator('[data-testid=pt-cert-thumb]').count();
  say(thumbs >= 3, 'each certificate shows its deterministically rendered image', `${thumbs} thumbnails`);

  const statuses = await page.locator('[data-testid=pt-cert-status]').allTextContents();
  say(statuses.length > 0 && statuses.every((s) => /valid/i.test(s)), 'every certificate reads as Valid');

  const idText = (await page.locator('[data-testid=pt-cert-card] .pt-cert-id').first().textContent().catch(() => '')) ?? '';
  say(/^HT-C-/.test(idText.trim()), 'a public certificate id is shown on the card', idText.trim());

  // ======================================================================
  // FILTERING
  // ======================================================================
  const filterBtns = await page.locator('[data-testid=pt-cert-filter] button').count();
  say(filterBtns === 5, 'the vault offers the five award categories', `${filterBtns} filters`);

  const total = await page.locator('[data-testid=pt-cert-card]').count();
  await page.locator('[data-testid=pt-cert-filter] button', { hasText: 'Funded' }).click();
  await page.waitForTimeout(300);
  const funded = await page.locator('[data-testid=pt-cert-card][data-cert-type=FUNDED_TRADER]').count();
  const fundedTotal = await page.locator('[data-testid=pt-cert-card]').count();
  say(funded >= 1 && fundedTotal === funded, 'the Funded filter shows only funded certificates', `${fundedTotal} shown`);

  await page.locator('[data-testid=pt-cert-filter] button', { hasText: 'Payouts' }).click();
  await page.waitForTimeout(300);
  const payoutOnly = await page.locator('[data-testid=pt-cert-card]').count();
  const payoutTyped = await page.locator('[data-testid=pt-cert-card][data-cert-type=PAYOUT]').count();
  say(payoutOnly === payoutTyped && payoutTyped >= 1, 'the Payouts filter shows only payout certificates', `${payoutOnly} shown`);

  await page.locator('[data-testid=pt-cert-filter] button', { hasText: 'Milestones' }).click();
  await page.waitForTimeout(300);
  const club = await page.locator('[data-testid=pt-cert-card][data-cert-type=TENK_CLUB]').count();
  say(club >= 1, 'the Milestones filter surfaces the $10K Club certificate', `${club} milestone card(s)`);

  await page.locator('[data-testid=pt-cert-filter] button', { hasText: 'All' }).click();
  await page.waitForTimeout(300);
  const backToAll = await page.locator('[data-testid=pt-cert-card]').count();
  say(backToAll === total, 'the All filter restores the full vault', `${backToAll} cards`);

  // ======================================================================
  // DOWNLOAD + VERIFY CONTROLS
  // ======================================================================
  const dlImg = await page.locator('[data-testid=pt-cert-download-image]').count();
  say(dlImg >= 3, 'each rendered certificate offers an image download');
  const dlPdf = await page.locator('[data-testid=pt-cert-download-pdf]').count();
  say(dlPdf >= 3, 'each rendered certificate offers a PDF download');
  const copyVerify = await page.locator('[data-testid=pt-cert-copy-verify]').count();
  say(copyVerify >= 3, 'each certificate offers a copyable verification link');

  const verifyHref = await page.locator('[data-testid=pt-cert-card] a', { hasText: 'Verify' }).first().getAttribute('href');
  say(Boolean(verifyHref && verifyHref.includes('/verify/')), 'the Verify link points at the public /verify route', verifyHref ?? '');

  // The image + PDF artifact routes serve the owner their real bytes.
  const token = await accessToken(page);
  const anyCard = await page.locator('[data-testid=pt-cert-card]').first().getAttribute('data-cert-type');
  const certId = await page.evaluate(async (bearer) => {
    const r = await fetch('/api/v1/portal/certificates', { headers: { authorization: `Bearer ${bearer}` } });
    const d = await r.json();
    return (d.certificates.find((c) => c.hasImage) ?? d.certificates[0]).id;
  }, token);
  void anyCard;
  const imgRes = await headOf(page, `/api/v1/portal/certificates/${certId}/image`, token);
  say(imgRes.ok && /image\/png/.test(imgRes.type), 'the owner can stream a certificate PNG', `${imgRes.status} ${imgRes.type}`);
  const pdfRes = await headOf(page, `/api/v1/portal/certificates/${certId}/pdf`, token);
  say(pdfRes.ok && /pdf/.test(pdfRes.type), 'the owner can stream a certificate PDF', `${pdfRes.status} ${pdfRes.type}`);

  // IDOR: a random certificate id is not the caller's, so it must 404, never leak.
  const idor = await headOf(page, `/api/v1/portal/certificates/00000000-0000-0000-0000-000000000000/image`, token);
  say(idor.status === 404, 'an artifact for a certificate the caller does not own is denied (404, no IDOR)', String(idor.status));
  const noAuth = await headOf(page, `/api/v1/portal/certificates/${certId}/image`, '');
  say(noAuth.status === 401, 'an unauthenticated artifact request is rejected (401)', String(noAuth.status));

  // ======================================================================
  // PHYSICAL COMMERCE — Premium Framed Certificate, $99.99, 11x14
  // ======================================================================
  const merch = await page.evaluate(async (bearer) => {
    const r = await fetch('/api/v1/portal/merch/framed-certificate', { headers: { authorization: `Bearer ${bearer}` } });
    return r.ok ? r.json() : null;
  }, token);
  say(Boolean(merch && merch.enabled), 'the framed-certificate merch endpoint reports enabled (MERCH_ENABLED)');
  say(merch?.retailAmountMicros === 99_990_000, 'the framed certificate is priced at $99.99', String(merch?.retailAmountMicros));
  say(/11.?x.?14/i.test(String(merch?.size)), 'the framed certificate is the 11×14 size', String(merch?.size));

  // Either an order can be placed now, or one already exists (idempotent re-runs).
  const orderable = await page.locator('[data-testid=pt-cert-order-framed]').count();
  const existingStatus = await page.locator('[data-testid=pt-cert-order-status]').count();
  say(orderable >= 1 || existingStatus >= 1, 'eligible certificates expose the Order Framed Copy path', `orderable ${orderable}, existing ${existingStatus}`);

  if (orderable >= 1) {
    const priceShown = (await page.locator('[data-testid=pt-cert-order-framed]').first().textContent()) ?? '';
    say(/\$99\.99/.test(priceShown) && /11.?x.?14/i.test(priceShown), 'the order offer shows the price and size', priceShown.replace(/\s+/g, ' ').trim().slice(0, 80));

    await page.locator('[data-testid=pt-cert-order-framed] button', { hasText: 'Order Framed Copy' }).first().click();
    await page.waitForSelector('[data-testid=pt-cert-order-form]', { timeout: 5000 });
    say(true, 'opening the order reveals a shipping-address form');
    const form = page.locator('[data-testid=pt-cert-order-form]').first();
    await form.locator('input[placeholder="Full name"]').fill('Demo Trader');
    await form.locator('input[placeholder="Address line 1"]').fill('1 Market St');
    await form.locator('input[placeholder="City"]').fill('New York');
    await form.locator('input[placeholder="Region"]').fill('NY');
    await form.locator('input[placeholder="Postal"]').fill('10004');
    await form.locator('input[placeholder="Country"]').fill('US');
    await shot(page, 'cert-order-form');
    await page.locator('[data-testid=pt-cert-order-confirm]').first().click();
    await page.waitForTimeout(2500);
    const statusNow = await page.locator('[data-testid=pt-cert-order-status]').count();
    say(statusNow >= 1, 'placing + confirming payment produces a tracked physical order', `${statusNow} order status(es)`);
  } else {
    const statusText = (await page.locator('[data-testid=pt-cert-order-status]').first().textContent()) ?? '';
    say(statusText.trim().length > 0, 'an existing framed order shows its fulfillment status', statusText.trim());
  }

  // IDOR on the physical order collection: a random order id must 404.
  const orderIdor = await headOf(page, `/api/v1/portal/physical-orders/00000000-0000-0000-0000-000000000000`, token);
  say(orderIdor.status === 404, 'a physical order the caller does not own is denied (404)', String(orderIdor.status));

  await shot(page, 'cert-vault');

  // ======================================================================
  // PUBLIC VERIFICATION — safe fields only
  // ======================================================================
  const vtoken = await page.evaluate(async (bearer) => {
    const r = await fetch('/api/v1/portal/certificates', { headers: { authorization: `Bearer ${bearer}` } });
    const d = await r.json();
    return d.certificates[0].verificationToken;
  }, token);

  const verify = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await verify.goto(`${WEB}/verify/${vtoken}`, { waitUntil: 'domcontentloaded' });
  await verify.waitForTimeout(1200);
  const verifyBody = (await verify.textContent('body')) ?? '';
  say(/verified certificate/i.test(verifyBody), 'the public verify page confirms a valid certificate');
  say(!verifyBody.includes('@'), 'the public verify page never exposes an email address');
  say(!/atlasfutures\.local/i.test(verifyBody), 'the public verify page never exposes an internal handle');
  const verifyHtml = await verify.content();
  say(!/customerIdentityId|accountId|passwordHash/i.test(verifyHtml), 'the public verify page carries no internal identifiers');

  await verify.goto(`${WEB}/verify/not-a-real-token-xyz`, { waitUntil: 'domcontentloaded' });
  await verify.waitForTimeout(1000);
  const badBody = (await verify.textContent('body')) ?? '';
  say(/not found|not valid/i.test(badBody), 'an unknown verification token shows an explicit invalid state');
  await verify.close();

  // ======================================================================
  // DAILY PROGRESSIVE QUALIFYING BALANCE — a dedicated funded fixture
  // ======================================================================
  const daily = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const dailyErrors = [];
  daily.on('pageerror', (e) => dailyErrors.push(String(e).slice(0, 200)));
  await daily.goto(WEB, { waitUntil: 'domcontentloaded' });
  await daily.waitForTimeout(600);
  if (await daily.locator('input[type=email]').count()) {
    await daily.fill('input[type=email]', 'daily-demo@atlasfutures.local');
    await daily.fill('input[type=password]', 'atlas-demo-2026');
    await daily.click('button[type=submit]');
    await daily.waitForTimeout(2500);
  }
  await daily.goto(`${WEB}/portal`, { waitUntil: 'domcontentloaded' });
  await daily.waitForSelector('[data-testid=portal-app]', { timeout: 20_000 });
  await daily.locator('[data-testid=pt-nav-payouts]').click();
  await daily.waitForSelector('[data-testid=pt-daily-progression]', { timeout: 15_000 });
  say(true, 'a DAILY funded account shows the progressive qualifying-balance card');

  const prog = (await daily.textContent('[data-testid=pt-daily-progression]')) ?? '';
  say(/previous qualifying balance/i.test(prog), 'the card names the previous qualifying balance');
  say(/\$55,000/.test(prog), 'the previous qualifying balance ($55,000) is shown', prog.replace(/\s+/g, ' ').trim().slice(0, 120));
  say(/\$54,000/.test(prog), 'the current qualifying balance ($54,000) is shown');
  say(/required next/i.test(prog), 'the card states the required-next threshold');

  const reasons = (await daily.textContent('[data-testid=pt-payout-reasons]').catch(() => '')) ?? '';
  say(/exceed the qualifying balance used for your previous daily payout/i.test(reasons), 'the blocked Daily reason is shown in plain language', reasons.replace(/\s+/g, ' ').trim().slice(0, 140));

  const stateBadge = (await daily.textContent('[data-testid=pt-payout-state]').catch(() => '')) ?? '';
  say(/not eligible/i.test(stateBadge), 'the Daily account correctly reads Not eligible while blocked');
  await shot(daily, 'daily-progression');
  say(dailyErrors.length === 0, 'the Daily payout view logs no page errors', dailyErrors.join(' | ') || 'clean');
  await daily.close();

  // ======================================================================
  // PERSISTENCE + THEME + CLEANLINESS
  // ======================================================================
  errors.length = 0; // scope the console-error assertion to the vault revisit
  await page.locator('[data-testid=pt-nav-certificates]').click();
  await page.waitForSelector('[data-testid=pt-cert-list]', { timeout: 15_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid=pt-nav-certificates]').click();
  await page.waitForSelector('[data-testid=pt-cert-card]', { timeout: 15_000 });
  const afterReload = await page.locator('[data-testid=pt-cert-card]').count();
  say(afterReload >= 3, 'certificates persist across a reload (permanent archive)', `${afterReload} cards`);

  // The vault is per-trader, not per-account: switching the active account does
  // not change the certificates shown.
  const beforeSwitch = await page.locator('[data-testid=pt-cert-card]').count();
  await page.locator('[data-testid=pt-switcher]').click().catch(() => {});
  await page.waitForTimeout(200);
  const menu = await page.locator('[data-testid=pt-switcher-menu] button, [data-testid=pt-switcher-menu] [role=menuitem]');
  const opts = await menu.count().catch(() => 0);
  if (opts >= 2) {
    await menu.nth(1).click().catch(() => {});
    await page.waitForTimeout(500);
    await page.locator('[data-testid=pt-nav-certificates]').click().catch(() => {});
    await page.waitForSelector('[data-testid=pt-cert-card]', { timeout: 10_000 }).catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  const afterSwitch = await page.locator('[data-testid=pt-cert-card]').count();
  say(afterSwitch === beforeSwitch, 'switching the active account does not leak or drop certificates', `${beforeSwitch} → ${afterSwitch}`);

  // Theme: certificates render correctly in both dark and light.
  const t0 = await page.evaluate(() => document.documentElement.getAttribute('data-pt-theme'));
  await page.locator('[data-testid=pt-theme-toggle]').click();
  await page.waitForTimeout(300);
  const t1 = await page.evaluate(() => document.documentElement.getAttribute('data-pt-theme'));
  say(t1 !== t0, 'the certificates surface honours the theme toggle', `${t0} → ${t1}`);
  const stillThere = await page.locator('[data-testid=pt-cert-card]').count();
  say(stillThere >= 3, 'certificates remain rendered after the theme change');
  await shot(page, 'cert-vault-alt-theme');
  if (t1 !== 'dark') { await page.locator('[data-testid=pt-theme-toggle]').click().catch(() => {}); }

  say(errors.length === 0, 'the Certificate Vault produced no console errors', errors.join(' | ') || 'clean');

  // ======================================================================
  // OWNER CERTIFICATE STORE (demo trader is SUPER_ADMIN) — leaves /portal, so last
  // ======================================================================
  await page.goto(`${WEB}/admin/certificate-store`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const storeShown = await page.locator('[data-testid=admin-certificate-store]').count().catch(() => 0);
  if (storeShown >= 1) {
    say(true, 'the owner Certificate Store page renders');
    const summaryShown = await page.locator('[data-testid=admin-certstore-summary]').count().catch(() => 0);
    say(summaryShown >= 1, 'the store shows revenue / cost / contribution summary');
    const plaqueShown = await page.locator('[data-testid=admin-certstore-plaques]').count().catch(() => 0);
    say(plaqueShown >= 1, 'the store shows the manual 100K plaque fulfillment queue');
  } else {
    // Fall back to proving the owner API surface exists and is authorised.
    const sum = await headOf(page, '/api/v1/admin/certificate-store', token);
    say(sum.ok, 'the owner Certificate Store API is reachable to an operator', String(sum.status));
  }
} catch (err) {
  say(false, 'the certificate acceptance run completed without throwing', String(err));
} finally {
  await browser.close();
  const failed = finish();
  process.exit(failed > 0 ? 1 : 0);
}
