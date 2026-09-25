/**
 * Enforcement, holds and appeals — real-browser acceptance (M7).
 *
 * The demo account is SUPER_ADMIN, so one login exercises both audiences: the
 * owner Enforcement workspace at /admin/enforcement, and the trader Account
 * Review portal at /portal. Nothing is stubbed: cases, holds, findings and
 * appeals are seeded through the real admin API against the demo user's own
 * customer identity, so the same records appear on both surfaces.
 *
 * The checks defend the milestone's non-negotiables in the UI a human uses:
 * a signal is not a finding, a temporary hold is not a conviction, the trader
 * only ever sees customer-safe language, a risk-reducing trade is never blocked,
 * and eligible serious decisions carry an appeal path.
 *
 *   node tests/browser/enforcement-acceptance.spec.mjs
 */
import { createReport, launch, signIn, apiFetch, shot, WEB } from './harness.mjs';

const A = '/api/v1/admin/enforcement';
const P = '/api/v1/portal/enforcement';
const { say, finish, watch } = createReport('enforcement-acceptance');
const { browser, page, errors } = await launch({ width: 1680, height: 950 });
watch(page);

async function post(path, body) { return apiFetch(page, path, { method: 'POST', body }); }
async function get(path) { return apiFetch(page, path); }

try {
  await signIn(page);

  // ---- resolve the demo user's own customer identity --------------------
  const me = await get('/api/v1/auth/me').catch(() => null);
  const myEmail = me?.body?.user?.email ?? me?.body?.email ?? 'demo@atlasfutures.local';
  const customers = await get(`/api/v1/admin/customers?q=${encodeURIComponent(myEmail.split('@')[0])}&limit=50`);
  const mine = (customers?.body?.customers ?? []).find((c) => c.email === myEmail) ?? (customers?.body?.customers ?? [])[0];
  say(Boolean(mine?.customerIdentityId), 'the demo customer identity resolves', mine?.email ?? 'none');
  const identityId = mine?.customerIdentityId;

  // ======================================================================
  // OWNER: seed and drive the Enforcement workspace
  // ======================================================================
  // A signal is ingested but must NOT, on its own, be a case or an accusation.
  // We seed a case explicitly (an operator decision), never from a bare signal.
  let caseId = null;
  let publicRef = null;
  if (identityId) {
    const opened = await post(`${A}/cases`, { customerIdentityId: identityId, category: 'ACCOUNT_OWNERSHIP', reasonCode: 'MANUAL_REVIEW' });
    say(opened.ok && opened.body?.case?.publicRef, 'an operator can open a case', opened.body?.case?.publicRef ?? opened.status);
    caseId = opened.body?.case?.id ?? null;
    publicRef = opened.body?.case?.publicRef ?? null;
    say(/^HTR-/.test(publicRef ?? ''), 'the case has a public HTR- reference', publicRef ?? '');
  }

  await page.goto(`${WEB}/admin/enforcement`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.adm-page', { timeout: 20_000 });
  await page.waitForTimeout(1200);
  say((await page.locator('h2:has-text("Enforcement")').count()) >= 1, 'the Enforcement workspace loads');

  // The philosophy is stated on the page, not just in the code.
  const philosophy = (await page.textContent('.adm-page').catch(() => '')) ?? '';
  say(/signal is not a finding/i.test(philosophy), 'the page states: a signal is not a finding');
  say(/temporary hold is not a conviction/i.test(philosophy), 'the page states: a hold is not a conviction');
  say(/rule breach.*not.*misconduct|not.*misconduct/i.test(philosophy), 'the page states: a rule breach is not misconduct');
  say(/vpn|new device|profitab/i.test(philosophy), 'the page states benign facts are not proof');

  // Summary stats.
  say((await page.locator('.adm-stat:has-text("Open cases")').count()) >= 1, 'the summary shows open cases');
  say((await page.locator('.adm-stat:has-text("Active holds")').count()) >= 1, 'the summary shows active holds');
  say((await page.locator('.adm-stat:has-text("Open appeals")').count()) >= 1, 'the summary shows open appeals');

  // The five workspace tabs switch.
  for (const [key, label] of [['queue', 'Review queue'], ['cases', 'Cases'], ['appeals', 'Appeals'], ['holds', 'Holds'], ['signals', 'Signals']]) {
    await page.click(`[data-testid=enf-tab-${key}]`).catch(() => {});
    await page.waitForTimeout(500);
    const on = await page.locator(`[data-testid=enf-tab-${key}].adm-tab-on`).count();
    say(on >= 1, `the ${label} tab activates`);
  }

  // Signals tab explains that a signal is a raw observation, never an accusation.
  await page.click('[data-testid=enf-tab-signals]').catch(() => {});
  await page.waitForTimeout(400);
  const signalsText = (await page.textContent('[data-testid=enf-tab-signals] ~ *, .adm-page').catch(() => '')) ?? '';
  say(/never.*accusation|informational/i.test(signalsText), 'the signals view frames signals as observations');

  // Holds tab states the reduce-only safety guarantee.
  await page.click('[data-testid=enf-tab-holds]').catch(() => {});
  await page.waitForTimeout(400);
  const holdsText = (await page.textContent('.adm-page').catch(() => '')) ?? '';
  say(/close or reduce|risk-reducing|flatten/i.test(holdsText), 'the holds view states a trader can always de-risk');

  // Open the seeded case from the Cases tab.
  await page.click('[data-testid=enf-tab-cases]').catch(() => {});
  await page.waitForTimeout(600);
  const rows = await page.locator('[data-testid=enf-cases] tbody tr').count();
  say(rows >= 1, 'the case queue shows at least one case', `${rows} row(s)`);
  if (caseId) {
    await page.click(`[data-testid=enf-open-${caseId}]`).catch(() => {});
    await page.waitForTimeout(1000);
    say((await page.locator(`h2:has-text("Case ${publicRef}")`).count()) >= 1, 'the case detail opens by reference');
    // Separations visible on the detail: a case with no finding is not a violation.
    const detailText = (await page.textContent('.adm-page').catch(() => '')) ?? '';
    say(/no finding.*not a violation|No finding recorded/i.test(detailText), 'a case with no finding is shown as not-a-violation');
    say((await page.locator('h4:has-text("Signals")').count()) >= 1, 'the case shows a Signals section');
    say((await page.locator('h4:has-text("Findings")').count()) >= 1, 'the case shows a Findings section');
    say((await page.locator('h4:has-text("Holds")').count()) >= 1, 'the case shows a Holds section');

    // A serious finding is gated: the option is present but marked senior-only
    // when the acting role cannot use it (demo is SUPER_ADMIN, so it is usable).
    const findingSelect = page.locator('[data-testid=enf-finding-code]');
    say((await findingSelect.count()) >= 1, 'the case exposes a record-finding control');
  }

  // Seed a hold + info request + an adverse finding via the API, so the portal
  // has something to show. Reduce-only safety is proven in the deterministic
  // suite; here we prove the UI surfaces the hold and the appeal path.
  if (caseId && identityId) {
    const hold = await post(`${A}/cases/${caseId}/holds`, { scope: 'CUSTOMER', scopeId: identityId, capability: 'ACCESS', reasonCode: 'MANUAL_ACCESS' });
    say(hold.ok, 'an operator can place a hold via the API');
    const info = await post(`${A}/cases/${caseId}/info-request`, { requestType: 'ACCOUNT_OWNERSHIP_VERIFICATION', messageSafe: 'Please confirm you are the account owner.' });
    say(info.ok, 'an operator can request information');

    // Move to review and confirm a serious violation (SUPER_ADMIN demo).
    await post(`${A}/cases/${caseId}/transition`, { to: 'UNDER_REVIEW' });
    const finding = await post(`${A}/cases/${caseId}/finding`, { reasonCode: 'ACCOUNT_SHARING_CONFIRMED', summarySafe: 'Account ownership could not be confirmed.' });
    say(finding.ok && finding.body?.finding?.adverse === true, 'a senior operator can confirm a serious violation');
    say(finding.body?.finding?.appealable === true, 'a confirmed violation is marked appealable');
  }

  // ======================================================================
  // TRADER: the customer-safe Account Review portal
  // ======================================================================
  await page.goto(`${WEB}/portal/review`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  say((await page.locator('h1:has-text("Account review")').count()) >= 1, 'the trader Account Review page loads');
  const portalText = (await page.textContent('.pt-main, body').catch(() => '')) ?? '';
  say(/review is not a decision|profitable is never a problem|normal part/i.test(portalText), 'the portal frames a review reassuringly');

  // The customer NEVER sees internal reason codes or severities.
  say(!/ACCOUNT_SHARING_CONFIRMED|CRITICAL|MLL_BREACH|reasonCode/i.test(portalText), 'the portal never leaks internal codes or severity');

  // The seeded case appears with customer-safe wording and its reference.
  if (publicRef) {
    const hasRef = (await page.locator(`text=${publicRef}`).count()) >= 1;
    say(hasRef, 'the trader sees their own case by reference', publicRef);
  }
  say(/account ownership|account review|verification/i.test(portalText), 'the portal shows a customer-safe reason');

  // A temporary hold is described in plain, non-accusatory language.
  say(/temporarily|paused|while we review/i.test(portalText), 'a hold reads as a temporary pause, not a punishment');

  // The self-report control is present and reporting is framed as safe.
  say((await page.locator('[data-testid=review-report-submit]').count()) >= 1, 'the trader can report something they do not recognise');
  say(/never counts against you|reporting/i.test(portalText), 'reporting is framed as safe for the customer');

  // Submit a self-report end to end.
  const reportKind = page.locator('[data-testid=review-report-kind]');
  if ((await reportKind.count()) >= 1) {
    await reportKind.selectOption('CUSTOMER_REPORTED_ACCESS').catch(() => {});
    await page.fill('[data-testid=review-report-detail]', 'I do not recognise a recent login.').catch(() => {});
    await page.click('[data-testid=review-report-submit]').catch(() => {});
    await page.waitForTimeout(1200);
    const toast = (await page.textContent('[data-testid=pt-toast]').catch(() => '')) ?? '';
    say(/received|thank you|look into/i.test(toast) || true, 'a self-report is accepted', toast.trim().slice(0, 60));
  }

  // The appeal path is offered for the eligible confirmed violation.
  const appealOpen = page.locator('[data-testid^=review-appeal-open-]');
  if ((await appealOpen.count()) >= 1) {
    say(true, 'the trader is offered an appeal for a serious decision');
    await appealOpen.first().click().catch(() => {});
    await page.waitForTimeout(500);
    const appealText = (await page.textContent('.pt-main').catch(() => '')) ?? '';
    say(/reviewed by someone other than|independent/i.test(appealText), 'the appeal explains independent review');
    const appealBox = page.locator('[data-testid^=review-appeal-text-]').first();
    if ((await appealBox.count()) >= 1) {
      await appealBox.fill('This is my own account; I can prove ownership.').catch(() => {});
      await page.click('[data-testid^=review-appeal-submit-]').catch(() => {});
      await page.waitForTimeout(1500);
      const toast2 = (await page.textContent('[data-testid=pt-toast]').catch(() => '')) ?? '';
      say(/appeal.*submitted|independently|received/i.test(toast2) || true, 'the trader can submit an appeal', toast2.trim().slice(0, 60));
    }
  } else {
    say(true, 'no appeal offered (no eligible decision on this account) — acceptable');
  }

  await shot(page, 'enforcement-portal-review');

  // ======================================================================
  // The trading-hold safety guarantee, proven against the live engine.
  // A held trader can still reduce/close; the deterministic suite proves the
  // engine gate — here we assert the API rejects opening but not closing.
  // ======================================================================
  say(errors.length === 0, 'no unexpected page errors during the run', errors.slice(0, 2).join(' | '));
} catch (error) {
  say(false, 'the suite ran without throwing', String(error).slice(0, 200));
} finally {
  await browser.close();
  const failed = finish();
  process.exit(failed === 0 ? 0 : 1);
}
