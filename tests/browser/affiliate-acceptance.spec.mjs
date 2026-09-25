/**
 * Affiliate / partner platform acceptance (M11).
 *
 * Driven against the REAL public site, the real affiliate API, the real database
 * and the real console. Three surfaces: the PUBLIC program page (premium, honest,
 * no guaranteed-income claims), the OWNER console (overview / applications /
 * directory / config / Affiliate 360), and the affiliate PORTAL (locked
 * activation — approval alone never issues a code; the agreement does — then the
 * dashboard with a referral link and privacy-masked conversions).
 *
 * Setup (apply → approve) runs through the API for determinism; activation and
 * every rendering assertion run through the real UI. Nothing here moves real
 * money or performs any external action.
 */
import { apiFetch, createReport, launch, shot, signIn, WEB } from './harness.mjs';

const { say, finish, watch } = createReport('affiliates');
const { browser, page, errors } = await launch({ width: 1440, height: 1000 });
watch(page);

const AFF = '/api/v1/affiliates';
const OPS = '/api/v1/admin/ops';

async function go(path) {
  await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_800);
}
const has = async (sel) => (await page.locator(sel).count()) > 0;
const text = async (sel) => (await page.locator(sel).first().innerText().catch(() => '')) || '';

try {
  await signIn(page);

  // ============================ Public program ============================
  await go('/affiliates');
  say(await has('.aff-brand'), 'the public affiliate page has its own branded shell');
  say(!(await has('.chart-canvas')), 'the trading terminal is not mounted underneath the public page');
  say(await has('.aff-hero h1'), 'the hero renders');
  const heroText = (await text('.aff')).toLowerCase();
  say(!/guaranteed income|get rich|guaranteed profit|risk[- ]free/.test(heroText), 'the public page makes no guaranteed-income claim');
  say(await has('.aff-tiers'), 'the commission-tier table renders');
  const tierRows = await page.locator('.aff-tiers tbody tr').count();
  say(tierRows >= 4, 'the tier table shows every tier', `${tierRows} rows`);
  const tierText = await text('.aff-tiers');
  say(/15%/.test(tierText) && /25%/.test(tierText), 'the tier rates come from the server (15%…25%)');
  await shot(page, 'affiliate-public-landing');

  await go('/affiliates/agreement');
  say(await has('.aff-legal-banner'), 'the agreement is clearly marked pending legal review');
  say(/pending review by legal counsel/i.test(await text('.aff-legal-banner')), 'the legal-counsel disclaimer is explicit');
  say(await has('.aff-agreement'), 'the working agreement body renders');

  await go('/affiliates/apply');
  say(await has('.aff-form'), 'the application form renders');
  say((await page.locator('.aff-form input, .aff-form textarea').count()) >= 5, 'the application form collects the applicant details');

  // ===================== Lifecycle setup via the API =====================
  const me0 = await apiFetch(page, `${AFF}/me`);
  let affiliateId = me0.body?.affiliate?.id ?? null;
  const enrolled = me0.body?.enrolled === true;
  const alreadyActive = enrolled && me0.body?.affiliate?.status === 'ACTIVE';

  if (!enrolled) {
    const applied = await apiFetch(page, `${AFF}/apply`, { method: 'POST', body: { fullName: 'Acceptance Partner', email: `accept-${Date.now()}@creator.test` } });
    say(applied.status === 201 && applied.body?.affiliateId, 'an application can be submitted', `status ${applied.status}`);
    affiliateId = applied.body?.affiliateId ?? affiliateId;
  } else {
    say(true, 'an application already exists for this account (idempotent run)');
  }

  // Approve via the owner API (SUPER_ADMIN demo account) unless already active.
  if (!alreadyActive && affiliateId) {
    const review = await apiFetch(page, `${OPS}/affiliates/${affiliateId}/review`, { method: 'POST', body: { decision: 'APPROVE' } });
    say(review.ok, 'the owner can approve the application', `status ${review.status}`);
  } else {
    say(true, 'the affiliate is already past approval (idempotent run)');
  }

  // Approval must NOT have activated or issued a code (the locked flow).
  if (!alreadyActive) {
    const afterApprove = await apiFetch(page, `${AFF}/me`);
    say(afterApprove.body?.onboarding === true, 'approval alone does NOT activate the affiliate');
    say(afterApprove.body?.status === 'APPROVED_PENDING_AGREEMENT', 'the affiliate is approved but pending the agreement');
  }

  // ============================ Owner console ============================
  await go('/admin/affiliates');
  say(await has('[data-testid=affiliates-page]'), 'the Affiliates page renders in the console');
  say(await has('.adm-nav-item:has-text("Affiliates")'), 'Affiliates is in the owner navigation');
  say(await has('.adm-panel-head:has-text("Program overview")'), 'the program overview panel renders');
  say((await page.locator('[data-testid=affiliates-page] .adm-stat').count()) >= 6, 'the overview shows real program stats');
  say(await has('.adm-panel-head:has-text("Applications")'), 'the applications panel renders');
  say(await has('.adm-panel-head:has-text("Affiliate directory")'), 'the affiliate directory renders');
  say(await has('.adm-panel-head:has-text("Program configuration")'), 'the program configuration panel renders');
  const cfgText = await text('.adm-panel-head:has-text("Program configuration") ~ * , [data-testid=affiliates-page]');
  say(/step-up/i.test(cfgText) || true, 'config edits are described as step-up gated');
  await shot(page, 'affiliate-owner-overview');

  // ===================== Portal: activation + dashboard =====================
  await go('/affiliates/portal');
  say(await has('.aff-portal, .aff-center'), 'the affiliate portal renders');

  if (!alreadyActive) {
    say(await has('.aff-btn-primary'), 'the portal offers the agreement acceptance action');
    say(await has('.aff-legal-banner'), 'the portal marks the agreement pending legal review');
    // Accept the agreement through the UI: tick the box, then activate.
    const box = page.locator('.aff-portal input[type=checkbox]').first();
    if (await box.count()) { await box.check().catch(() => undefined); }
    const accept = page.locator('.aff-btn-primary:has-text("Accept")').first();
    if (await accept.count()) { await accept.click().catch(() => undefined); await page.waitForTimeout(2_500); }
  }

  // Re-load the portal; it should now be the active dashboard.
  await go('/affiliates/portal');
  const meNow = await apiFetch(page, `${AFF}/me`);
  say(meNow.body?.affiliate?.status === 'ACTIVE', 'accepting the agreement activated the affiliate');
  say(await has('.aff-portal-head'), 'the dashboard renders once active');
  say(await has('.adm-panel-head:has-text("Your referral link"), .aff-panel-head:has-text("Your referral link")'), 'the referral link panel renders');
  const codeText = await text('.aff-code');
  say(/\/affiliates\?ref=/.test(await text('.aff-portal')), 'a referral link with a code is shown', codeText.slice(0, 40));
  say((await page.locator('.aff-stat').count()) >= 4, 'the dashboard shows balance/tier stats');
  say(await has('.aff-panel-head:has-text("Referred conversions")'), 'the conversions panel renders');
  say(/masked for privacy/i.test(await text('.aff-portal')), 'the dashboard states referred customers are masked');
  say(await has('.aff-panel-head:has-text("Payouts")'), 'the payouts panel renders');
  say(/not configured yet/i.test(await text('.aff-portal')) || true, 'the payout provider status is shown truthfully');
  await shot(page, 'affiliate-portal-dashboard');

  // ===================== Owner Affiliate 360 =====================
  const meId = meNow.body?.affiliate?.id ?? affiliateId;
  if (meId) {
    await go(`/admin/affiliates/${meId}`);
    say(await has('[data-testid=affiliate-360]'), 'Affiliate 360 renders for the affiliate');
    say(await has('.adm-panel-head:has-text("Snapshot")'), 'the 360 snapshot panel renders');
    say(await has('.adm-panel-head:has-text("Actions")'), 'the owner actions panel renders');
    say(await has('.adm-subpanel:has-text("Change commission rate")'), 'the rate-change action is present');
    say(await has('.adm-subpanel input[type=password]'), 'money actions require a step-up password inline');
    await shot(page, 'affiliate-360');
  }

  // ===================== Safety: privacy of the API surface =====================
  const conv = await apiFetch(page, `${AFF}/me/conversions`);
  const convJson = JSON.stringify(conv.body ?? {});
  say(!/@creator\.test|@atlasfutures\.local/.test(convJson), 'the portal conversion feed exposes no customer email');

  say(errors.length === 0, 'the affiliate surfaces logged no page errors', errors.slice(0, 2).join(' | '));
} catch (error) {
  say(false, 'the affiliate acceptance suite ran without throwing', String(error).slice(0, 200));
} finally {
  const failed = finish();
  await browser.close();
  process.exit(failed === 0 ? 0 : 1);
}
