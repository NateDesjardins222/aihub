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
  // Review #2: the sidebar carries the stacked lockup (desktop) + wide lockup (mobile),
  // both the supplied official asset. At least one renders; CSS shows the right one.
  ok(await page.locator('img.htv2-wordmark[alt="Happy Trader Funding"]').count() >= 1, 'supplied wordmark renders');
  ok(await page.locator('img.htv2-side-logo-stacked').count() === 1, 'stacked brand lockup present (larger logo)');
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
    { key: 'progress', path: '/portal-v2/progress', heading: 'Progress', pageHeading: 'journey' },
    { key: 'billing', path: '/portal-v2/billing', heading: 'Billing' },
    { key: 'support', path: '/portal-v2/support', heading: 'Support' },
    { key: 'dashboard', path: '/portal-v2', heading: 'Dashboard' },
  ];
  for (const n of nav) {
    await page.locator('.htv2-side-link', { hasText: new RegExp(`^${n.heading}$`, 'i') }).first().click();
    await page.waitForTimeout(200);
    const url = new URL(page.url());
    ok(url.pathname === n.path, `${n.heading} → ${n.path} (got ${url.pathname})`);
    ok((await page.locator('h1.ht-t-page-title, .htv2-section-title', { hasText: new RegExp(n.pageHeading ?? n.heading, 'i') }).count()) > 0, `${n.heading} renders a real heading`);
  }

  console.log('Accounts master/detail + account detail tabs:');
  await page.goto(`${BASE}/portal-v2/accounts`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(200);
  // Review #3: Accounts is a brokerage LEDGER + flat statement workspace, not a card wall.
  ok(await page.locator('[data-testid="htv2-accounts-ledger"]').count() === 1, 'accounts ledger table renders');
  ok(await page.locator('[data-testid="htv2-accounts-row"]').count() > 1, 'ledger lists multiple accounts');
  ok(await page.locator('[data-testid="htv2-account-workspace"]').count() === 1, 'account statement workspace renders');
  ok(await page.locator('[data-testid="htv2-accounts-filter-all"]').count() === 1, 'account state nav present');
  await page.locator('[data-testid="htv2-open-full-account"]').first().click();
  await page.waitForTimeout(250);
  ok(page.url().includes('/portal-v2/accounts/'), 'Open full account opens an account detail route');
  ok(await page.locator('[data-testid="htv2-detail"]').count() === 1, 'detail surface renders');
  for (const t of ['overview', 'performance', 'controls', 'rules', 'activity']) {
    await page.locator(`[data-testid="htv2-detail-tab-${t}"]`).click();
    await page.waitForTimeout(120);
    ok(await page.locator(`[data-testid="htv2-detail-tab-${t}"][aria-selected="true"]`).count() === 1, `tab ${t} activates`);
  }
  await page.locator('[data-testid="htv2-detail-back"]').click();
  await page.waitForTimeout(150);
  ok(page.url().endsWith('/portal-v2/accounts'), 'detail back → accounts');

  console.log('R2 — Profile & account center (from the account menu):');
  await page.goto(`${BASE}/portal-v2`, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="htv2-account-menu"]').click();
  await page.waitForTimeout(150);
  await page.locator('.htv2-acctmenu-pop button', { hasText: /profile/i }).first().click();
  await page.waitForTimeout(200);
  ok(page.url().endsWith('/portal-v2/profile'), 'account menu → profile route');
  ok(await page.locator('[data-testid="htv2-profile-tab-security"]').count() === 1, 'profile has a Security section');
  await page.locator('[data-testid="htv2-profile-tab-verification"]').click();
  await page.waitForTimeout(120);
  ok(await page.locator('[data-testid="htv2-profile-verification"]').count() === 1, 'verification pane renders (KYC distinct from display name)');

  console.log('R3 — Certificates show actual artwork + preview modal:');
  await page.goto(`${BASE}/portal-v2/certificates`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  ok(await page.locator('[data-testid="htv2-cert-cat-funded"]').count() === 1, 'Funded category tab present');
  ok(await page.locator('.htv2-certtile-img').count() >= 1, 'actual rendered certificate artwork is visible in the vault');
  await page.locator('[data-testid="htv2-cert"]').first().click();
  await page.waitForTimeout(300);
  ok(await page.locator('[data-testid="htv2-cert-modal"]').count() === 1, 'clicking a certificate opens the large preview');
  ok(await page.locator('.htv2-certmodal-img').count() === 1, 'preview shows the full rendered artifact');
  ok(await page.locator('[data-testid="htv2-cert-verify"]').count() === 1, 'preview offers Verify');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.locator('[data-testid="htv2-cert-cat-payouts"]').click();
  await page.waitForTimeout(120);
  ok(await page.locator('[data-testid="htv2-cert"]').count() >= 1, 'payouts category filters the vault');

  console.log('EXP1 — Progress & Achievements (journey, clubs, goals):');
  await page.goto(`${BASE}/portal-v2/progress`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
  ok(await page.locator('[data-testid="htv2-progress-hero"]').count() === 1, 'progress hero renders');
  ok(await page.locator('[data-testid="htv2-progress-timeline"]').count() === 1, 'journey timeline renders');
  ok(await page.locator('[data-testid="htv2-club-card"]').count() === 3, 'three trader clubs render');
  ok(await page.locator('[data-testid="htv2-progress-goals"]').count() === 1, 'personal goals render');
  // Create a goal through the real dialog (dev harness local state).
  await page.locator('[data-testid="htv2-progress-new-goal"]').click();
  await page.waitForTimeout(150);
  ok(await page.locator('[data-testid="htv2-goal-dialog"]').count() === 1, 'goal dialog opens');
  await page.locator('[data-testid="htv2-goal-title"]').fill('Browser-check goal');
  await page.locator('[data-testid="htv2-goal-save"]').click();
  await page.waitForTimeout(200);
  ok((await page.locator('[data-testid="htv2-goal-card"]').count()) >= 1, 'a goal card is present after creating');
  // Metallic focal accent (aura) is used on the hero lifetime-paid value.
  ok(await page.locator('.htv2-progress .htv2-metal-champagne').count() >= 1, 'hero uses a metallic focal accent');
  // Zero-customer: truthful zeros, no clubs achieved.
  await page.goto(`${BASE}/portal-v2/progress?state=empty`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(200);
  ok(await page.locator('[data-testid="htv2-club-achieved"]').count() === 0, 'zero-customer has no achieved clubs');

  console.log('EXP1 — reduced motion is honored (no transitions/animations at rest):');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${BASE}/portal-v2/progress`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(200);
  const motionOff = await page.evaluate(() => {
    const el = document.querySelector('.htv2-prog-hero');
    if (!el) return false;
    const d = getComputedStyle(el).animationDuration;
    // reduced-motion collapses animation durations to ~0.001ms
    return d === '0.001ms' || d === '0s';
  });
  ok(motionOff, 'prefers-reduced-motion collapses entrance animation');
  await page.emulateMedia({ reducedMotion: null });

  console.log('R2 — Payouts premium hero + Billing payment method:');
  await page.goto(`${BASE}/portal-v2/payouts`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(120);
  ok(await page.locator('[data-testid="htv2-payout-hero"]').count() === 1, 'payouts premium hero present');
  await page.goto(`${BASE}/portal-v2/billing`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(120);
  ok(await page.locator('[data-testid="htv2-billing-paymethod"]').count() === 1, 'billing payment method present (safe projection)');

  console.log('R2 — Zero-customer state shows zeros, not demo data:');
  await page.goto(`${BASE}/portal-v2?state=empty`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(150);
  const emptyDash = (await page.locator('body').innerText()).toLowerCase();
  ok(emptyDash.includes('welcome to happy trader') || emptyDash.includes("don't have any accounts"), 'zero-customer dashboard shows a welcome/empty state');
  await page.goto(`${BASE}/portal-v2/accounts?state=empty`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(150);
  ok(await page.locator('[data-testid="htv2-accounts-empty"]').count() === 1, 'zero-customer accounts shows empty state, not demo records');
  await page.goto(`${BASE}/portal-v2/certificates?state=empty`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(150);
  ok(await page.locator('[data-testid="htv2-cert"]').count() === 0, 'zero-customer certificates shows none');

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
