/**
 * M10.1 hardening — adversarial browser acceptance.
 *
 * Red-teams the Owner OS through the real browser and the real API: every ops
 * read must reject an unauthenticated caller (401) and serve the authenticated
 * owner (200); every state-truth surface must stay honest (Rithmic/market-data
 * never faked, SIMULATION badge); every high-risk write must refuse without a
 * step-up; and the console must render the safety surfaces. Non-destructive: it
 * never engages a broad kill switch, never places a trade, never moves money.
 */
import { apiFetch, createReport, launch, shot, signIn, WEB } from './harness.mjs';

const { say, finish, watch } = createReport('m10-1-hardening');
const { browser, page, errors } = await launch({ width: 1680, height: 1000 });
watch(page);

const OPS = '/api/v1/admin/ops';
const ADMIN = '/api/v1/admin';
const OK = new Set(['HEALTHY', 'DEGRADED', 'CRITICAL', 'WARNING']);
async function go(path) { await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2_000); }
const has = async (sel) => (await page.locator(sel).count()) > 0;

// Ops read endpoints that must be authenticated + authorized.
const READS = [
  `${OPS}/command-center`, `${OPS}/daily-brief`, `${OPS}/finance/summary`, `${OPS}/agreements`,
  `${OPS}/search?q=demo`, `${OPS}/events?limit=5`, `${OPS}/system/doctor`, `${OPS}/system/integrity`,
  `${OPS}/system/reconciliation`, `${OPS}/providers`, `${OPS}/market-data`, `${OPS}/jobs`,
  `${OPS}/incidents`, `${OPS}/alerts`, `${OPS}/alerts/channels`, `${OPS}/config/flags`,
  `${OPS}/config/kill-switches`, `${OPS}/tasks`, `${ADMIN}/staff`, `${ADMIN}/me/access`,
];

