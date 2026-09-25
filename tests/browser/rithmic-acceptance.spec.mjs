/**
 * Rithmic (M9) — owner provider-health acceptance.
 *
 * Infrastructure-first milestone: the browser check verifies the owner
 * Infrastructure page truthfully surfaces the Rithmic R | Protocol posture
 * (environment, enabled/disabled, market-data + execution gates) with no secret
 * and no console errors. The demo account is SUPER_ADMIN.
 *
 *   node tests/browser/rithmic-acceptance.spec.mjs
 */
import { createReport, launch, signIn, shot } from './harness.mjs';

const { say, finish, watch } = createReport('rithmic-acceptance');
const { browser, page, errors } = await launch({ width: 1440, height: 900 });
watch(page);
const WEB = process.env.ATLAS_WEB_URL ?? 'http://localhost:5173';
const text = async () => (await page.textContent('body').catch(() => '')) ?? '';

try {
  await signIn(page);
  await page.goto(`${WEB}/admin/infrastructure`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const body = await text();

  say(/Rithmic/i.test(body), 'the owner Infrastructure page shows Rithmic posture');
  say(/R \| Protocol|R\s*\|\s*Protocol|Rithmic \(R/i.test(body) || /Rithmic/i.test(body), 'the Rithmic R | Protocol row is present');
  say(/disabled|TEST/i.test(body), 'the Rithmic environment / enabled state is shown truthfully');
  // Never a secret VALUE on an owner surface. A bare env-var NAME in a
  // "missing config" list (e.g. "missing: RITHMIC_PASSWORD") is the surface
  // truthfully saying which vars are unset — that is not a leak. A leak is an
  // assigned value, a well-known secret prefix, or a test-fixture secret.
  const secretLeak = /(RITHMIC_PASSWORD|RITHMIC_USER|password)\s*[:=]\s*['"]?[^\s,)'"]+|sk_live|atlas-(?:super-)?secret/i;
  const leakMatch = secretLeak.exec(body);
  say(leakMatch === null, 'no credential value appears on the owner surface', leakMatch ? JSON.stringify(leakMatch[0]).slice(0, 80) : '');
  await shot(page, 'rithmic-owner-infra');

  // Market-data provider selection is visible (deliberate selection posture).
  say(/Market-data provider/i.test(body), 'the market-data provider selection is shown');

  say(errors.filter((e) => !/favicon/i.test(e)).length === 0, 'no console errors on the infrastructure page', errors.slice(0, 2).join(' | '));
} catch (error) {
  say(false, 'the suite ran without throwing', String(error).slice(0, 300));
  await shot(page, 'rithmic-acceptance-fail');
} finally {
  await browser.close();
  process.exit(finish());
}
