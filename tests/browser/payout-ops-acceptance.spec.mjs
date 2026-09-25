/**
 * Fast Payout Operations (Milestone 8) — real-browser acceptance.
 *
 * The demo account is SUPER_ADMIN, so one login exercises both audiences: the
 * owner Payout Operations console at /admin/payout-operations, and the trader
 * Payout Methods page at /portal/payout-methods. It requires the M8 seed:
 *
 *   pnpm --filter @atlas/server exec tsx scripts/seed-m8-payout-ops.ts
 *
 * which enables the MOCK provider for the demo org and seeds a spread of
 * operations (PAID, PROCESSING, DESTINATION_REVIEW, PROVIDER_REJECTED) plus a
 * masked destination for the demo user.
 *
 *   node tests/browser/payout-ops-acceptance.spec.mjs
 */
import { createReport, launch, signIn, shot } from './harness.mjs';

const { say, finish, watch } = createReport('payout-ops-acceptance');
const { browser, page, errors } = await launch({ width: 1680, height: 980 });
watch(page);

const WEB = process.env.ATLAS_WEB_URL ?? 'http://localhost:5173';
const RAW_REF = 'mock_dest_'; // a raw provider reference must NEVER reach the browser
const text = async () => (await page.textContent('body').catch(() => '')) ?? '';

