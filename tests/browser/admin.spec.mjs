/**
 * The operator console.
 *
 * Driven the way an operator drives it, against the real admin API and the
 * real execution engine. The permission checks here are about the SERVER: the
 * console hides what a role may not do, but the test that matters is that the
 * API refuses it, which is covered in the server suite. What this checks is
 * that an operator can find an account, watch it, and act on it with the
 * confirmation and the reason the platform demands.
 */
import { createReport, launch, shot, signIn, WEB } from './harness.mjs';

const { say, finish, watch } = createReport('admin');
const { browser, page, errors } = await launch({ width: 1600, height: 1000 });
watch(page);

async function go(path) {
  await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_500);
}

try {
  await signIn(page);
  await go('/admin');

  // --- the console loads at all -------------------------------------------
  say(
    (await page.locator('.adm-brand').count()) === 1,
    'the operator console has its own shell, not the terminal chrome',
  );
  say(
    (await page.locator('.chart-canvas').count()) === 0,
    'the trading terminal is not mounted underneath it',
  );

  const overview = await page.locator('.adm-stats').innerText();
  say(/USERS/.test(overview) && /ACCOUNTS/.test(overview), 'the overview reports the platform totals');
  say(
    /BALANCES/.test(overview) && /\$/.test(overview),
    'money is shown, and it came from the server',
  );

  await page.click('.adm-panel-head:has-text("Account status") .adm-btn');
  await page.waitForTimeout(1_500);
  const verification = await page.locator('.adm-note').innerText().catch(() => '');
  say(/verified|BROKEN/.test(verification), 'the audit chain can be verified from here', verification);
  await shot(page, 'admin-overview');

  // --- accounts ------------------------------------------------------------
  await page.click('.adm-nav-item:has-text("Accounts")');
  await page.waitForTimeout(2_000);
  const rows = await page.locator('[data-testid=admin-accounts] tbody tr').count();
  say(rows > 0, 'every account is listed', `${rows} accounts`);

  const firstNumber = await page
    .locator('[data-testid=admin-accounts] tbody tr td')
    .first()
    .innerText();
  say(/^SIM-\d{6}$/.test(firstNumber.trim()), 'accounts carry a public number', firstNumber.trim());

  await page.fill('.adm-search input', firstNumber.trim());
  await page.click('.adm-search button');
  await page.waitForTimeout(1_500);
  say(
    (await page.locator('[data-testid=admin-accounts] tbody tr').count()) === 1,
    'searching by account number finds exactly it',
  );
  await shot(page, 'admin-accounts');

  // --- one account ---------------------------------------------------------
  await page.locator('[data-testid=admin-accounts] tbody tr').first().click();
  await page.waitForTimeout(3_000);
  say(
    (await page.locator('.adm-detail-head h1').innerText()).trim() === firstNumber.trim(),
    'opening a row opens that account',
  );

  const live = await page.locator('[data-testid=admin-live]').innerText();
  say(/BALANCE/.test(live) && /EQUITY/.test(live), 'the live panel shows the engine valuation');
  say(/RULE STATE/.test(live), 'and where the account stands against its rules');

  const sections = await page.locator('.adm-panel-head h2').allTextContents();
  for (const wanted of ['Live', 'Rules in force', 'Orders', 'Rule violations', 'Closed trades', 'Audit trail']) {
    say(sections.includes(wanted), `the account page has a ${wanted.toLowerCase()} section`);
  }
  say(/Lifecycles/.test(sections.join(' ')), 'and its lifecycle history');
  await shot(page, 'admin-account');

  // --- a destructive action demands a reason -------------------------------
  await page.click('[data-testid=admin-actions] .adm-btn:has-text("Lock")');
  await page.waitForTimeout(600);
  say(
    (await page.locator('[data-testid=admin-confirm]').count()) === 1,
    'a destructive action asks for confirmation',
  );
  const confirmDisabled = await page
    .locator('[data-testid=admin-confirm] .adm-btn-danger')
    .isDisabled();
  say(confirmDisabled, 'and will not proceed without a reason');

  await page.fill('[data-testid=admin-confirm] input', 'Browser suite: locking to prove the flow');
  await page.click('[data-testid=admin-confirm] .adm-btn-danger');
  await page.waitForTimeout(2_500);
  const status = await page.locator('.adm-detail-head .adm-pill').innerText();
  say(/locked/i.test(status), 'the account is locked', status);

  const audit = await page.locator('.adm-panel:has-text("Audit trail") .adm-table').innerText();
  say(
    /admin.account.locked/.test(audit) && /Browser suite/.test(audit),
    'the reason and the action are in the audit trail',
  );

  // Put it back, so the suite leaves nothing changed behind it.
  await page.click('[data-testid=admin-actions] .adm-btn:has-text("Unlock")');
  await page.waitForTimeout(600);
  await page.fill('[data-testid=admin-confirm] input', 'Browser suite: restoring');
  await page.locator('[data-testid=admin-confirm] .adm-btn-danger').click();
  await page.waitForTimeout(2_500);
  say(
    /active/i.test(await page.locator('.adm-detail-head .adm-pill').innerText()),
    'and can be unlocked again',
  );

  // --- traders (the Users route, labelled "Traders" in the nav) ------------
  await page.click('.adm-nav-item:has-text("Traders")');
  await page.waitForTimeout(2_000);
  const userRows = await page.locator('[data-testid=admin-users] tbody tr').count();
  say(userRows > 0, 'users are listed', `${userRows} users`);

  await page.locator('[data-testid=admin-users] tbody tr').first().click();
  await page.waitForTimeout(2_000);
  const userPanels = await page.locator('.adm-panel-head h2').allTextContents();
  say(
    userPanels.some((title) => title.startsWith('Accounts')),
    'a user page lists the accounts they own',
  );
  say(userPanels.includes('Activity'), 'and their activity');

  // --- the terminal is untouched -------------------------------------------
  await go('/');
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(2_000);
  say(
    (await page.locator('.adm-brand').count()) === 0,
    'nothing admin-shaped appears in the trading terminal',
  );

  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  await browser.close();
}

process.exit(finish());
