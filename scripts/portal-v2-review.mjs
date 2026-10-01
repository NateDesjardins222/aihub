/**
 * Portal V2 customer-review browser acceptance (human-rejection #1 repair).
 *
 * Real headless-Chromium proof of the things the human rejection was about:
 *  - the supplied wordmark renders; no fake square;
 *  - EVERY sidebar destination navigates and renders real content (no dead links);
 *  - account detail + all tabs work; Trade/Details hierarchy present;
 *  - the account menu is real (opens; Sign out; owner entry only with ?role=owner);
 *  - Owner Console is absent from a normal customer's DOM;
 *  - NO dev/engineering content in the customer DOM;
 *  - no page-level horizontal overflow at desktop or mobile.
 *
 * Usage: dev server on :5173, then `node scripts/portal-v2-review.mjs`.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const EXE = process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium';
let failures = 0;
const ok = (c, m) => { if (c) { console.log(`  ✓ ${m}`); } else { console.error(`  ✗ ${m}`); failures += 1; } };

const browser = await chromium.launch({ executablePath: EXE, headless: true });

async function run() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE}/portal-v2`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  console.log('Brand:');
  ok(await page.locator('img.htv2-wordmark[alt="Happy Trader Funding"]').count() === 1, 'supplied wordmark renders');
  ok(await page.locator('.htv2-side-mark').count() === 0, 'no fake square brand mark');

  console.log('No dev/engineering content in customer DOM:');
  const bodyText = (await page.locator('body').innerText()).toLowerCase();
  for (const phrase of ['design system', 'overflow-proof', '220px', 'representative values', 'component harness', 'component showcase']) {
    ok(!bodyText.includes(phrase), `DOM has no "${phrase}"`);
  }
  // "DEV" tag badge gone from nav
  ok(await page.locator('.htv2-side-tag').count() === 0, 'no DEV nav tag');

  console.log('Owner Console absent for a normal customer:');
  ok(!bodyText.includes('owner console'), 'no "owner console" text in customer DOM');
  await page.locator('[data-testid="htv2-account-menu"]').click();
  await page.waitForTimeout(150);
  const menuText = (await page.locator('.htv2-acctmenu-pop').innerText()).toLowerCase();
  ok(menuText.includes('sign out'), 'account menu has Sign out');
  ok(!menuText.includes('owner console'), 'account menu has no Owner Console for customer');
  await page.keyboard.press('Escape');

  console.log('Every sidebar destination navigates to real content:');
  const nav = [
    { key: 'accounts', path: '/portal-v2/accounts', heading: 'Accounts' },
    { key: 'payouts', path: '/portal-v2/payouts', heading: 'Payouts' },
    { key: 'certificates', path: '/portal-v2/certificates', heading: 'Certificates' },
    { key: 'billing', path: '/portal-v2/billing', heading: 'Billing' },
    { key: 'support', path: '/portal-v2/support', heading: 'Support' },
    { key: 'dashboard', path: '/portal-v2', heading: 'Dashboard' },
  ];
  for (const n of nav) {
    await page.locator('.htv2-side-link', { hasText: new RegExp(`^${n.heading}$`, 'i') }).first().click();
    await page.waitForTimeout(200);
    const url = new URL(page.url());
    ok(url.pathname === n.path, `${n.heading} → ${n.path} (got ${url.pathname})`);
    ok((await page.locator('h1.ht-t-page-title, .htv2-section-title', { hasText: new RegExp(n.heading, 'i') }).count()) > 0, `${n.heading} renders a real heading`);
  }

  console.log('Account detail + tabs:');
  await page.goto(`${BASE}/portal-v2/accounts`, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="htv2-account-panel"]').first().locator('button', { hasText: 'Details' }).click();
  await page.waitForTimeout(250);
  ok(page.url().includes('/portal-v2/accounts/'), 'Details opens an account detail route');
  ok(await page.locator('[data-testid="htv2-detail"]').count() === 1, 'detail surface renders');
  for (const t of ['overview', 'performance', 'controls', 'rules', 'activity']) {
    await page.locator(`[data-testid="htv2-detail-tab-${t}"]`).click();
    await page.waitForTimeout(120);
    ok(await page.locator(`[data-testid="htv2-detail-tab-${t}"][aria-selected="true"]`).count() === 1, `tab ${t} activates`);
  }
  await page.locator('[data-testid="htv2-detail-back"]').click();
  await page.waitForTimeout(150);
  ok(page.url().endsWith('/portal-v2/accounts'), 'detail back → accounts');

  console.log('No horizontal page overflow:');
  for (const w of [1920, 1440, 1280, 1024, 768, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    for (const path of ['/portal-v2', '/portal-v2/accounts', '/portal-v2/payouts']) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(120);
      const over = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      ok(!over, `no horizontal overflow @ ${w} ${path}`);
    }
  }

  console.log('Owner entry appears only with ?role=owner (utility surface, not nav):');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/portal-v2?role=owner`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(200);
  const navText = (await page.locator('.htv2-side-nav').innerText()).toLowerCase();
  ok(!navText.includes('owner'), 'owner still NOT in sidebar nav even as owner');
  await page.locator('[data-testid="htv2-account-menu"]').click();
  await page.waitForTimeout(150);
  const ownerMenu = (await page.locator('.htv2-acctmenu-pop').innerText()).toLowerCase();
  ok(ownerMenu.includes('owner console'), 'owner entry present in account menu with ?role=owner');

  await page.close();
}

try {
  await run();
} finally {
  await browser.close();
}
console.log(failures === 0 ? '\nALL PORTAL V2 REVIEW CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