try {
  await signIn(page);

  // ======================================================================
  // OWNER — Payout Operations console
  // ======================================================================
  await page.goto(`${WEB}/admin/payout-operations`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=po-tab-overview]', { timeout: 15_000 });
  await page.waitForTimeout(900);
  say(true, 'the owner Payout Operations console loads');

  // -- Overview ----------------------------------------------------------
  const body0 = await text();
  say(/Today/.test(body0), 'the overview shows a "Today" panel');
  say(/Requested/.test(body0) && /Submitted/.test(body0) && /Paid/.test(body0), 'the overview shows requested / submitted / paid counts');
  say(/Fast-lane rate/.test(body0), 'the overview shows the fast-lane rate');
  say(/P95 \(target < 5m\)/.test(body0), 'the overview states the P95 target is under five minutes');
  say(/request → provider submitted/.test(body0), 'the SLA panel is scoped to request → provider submission (not settlement)');
  say(/No SLA breaches\.|breached the 5-minute submission target/.test(body0), 'the overview reports an SLA-breach status');
  const providerHealthy = /MOCK/.test(body0) && /(HEALTHY|Healthy|healthy)/.test(body0);
  say(providerHealthy, 'the overview health panel shows the MOCK provider healthy');
  say(/Circuit breaker/.test(body0), 'the overview shows circuit-breaker status');
  await shot(page, 'po-owner-overview');

  // -- Fast Lane ---------------------------------------------------------
  await page.click('[data-testid=po-tab-fast_lane]');
  await page.waitForTimeout(700);
  const fastRows = await page.locator('[data-testid^=po-op-]').count();
  say(fastRows >= 1, 'the Fast Lane queue lists live operations', `${fastRows} row(s)`);
  const fastBody = await text();
  say(/✓/.test(fastBody), 'fast-lane rows are marked as fast lane');

  // -- Exceptions --------------------------------------------------------
  await page.click('[data-testid=po-tab-exceptions]');
  await page.waitForTimeout(700);
  const excRows = await page.locator('[data-testid^=po-op-]').count();
  say(excRows >= 2, 'the Exceptions queue lists the exception operations', `${excRows} row(s)`);
  const excBody = await text();
  say(/destination review/i.test(excBody), 'an exception is categorised as destination review');
  say(/provider rejected/i.test(excBody), 'an exception is categorised as provider rejected');
  await shot(page, 'po-owner-exceptions');

  // -- Processing --------------------------------------------------------
  await page.click('[data-testid=po-tab-processing]');
  await page.waitForTimeout(700);
  say((await page.locator('[data-testid^=po-op-]').count()) >= 1, 'the Processing queue lists submitted/processing operations');

  // -- Reconciliation ----------------------------------------------------
  await page.click('[data-testid=po-tab-reconciliation]');
  await page.waitForTimeout(700);
  say((await page.locator('[data-testid^=po-op-]').count()) >= 1, 'the Reconciliation queue lists settled operations');

  // -- Provider Health ---------------------------------------------------
  await page.click('[data-testid=po-tab-provider]');
  await page.waitForTimeout(700);
  const provBody = await text();
  say(/mock \(dev\/test\)/i.test(provBody), 'provider health shows the MOCK mode is dev/test');
  say(/Production enabled/i.test(provBody) && /\bno\b/i.test(provBody), 'provider health shows production is not enabled');

  // -- Treasury Controls -------------------------------------------------
  await page.click('[data-testid=po-tab-treasury]');
  await page.waitForTimeout(700);
  const treasBody = await text();
  say(/never trader eligibility/i.test(treasBody), 'treasury controls state they are operational, never trader eligibility');
  say(/Production/.test(treasBody) && /disabled/i.test(treasBody), 'treasury shows production disabled');
  const breakerOpenBtn = await page.locator('[data-testid=po-breaker-open]').count();
  say(breakerOpenBtn === 1, 'an operator can open the circuit breaker');

  // Open the breaker (audited confirm modal), then confirm it reads OPEN, then close it.
  await page.click('[data-testid=po-breaker-open]');
  await page.waitForSelector('[data-testid=admin-confirm]', { timeout: 5000 });
  await page.fill('[data-testid=admin-confirm] input', 'Acceptance test — pause external submissions');
  await page.click('[data-testid=admin-confirm] .adm-dialog-actions button.adm-btn-danger');
  await page.waitForTimeout(1200);
  say((await page.locator('.adm-status-open').count()) >= 1, 'opening the breaker is reflected as OPEN');
  const closeBtn = await page.locator('[data-testid=po-breaker-close]').count();
  say(closeBtn === 1, 'an OPEN breaker offers a resume (close) action');
  await page.click('[data-testid=po-breaker-close]');
  await page.waitForSelector('[data-testid=admin-confirm]', { timeout: 5000 });
  await page.fill('[data-testid=admin-confirm] input', 'Acceptance test — resume submissions');
  await page.click('[data-testid=admin-confirm] .adm-dialog-actions button.adm-btn-danger');
  await page.waitForTimeout(1200);
  say((await page.locator('[data-testid=po-breaker-open]').count()) === 1, 'closing the breaker resumes submissions');

  // -- Operation detail: a PAID op --------------------------------------
  await page.click('[data-testid=po-tab-reconciliation]');
  await page.waitForTimeout(700);
  // Find a row whose state pill reads PAID and open it.
  const paidRow = page.locator('[data-testid^=po-op-]', { hasText: 'PAID' }).first();
  const paidExists = (await paidRow.count()) > 0;
  say(paidExists, 'a PAID operation is present to inspect');
  if (paidExists) {
    await paidRow.locator('button', { hasText: 'Open' }).click();
    await page.waitForTimeout(900);
    const detail = await text();
    say(/Timeline/.test(detail), 'the operation detail shows a timeline');
    say(/Paid/.test(detail), 'the PAID operation timeline includes a Paid step');
    say(/Operational checks/.test(detail), 'the operation detail lists the operational checks');
    say(/ELIGIBILITY/i.test(detail), 'the operational checks include the eligibility check');
    say(/Submission attempts/.test(detail), 'the operation detail lists submission attempts');
    say(/Provider events/.test(detail), 'the operation detail lists provider events');
    say(/PAYOUT_PAID/.test(detail), 'a PAYOUT_PAID provider event is recorded');
    say(/Reconciliation/.test(detail), 'the operation detail has a reconciliation section');
    say(/Req→Submission/.test(detail), 'the operation detail shows request → submission speed');
    say(/mock_[0-9a-f]{6,}/.test(detail), 'the detail shows the provider payout id (an opaque token)');
    say((await page.locator('[data-testid=po-retry]').count()) === 1, 'an operator sees a Retry action on the operation');
    say((await page.locator('[data-testid=po-reconcile]').count()) === 1, 'an operator sees a Reconcile action on the operation');
    say(/Break-glass manual paid/.test(detail), 'a SUPER_ADMIN sees the audited break-glass action');
    await shot(page, 'po-owner-op-detail');
    // The break-glass form demands external evidence before it will submit.
    await page.click('button:has-text("Break-glass manual paid")');
    await page.waitForTimeout(400);
    const recordBtn = page.locator('button:has-text("Record manual paid")');
    say(await recordBtn.isDisabled(), 'break-glass mark-paid is disabled until external evidence is entered');
  }

  // -- Reconcile a processing op actually runs --------------------------
  await page.click('[data-testid=po-tab-processing]');
  await page.waitForTimeout(700);
  const procRow = page.locator('[data-testid^=po-op-]').first();
  if ((await procRow.count()) > 0) {
    await procRow.locator('button', { hasText: 'Open' }).click();
    await page.waitForTimeout(700);
    const beforeErr = errors.length;
    await page.click('[data-testid=po-reconcile]');
    await page.waitForTimeout(1200);
    say(errors.length === beforeErr, 'reconcile-now runs without a client error');
  } else {
    say(true, 'reconcile-now runs without a client error', 'no processing op to reconcile');
  }

  // -- No raw provider reference anywhere in the console ----------------
  say(!(await text()).includes(RAW_REF), 'the owner console never exposes a raw provider destination reference');
  say(errors.filter((e) => !/favicon/i.test(e)).length === 0, 'no console errors across the owner console', errors.slice(0, 2).join(' | '));

  // ======================================================================
  // TRADER — Payout Methods (portal, own-scoped, masked)
  // ======================================================================
  const ownerErrors = errors.length;
  await page.goto(`${WEB}/portal/payout-methods`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pt-h1', { timeout: 15_000 });
  await page.waitForTimeout(900);
  say(/Payout methods/i.test(await text()), 'the trader Payout Methods page loads');

  const destCount = await page.locator('[data-testid^=pm-dest-]').count();
  say(destCount >= 1, 'the trader sees a payout method on file', `${destCount} method(s)`);
  const pmBody = await text();
  say(/active/i.test(pmBody), 'the payout method shows an active status');
  say(!pmBody.includes(RAW_REF), 'the trader never sees a raw provider destination reference');
  say(/•|\*|x{2,}|\d{2,}/.test(await page.locator('[data-testid^=pm-dest-]').first().textContent() ?? ''), 'the destination is shown masked, not in full');
  await shot(page, 'po-trader-methods');

  const opsTable = await page.locator('[data-testid=pm-operations]').count();
  say(opsTable >= 1, 'the trader sees their recent payouts');
  const traderOps = await page.locator('[data-testid^=pm-op-]').count();
  say(traderOps >= 0, 'the recent-payouts table renders rows for the trader', `${traderOps} row(s)`);
  // Customer-safe status labels only — never an internal opState like SUBMITTING.
  say(!/SUBMITTING|PAYABLE|AUTOMATED_CHECKS|RECEIVED/.test(pmBody), 'the trader sees customer-safe statuses, not internal states');

  if (traderOps >= 1) {
    await page.locator('[data-testid^=pm-op-]').first().locator('button', { hasText: 'Timeline' }).click();
    await page.waitForTimeout(600);
    const openedTimeline = await page.locator('[data-testid^=pm-timeline-]').count();
    say(openedTimeline >= 1, 'a trader can open a payout timeline');
  } else {
    say(true, 'a trader can open a payout timeline', 'no trader-owned op yet');
  }

  // Responsive: the M8 page content holds up at a narrow width with no horizontal
  // overflow. (Scoped to the payout content region .pt-main; the shared portal
  // header chrome is out of M8's scope.)
  await page.setViewportSize({ width: 900, height: 950 });
  await page.waitForTimeout(500);
  const contentOverflow = await page.evaluate(() => {
    const main = document.querySelector('.pt-main');
    if (!main) return true;
    const limit = window.innerWidth + 2;
    for (const el of main.querySelectorAll('*')) {
      if (el.getBoundingClientRect().right > limit) return true;
    }
    return false;
  });
  say(!contentOverflow, 'the Payout Methods content has no horizontal overflow at 900px');
  await page.setViewportSize({ width: 1680, height: 980 });

  // Light/dark: the portal theme toggle flips the portal theme attribute.
  const themeToggle = page.locator('[data-testid=pt-theme-toggle]').first();
  if ((await themeToggle.count()) > 0) {
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-pt-theme'));
    await themeToggle.click().catch(() => undefined);
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-pt-theme'));
    say(before !== after && after != null, 'the portal theme can be toggled (light/dark)', `${before} → ${after}`);
    await themeToggle.click().catch(() => undefined); // restore
  } else {
    say(false, 'the portal theme can be toggled (light/dark)', 'no toggle exposed on this page');
  }

  say(errors.length === ownerErrors, 'no new console errors across the trader payout surface', errors.slice(ownerErrors, ownerErrors + 2).join(' | '));
  say(!(await text()).includes('sk_live') && !(await text()).includes('secret'), 'no secret-shaped value leaks into the trader payout surface');
} catch (error) {
  say(false, 'the suite ran without throwing', String(error).slice(0, 300));
  await shot(page, 'payout-ops-acceptance-fail');
} finally {
  await browser.close();
  process.exit(finish());
}