try {
  await signIn(page);

  // ---- 1. Unauthenticated rejection across every ops read (in-page fetch, no auth) ----
  for (const path of READS) {
    const status = await page.evaluate(async (p) => (await fetch(p, { headers: { 'content-type': 'application/json' } })).status, path);
    say(status === 401, `unauthenticated is refused: ${path}`, String(status));
  }

  // ---- 2. Authenticated owner is served across every ops read ----
  for (const path of READS) {
    const r = await apiFetch(page, path);
    say(r.ok, `owner is served: ${path}`, String(r.status));
  }

  // ---- 3. State-truth surfaces stay honest ----
  const providers = await apiFetch(page, `${OPS}/providers`);
  const rith = (providers.body?.providers ?? []).find((p) => p.provider === 'RITHMIC');
  say(rith && rith.verified === false, 'Rithmic provider verified=false (never faked)');
  say(rith != null && typeof rith.configured === 'boolean', 'Rithmic configured state reported truthfully as a real boolean', rith ? String(rith.note ?? '') : '');
  const md = await apiFetch(page, `${OPS}/market-data`);
  say((md.body?.instruments?.length ?? 0) === 8, 'market-data lists 8 launch instruments');
  say((md.body?.instruments ?? []).every((i) => i.status === 'NOT_VERIFIED'), 'all instruments NOT_VERIFIED (never faked)');
  const doctor = await apiFetch(page, `${OPS}/system/doctor`);
  say(OK.has(doctor.body?.overall), 'doctor reports a real status', doctor.body?.overall);
  const rDoc = (doctor.body?.checks ?? []).find((c) => /rithmic/i.test(c.key));
  say(!rDoc || !/(^|[^t])\bverified\b/i.test(String(rDoc.actual)) || /not/i.test(String(rDoc.actual)), 'doctor never claims Rithmic verified');
  const channels = await apiFetch(page, `${OPS}/alerts/channels`);
  const ext = (channels.body?.channels ?? []).filter((c) => c.channel !== 'IN_APP');
  say(ext.length === 0 || ext.some((c) => /NOT_CONFIGURED/i.test(c.status ?? '')), 'external channels truthful (NOT_CONFIGURED)');

  // ---- 4. Integrity invariants + kill switches present ----
  const integ = await apiFetch(page, `${OPS}/system/integrity`);
  const invKeys = (integ.body?.checks ?? []).map((c) => c.key);
  for (const k of ['INV_ACTIVE_ACCOUNTS_PER_IDENTITY', 'INV_PAYOUT_CYCLES', 'INV_PAID_PAYOUT_HAS_DEBIT', 'INV_NO_DOUBLE_DEBIT', 'INV_AUDIT_CHAIN_INTACT']) {
    say(invKeys.includes(k), `integrity invariant present: ${k}`);
  }
  const ks = await apiFetch(page, `${OPS}/config/kill-switches`);
  const ksKeys = (ks.body?.switches ?? []).map((s) => s.key);
  for (const k of ['DISABLE_NEW_PURCHASES', 'DISABLE_PROVISIONING', 'DISABLE_NEW_ORDERS', 'DISABLE_NEW_PAYOUT_REQUESTS', 'DISABLE_PAYOUT_SUBMISSION', 'DISABLE_EXTERNAL_EXECUTION', 'MAINTENANCE_MODE']) {
    say(ksKeys.includes(k), `kill switch present: ${k}`);
  }

  // ---- 5. High-risk writes refuse without a step-up token (apiFetch cannot forward one) ----
  const wrongPw = await apiFetch(page, `${ADMIN}/security/reauth`, { method: 'POST', body: { password: 'definitely-wrong', class: 'FINANCIAL' } });
  say(wrongPw.status === 401, 'reauth with wrong password refused (401)', String(wrongPw.status));
  const killNoStep = await apiFetch(page, `${OPS}/config/kill-switches/MAINTENANCE_MODE/engage`, { method: 'POST', body: { reason: 'probe' } });
  say(killNoStep.status === 403, 'kill-switch engage refused without step-up (403)', String(killNoStep.status));
  const inviteNoStep = await apiFetch(page, `${ADMIN}/staff/invite`, { method: 'POST', body: { email: 'probe@x.z', role: 'SUPPORT' } });
  say(inviteNoStep.status === 403, 'staff invite refused without step-up (403)', String(inviteNoStep.status));

  // ---- 6. Money-safety: adjustments fail closed on bad input (need a real account) ----
  const acctSearch = await apiFetch(page, `${OPS}/search?q=SIM-`);
  const acct = (acctSearch.body?.groups ?? []).find((g) => g.type === 'account')?.results?.[0];
  if (acct) {
    // No step-up header → reauth refuses before the handler (403). Also confirms
    // an adjustment is never a casual, unauthenticated mutation.
    const adj = await apiFetch(page, `${OPS}/accounts/${acct.id}/adjust`, { method: 'POST', body: { type: 'CREDIT', amountMicros: 1000000, reasonCode: 'OTHER', explanation: 'probe adjustment' } });
    say(adj.status === 403, 'balance adjustment refused without FINANCIAL step-up (403)', String(adj.status));
    const obj = await apiFetch(page, `${OPS}/objects/account/${acct.id}`);
    say(obj.ok && !JSON.stringify(obj.body ?? {}).includes('passwordHash'), 'object explorer never leaks password material');
    say(obj.ok && obj.body?.type === 'account', 'object explorer resolves an account');
  } else {
    say(true, 'no account to probe (skipped)');
    say(true, 'no account to explore (skipped)');
    say(true, 'no account for explorer type check (skipped)');
  }

  // ---- 7. Console renders the safety surfaces ----
  await go('/admin/command');
  say(await has('[data-testid=command-center]'), 'Command Center renders');
  say(await has('[data-testid=cc-overall]'), 'overall-health banner renders');
  say(await has('[data-testid=admin-env-badge]'), 'environment badge present');
  const badge = (await page.locator('[data-testid=admin-env-badge]').innerText().catch(() => '')) || '';
  say(/SIMULATION/.test(badge), 'env badge reads SIMULATION (external live off)', badge.trim());
  say(await has('[data-testid=admin-theme-toggle]'), 'dark/light toggle present');
  const m0 = await page.evaluate(() => document.documentElement.dataset.themeMode ?? 'dark');
  await page.click('[data-testid=admin-theme-toggle]'); await page.waitForTimeout(1_000);
  const m1 = await page.evaluate(() => document.documentElement.dataset.themeMode ?? 'dark');
  say(m0 !== m1, 'theme toggle changes the document theme', `${m0}→${m1}`);
  await page.click('[data-testid=admin-theme-toggle]'); await page.waitForTimeout(800);

  await go('/admin/ops-system');
  say(await has('[data-testid=owner-system]'), 'System page renders');
  for (const t of ['System Doctor', 'Data Integrity', 'Reconciliation', 'Providers (truthful)', 'Kill switches']) {
    say(await has(`.adm-panel-head:has-text("${t}")`), `System page panel: ${t}`);
  }
  say(await has('[data-testid=kill-switches]'), 'kill-switch table renders');
  const provText = (await page.locator('.adm-panel:has(.adm-panel-head:has-text("Providers"))').innerText().catch(() => '')) || '';
  say(/NOT VERIFIED/i.test(provText), 'System page shows Rithmic NOT VERIFIED (no fake green)');
  await shot(page, 'm10-1-system');

  await go('/admin/staff');
  say(await has('[data-testid=staff-page]'), 'Staff page renders');
  say(await has('.adm-panel-head:has-text("Staff")'), 'staff directory panel renders');
  say((await page.locator('[data-testid=staff-page] tbody tr').count()) >= 1, 'at least one staff member listed');

  // ---- 8. No unexpected console errors (deliberate 403/401 probes excluded) ----
  const real = errors.filter((e) => !/\b40[13]\b|Forbidden|Unauthorized/.test(e));
  say(real.length === 0, 'no unexpected console errors', real.slice(0, 2).join(' | '));
} catch (error) {
  say(false, 'the hardening run completed without throwing', String(error).slice(0, 200));
  await shot(page, 'm10-1-crash');
} finally {
  const failed = finish();
  await browser.close();
  process.exit(failed === 0 ? 0 : 1);
}
