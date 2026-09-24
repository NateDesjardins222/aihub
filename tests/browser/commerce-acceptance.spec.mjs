/**
 * Customer Identity + Whop Commerce + Automatic Provisioning — real-browser
 * acceptance.
 *
 * Drives the actual onboarding UI, the mock checkout surface, and the owner
 * Customer/Commerce console against the real server and database. The
 * security-critical claims are proven end to end: the browser cannot provision
 * from a checkout "success"; only a verified server-side event does; a duplicate
 * event makes no second account; and the owner sees the full lifecycle.
 *
 *   node tests/browser/commerce-acceptance.spec.mjs
 */
import { createReport, launch, signIn, apiFetch, shot, WEB } from './harness.mjs';

const { say, finish, watch } = createReport('commerce-acceptance');
const { browser, page, errors } = await launch({ width: 1440, height: 950 });
watch(page);

async function post(path, body) {
  return apiFetch(page, path, { method: 'POST', body });
}
async function get(path) {
  return apiFetch(page, path);
}

try {
  await signIn(page);

  // -- satisfy the provisioning gate via the API (deterministic setup) --------
  // (The UI can drive these too; the acceptance focuses UI checks on checkout,
  // processing, and the owner console — the parts unique to this milestone.)
  const emailStart = await post('/api/v1/onboarding/contact/start', { channel: 'EMAIL', value: 'demo-buyer@happytrader.test' });
  if (emailStart.body?.challengeId && emailStart.body?.devCode) {
    await post('/api/v1/onboarding/contact/confirm', { challengeId: emailStart.body.challengeId, code: emailStart.body.devCode });
  }
  const smsStart = await post('/api/v1/onboarding/contact/start', { channel: 'SMS', value: '+15550100200' });
  if (smsStart.body?.challengeId && smsStart.body?.devCode) {
    await post('/api/v1/onboarding/contact/confirm', { challengeId: smsStart.body.challengeId, code: smsStart.body.devCode });
  }
  await post('/api/v1/onboarding/identity/start', { legalName: 'Demo Trader', country: 'US' });
  await post('/api/v1/onboarding/identity/resolve', {});
  const agreements = await get('/api/v1/onboarding/agreements');
  if (agreements.body?.current?.length) {
    await post('/api/v1/onboarding/agreements/accept', { versionIds: agreements.body.current.map((a) => a.id) });
  }
  const state = await get('/api/v1/onboarding/state');
  say(state.body?.gate?.satisfied === true, 'the provisioning gate is satisfied after identity + contact + agreements', JSON.stringify(state.body?.gate?.blockedReasons ?? []));

  // -- the onboarding UI reads server state and shows product selection -------
  await page.goto(`${WEB}/onboarding`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=onboarding-app]', { timeout: 20_000 });
  await page.waitForTimeout(1200);
  const onSelect = await page.locator('[data-testid=step-select]').count();
  say(onSelect >= 1, 'the onboarding UI shows the product catalog once the gate is satisfied');

  const productCount = await page.locator('[data-testid=step-select] .ob-product').count();
  say(productCount >= 10, 'the ten locked products are offered', `${productCount} products`);
  await shot(page, 'commerce-onboarding-select');

  // -- security: a checkout order does NOT provision from the client ----------
  const productKey = await page.evaluate(() => {
    const el = document.querySelector('[data-testid^=product-htf-]');
    return el?.getAttribute('data-testid')?.replace('product-', '') ?? null;
  });
  const orderRes = await post('/api/v1/checkout', { productKey });
  const orderId = orderRes.body?.orderId;
  say(Boolean(orderId), 'a checkout creates a PENDING commercial order', productKey ?? 'no product');
  const beforeStatus = await get(`/api/v1/commerce/orders/${orderId}/status`);
  say(beforeStatus.body?.status === 'PENDING' && !beforeStatus.body?.accountId, 'the browser cannot provision: the order is PENDING with no account');

  // -- only a verified server-side event provisions ---------------------------
  const sim = await post('/api/v1/onboarding/dev/simulate-payment', { orderId });
  say(sim.body?.status === 'PROVISIONED', 'a verified server-side payment event provisions the evaluation', sim.body?.status ?? '');
  const afterStatus = await get(`/api/v1/commerce/orders/${orderId}/status`);
  say(afterStatus.body?.status === 'PROVISIONED' && Boolean(afterStatus.body?.accountId), 'the order becomes PROVISIONED with an Atlas account');
  const provisionedAccountId = afterStatus.body?.accountId;

  // -- a duplicate event makes no second account ------------------------------
  await post('/api/v1/onboarding/dev/simulate-payment', { orderId });
  const dupStatus = await get(`/api/v1/commerce/orders/${orderId}/status`);
  say(dupStatus.body?.accountId === provisionedAccountId, 'a duplicate payment event makes no second account (same account id)');

  // -- the checkout + processing UI drives to Account Ready -------------------
  const order2 = await page.evaluate(async () => {
    const el = document.querySelector('[data-testid^=product-htf-]');
    return el?.getAttribute('data-testid') ?? null;
  });
  if (order2) {
    await page.click(`[data-testid=${order2}]`);
    await page.waitForSelector('[data-testid=step-checkout]', { timeout: 10_000 });
    const surface = await page.locator('[data-testid=checkout-surface]').count();
    say(surface >= 1, 'the branded mock checkout surface renders (no real payment)');
    await shot(page, 'commerce-checkout-surface');
    await page.click('[data-testid=checkout-complete]');
    await page.waitForSelector('[data-testid=step-processing]', { timeout: 10_000 });
    // The processing screen is server-state-driven; wait for Account Ready.
    const ready = await page.waitForSelector('[data-testid=step-ready]', { timeout: 30_000 }).catch(() => null);
    say(Boolean(ready), 'the server-state-driven processing screen reaches Account Ready');
    await shot(page, 'commerce-account-ready');
  } else {
    say(false, 'the server-state-driven processing screen reaches Account Ready', 'no product to click');
  }

  // -- owner console: the full lifecycle + reconciliation ---------------------
  await page.goto(`${WEB}/admin/customers`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=admin-customers]', { timeout: 20_000 });
  await page.waitForTimeout(800);
  const reconShown = await page.locator('[data-testid=recon-balanced]').count();
  say(reconShown >= 1, 'the owner console shows reconciliation');
  await page.fill('[data-testid=customer-search]', 'demo@atlasfutures.local');
  await page.click('[data-testid=admin-customers] form button[type=submit]');
  await page.waitForTimeout(1000);
  const rows = await page.locator('[data-testid=customer-results] tbody tr').count();
  say(rows >= 1, 'the owner can search and find the customer', `${rows} row(s)`);
  await page.click('[data-testid=customer-results] tbody tr:first-child a');
  await page.waitForSelector('[data-testid=customer-detail]', { timeout: 10_000 });
  await page.waitForTimeout(600);
  const hasOrders = await page.locator('[data-testid=customer-orders]').count();
  const hasNotifications = await page.locator('[data-testid=customer-notifications]').count();
  say(hasOrders >= 1 && hasNotifications >= 1, 'the customer 360 shows commerce orders and notifications');
  await shot(page, 'commerce-owner-360');

  say(errors.filter((e) => !/favicon/i.test(e)).length === 0, 'no console errors during the flow', errors.slice(0, 2).join(' | '));
} catch (error) {
  say(false, 'the suite ran without throwing', String(error).slice(0, 300));
  await shot(page, 'commerce-acceptance-fail');
} finally {
  await browser.close();
  process.exit(finish());
}
