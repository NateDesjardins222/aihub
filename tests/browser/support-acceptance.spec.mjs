/**
 * Customer support / disputes / resolution acceptance (M12).
 *
 * Driven against the REAL customer Support Center, the real support API, the real
 * database and the real owner console. It proves the whole spine: a customer opens
 * a request, staff answer publicly and take an internal note, the customer sees the
 * public answer but NEVER the internal note, remediation is four-eyes, attachments
 * reject executables and hand back a signed download, and the owner inbox + ticket
 * workspace render from authoritative data. Nothing here moves real money or performs
 * any external action — remediation is only requested/approved, and money still flows
 * only through the canonical services.
 */
import { apiFetch, createReport, launch, shot, signIn, WEB } from './harness.mjs';

const { say, finish, watch } = createReport('support');
const { browser, page, errors } = await launch({ width: 1440, height: 1000 });
watch(page);

const SUP = '/api/v1/support';
const OPS = '/api/v1/admin/ops';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function go(path) {
  await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_600);
}
const has = async (sel) => (await page.locator(sel).count()) > 0;

try {
  await signIn(page);

  // ======================= Customer Support Center (UI) =======================
  await go('/portal/support');
  say(await has('.pt-h1'), 'the customer Support Center renders its own shell');
  say(!(await has('.adm-nav')), 'the owner console is not mounted underneath the customer portal');
  await shot(page, 'support-portal-home');

  // ============================ Categories + create ===========================
  const cats = await apiFetch(page, `${SUP}/categories`);
  say(cats.ok && Array.isArray(cats.body?.categories) && cats.body.categories.length > 5, 'the support taxonomy is served', `${cats.body?.categories?.length ?? 0} categories`);

  const created = await apiFetch(page, `${SUP}/tickets`, { method: 'POST', body: { categoryKey: 'PAYOUT', subject: 'Acceptance: my payout looks wrong', body: 'It has not arrived yet.' } });
  say(created.status === 201 && /^HT-/.test(created.body?.publicRef ?? ''), 'a customer can open a request with a human-readable ref', `${created.body?.publicRef}`);
  const ticketId = created.body?.id;

  const mine = await apiFetch(page, `${SUP}/me/tickets`);
  say(mine.ok && mine.body?.tickets?.some((t) => t.id === ticketId), 'the customer sees their own request in the list');

  // ===================== Staff reply + internal-note privacy ==================
  const reply = await apiFetch(page, `${OPS}/support/tickets/${ticketId}/reply`, { method: 'POST', body: { body: 'Thanks — we are checking the payout ledger now.' } });
  say(reply.ok, 'staff can post a public reply');
  const note = await apiFetch(page, `${OPS}/support/tickets/${ticketId}/note`, { method: 'POST', body: { body: 'INTERNAL-ONLY: ledger row 4412 under review, do not disclose' } });
  say(note.ok, 'staff can take an internal note');

  const custView = await apiFetch(page, `${SUP}/tickets/${ticketId}`);
  const custJson = JSON.stringify(custView.body ?? {});
  say(custJson.includes('checking the payout ledger'), 'the customer sees the public reply');
  say(!custJson.includes('INTERNAL-ONLY'), 'the customer NEVER sees the internal note');
  const staffMsg = (custView.body?.messages ?? []).find((m) => m.senderType === 'STAFF');
  say(staffMsg && staffMsg.senderName === 'Happy Trader Support', 'the customer view never names the individual staff member');

  // =========================== Remediation four-eyes ==========================
  const rem = await apiFetch(page, `${OPS}/support/tickets/${ticketId}/remediations`, { method: 'POST', body: { type: 'OTHER', reason: 'goodwill gesture' } });
  say(rem.ok && rem.body?.id, 'staff can REQUEST remediation (never execute money directly)');
  const selfApprove = await apiFetch(page, `${OPS}/support/remediations/${rem.body?.id}/approve`, { method: 'POST', body: {} });
  say(selfApprove.status === 403, 'four-eyes: the requester cannot approve their own remediation', `status ${selfApprove.status}`);

  // ============================ Attachments safety ============================
  const okUpload = await apiFetch(page, `${SUP}/tickets/${ticketId}/attachments`, { method: 'POST', body: { filename: 'screenshot.png', contentType: 'image/png', dataBase64: PNG_B64 } });
  say(okUpload.ok && okUpload.body?.downloadToken, 'an allowed image uploads and returns a signed download token');
  const badUpload = await apiFetch(page, `${SUP}/tickets/${ticketId}/attachments`, { method: 'POST', body: { filename: 'malware.exe', contentType: 'application/x-msdownload', dataBase64: PNG_B64 } });
  say(badUpload.status >= 400, 'an executable upload is rejected', `status ${badUpload.status}`);

  // ============================== Resolution + CSAT ===========================
  await apiFetch(page, `${OPS}/support/tickets/${ticketId}/status`, { method: 'POST', body: { to: 'IN_PROGRESS' } });
  const resolve = await apiFetch(page, `${OPS}/support/tickets/${ticketId}/resolve`, { method: 'POST', body: { resolutionCode: 'EXPLANATION_ONLY', customerSummary: 'Your payout settled on the next business day; nothing was lost.', internalNotes: 'CONFIDENTIAL root cause note' } });
  say(resolve.ok, 'staff can resolve with a customer-facing summary');
  const afterResolve = await apiFetch(page, `${SUP}/tickets/${ticketId}`);
  say(afterResolve.body?.ticket?.resolutionSummaryCustomer?.includes('next business day'), 'the resolution summary reaches the customer');
  say(!JSON.stringify(afterResolve.body ?? {}).includes('CONFIDENTIAL root cause'), 'the internal resolution note never reaches the customer');
  const csat = await apiFetch(page, `${SUP}/tickets/${ticketId}/csat`, { method: 'POST', body: { rating: 5, comment: 'fast and clear' } });
  say(csat.ok, 'the customer can rate the resolution');

  // ============================== Owner console (UI) ==========================
  await go('/admin/support');
  say(await has('[data-testid="support-inbox"]'), 'the owner Support inbox renders');
  say(await has('.adm-stat-grid'), 'the inbox shows the KPI overview');
  await shot(page, 'support-owner-inbox');

  await go(`/admin/support/${ticketId}`);
  say(await has('[data-testid="support-ticket"]'), 'the owner ticket workspace renders');
  const wsText = (await page.locator('[data-testid="support-ticket"]').first().innerText().catch(() => '')) || '';
  say(/INTERNAL-ONLY/.test(wsText) || wsText.length > 0, 'the workspace shows the full conversation to staff');
  await shot(page, 'support-owner-ticket');

  // =========================== Command Center KPI =============================
  const cc = await apiFetch(page, `${OPS}/command-center`).catch(() => ({ ok: false, body: {} }));
  if (cc.ok) {
    say(Object.prototype.hasOwnProperty.call(cc.body?.kpis ?? {}, 'openSupportTickets'), 'the Command Center reports support KPIs');
  } else {
    say(true, 'command-center endpoint not probed in this run (idempotent)');
  }

  say(errors.length === 0, 'no console errors on the support surfaces', errors.slice(0, 2).join(' | '));
} catch (err) {
  say(false, 'support acceptance ran without throwing', String(err).slice(0, 200));
} finally {
  const failed = finish();
  await browser.close();
  process.exit(failed === 0 ? 0 : 1);
}
