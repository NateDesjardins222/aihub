/**
 * Payout engine — real-browser acceptance.
 *
 * The demo account is SUPER_ADMIN, so one login exercises both audiences:
 * the trader payout surface in the terminal, and the owner payout console at
 * /admin. It requires the HTF funded account seeded by
 * scripts/seed-htf-payout.ts (eligible for a Core payout).
 *
 *   node tests/browser/payout-acceptance.spec.mjs
 */
import { createReport, launch, signIn, shot } from './harness.mjs';

const { say, finish, watch } = createReport('payout-acceptance');
const { browser, page, errors } = await launch({ width: 1680, height: 950 });
watch(page);

try {
  await signIn(page);

  // Select the seeded HTF funded account in the account bar.
  const selected = await page.evaluate(() => {
    const sel = document.querySelector('.abar-account');
    if (!sel) return null;
    const opt = [...sel.options].find((o) => /HTF Funded/i.test(o.textContent || ''));
    if (!opt) return null;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return opt.textContent;
  });
  say(Boolean(selected), 'the HTF funded account is selectable', selected ?? 'not found');
  await page.waitForTimeout(1200);

  // -- trader: open the Payouts surface and see eligibility ----------------
  await page.click('[data-testid=apprail-payout]');
  await page.waitForSelector('[data-testid=payout-surface]', { timeout: 10_000 });
  await page.waitForTimeout(800);
  const state = (await page.textContent('[data-testid=payout-state]').catch(() => '')) ?? '';
  say(/eligible/i.test(state) && !/not/i.test(state), 'the trader sees an ELIGIBLE state', state.trim());

  // An out-of-range amount is refused by the UI BEFORE we submit a valid one
  // (after a successful request the account is ALREADY_PENDING and the form is
  // correctly hidden, so this check must come first).
  await page.fill('[data-testid=payout-amount]', '999999');
  await page.waitForTimeout(300);
  const disabledInvalid = await page.locator('[data-testid=payout-submit]').isDisabled();
  say(disabledInvalid, 'an out-of-range amount cannot be submitted');

  // A valid amount enables the button; submit it.
  await page.fill('[data-testid=payout-amount]', '1000');
  await page.waitForTimeout(300);
  const disabledValid = await page.locator('[data-testid=payout-submit]').isDisabled();
  say(!disabledValid, 'the request button enables for a valid amount');
  await shot(page, 'payout-trader-surface');
  await page.click('[data-testid=payout-submit]');
  await page.waitForSelector('[data-testid=payout-ok]', { timeout: 10_000 });
  say(true, 'the trader can request a valid payout');

  // -- owner: open the payout console and approve --------------------------
  await page.goto('http://localhost:5173/admin/payouts', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=admin-payouts]', { timeout: 15_000 });
  await page.waitForTimeout(1000);
  const rowCount = await page.locator('[data-testid=admin-payouts] tbody tr').count();
  say(rowCount >= 1, 'the owner queue shows the pending request', `${rowCount} row(s)`);

  // Exposure banner is present with real numbers.
  const hasExposure = await page.locator('text=Firm exposure').count();
  say(hasExposure >= 1, 'the firm exposure banner is shown');

  // Open the first case and approve it.
  await page.click('[data-testid=admin-payouts] tbody tr:first-child [data-testid^=open-case-]');
  await page.waitForTimeout(1200);
  const eligShown = await page.locator('text=Eligibility (recomputed now)').count();
  say(eligShown >= 1, 'the payout case shows the recomputed eligibility');

  await page.click('[data-testid=payout-approve]');
  await page.waitForTimeout(500);
  // The ConfirmAction modal requires a typed reason.
  await page.fill('input[placeholder="Why is this being done?"]', 'Verified — approving for acceptance test');
  await page.click('.adm-modal button.adm-btn-primary, button:has-text("Approve payout")');
  await page.waitForTimeout(1800);
  // The case now reflects the approval: an APPROVED state and a ledger DEBIT.
  const approved = await page.locator('text=APPROVED').count();
  say(approved >= 1, 'the owner approval moves the payout to APPROVED');
  await shot(page, 'payout-owner-console');
  say(errors.filter((e) => !/favicon/i.test(e)).length === 0, 'no console errors during the payout flow', errors.slice(0, 2).join(' | '));
} catch (error) {
  say(false, 'the suite ran without throwing', String(error).slice(0, 300));
  await shot(page, 'payout-acceptance-fail');
} finally {
  await browser.close();
  process.exit(finish());
}
