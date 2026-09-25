/**
 * M12 — support over HTTP: the customer → owner → resolution flow plus the
 * authorization / privacy matrix. Proves ticket isolation, internal-note secrecy,
 * RBAC on owner routes, remediation four-eyes + role gates, safe attachments with
 * signed downloads, and that a customer can never reach another customer's ticket.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from '../platform/provisioning.js';

const PASSWORD = 'sup-http-pw-12345';
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const tok: Record<string, string> = {};

async function makeUser(role: string, tag: string): Promise<string> {
  const email = `suphttp-${tag}-${crypto.randomUUID().slice(0, 8)}@atlas.test`.toLowerCase();
  const [u] = await db.insert(users).values({ email, passwordHash: await hashPassword(PASSWORD), displayName: `${role} ${tag}`, role, isAdmin: role === 'ADMIN' || role === 'SUPER_ADMIN', organizationId }).returning();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  tok[tag] = JSON.parse(res.body).accessToken;
  return u!.id;
}
function call(method: 'GET' | 'POST', url: string, token?: string, payload?: unknown) {
  return app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never }).then((r) => ({ status: r.statusCode, json: r.body ? (() => { try { return JSON.parse(r.body); } catch { return r.body; } })() : null, raw: r }));
}
const OPS = '/api/v1/admin/ops';
const SUP = '/api/v1/support';
// a 1x1 transparent PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app; await app.ready();
  db = getDb().db; organizationId = await defaultOrganizationId(db);
  await makeUser('SUPER_ADMIN', 'owner'); await makeUser('ADMIN', 'admin'); await makeUser('SUPPORT', 'support');
  await makeUser('TRADER', 'custA'); await makeUser('TRADER', 'custB');
}, 60_000);
afterAll(async () => { await app.close(); });

describe('customer support center', () => {
  let ticketId = '';
  it('lists categories and creates a ticket', async () => {
    expect((await call('GET', `${SUP}/categories`, tok.custA)).json.categories.length).toBeGreaterThan(5);
    const r = await call('POST', `${SUP}/tickets`, tok.custA, { categoryKey: 'PAYOUT', subject: 'My payout is wrong', body: 'It has not arrived' });
    expect(r.status).toBe(201);
    ticketId = r.json.id;
    expect(r.json.publicRef).toMatch(/^HT-/);
  });
  it('the creating customer sees it; another customer cannot', async () => {
    expect((await call('GET', `${SUP}/me/tickets`, tok.custA)).json.tickets.some((t: { id: string }) => t.id === ticketId)).toBe(true);
    expect((await call('GET', `${SUP}/tickets/${ticketId}`, tok.custA)).status).toBe(200);
    expect((await call('GET', `${SUP}/tickets/${ticketId}`, tok.custB)).status).toBe(404);
  });
  it('unauthenticated cannot reach the support center', async () => {
    expect((await call('GET', `${SUP}/me/tickets`)).status).toBe(401);
  });
});

describe('owner inbox + RBAC', () => {
  let ticketId = '';
  beforeAll(async () => { ticketId = (await call('POST', `${SUP}/tickets`, tok.custA, { categoryKey: 'ACCOUNT', subject: 'acct', body: 'help' })).json.id; });
  it('SUPPORT reads the inbox; a customer cannot', async () => {
    expect((await call('GET', `${OPS}/support/inbox`, tok.support)).status).toBe(200);
    expect((await call('GET', `${OPS}/support/inbox`, tok.custA)).status).toBe(403);
    expect((await call('GET', `${OPS}/support/inbox`)).status).toBe(401);
  });
  it('a customer cannot open the owner workspace for a ticket', async () => {
    expect((await call('GET', `${OPS}/support/tickets/${ticketId}`, tok.custA)).status).toBe(403);
    expect((await call('GET', `${OPS}/support/tickets/${ticketId}`, tok.support)).status).toBe(200);
  });
  it('SUPPORT cannot manage support config (admin only)', async () => {
    expect((await call('POST', `${OPS}/support/config`, tok.support, { reopenWindowDays: 30 })).status).toBe(403);
    expect((await call('POST', `${OPS}/support/config`, tok.admin, { reopenWindowDays: 30 })).status).toBe(200);
  });
});

describe('messaging + internal-note privacy', () => {
  let ticketId = '';
  beforeAll(async () => { ticketId = (await call('POST', `${SUP}/tickets`, tok.custA, { categoryKey: 'ACCOUNT', subject: 'msg', body: 'hi' })).json.id; });
  it('a staff public reply is visible to the customer; an internal note is not', async () => {
    await call('POST', `${OPS}/support/tickets/${ticketId}/reply`, tok.support, { body: 'We are looking into it.' });
    await call('POST', `${OPS}/support/tickets/${ticketId}/note`, tok.support, { body: 'INTERNAL: check the payout ledger' });
    const view = await call('GET', `${SUP}/tickets/${ticketId}`, tok.custA);
    const bodies = view.json.messages.map((m: { body: string }) => m.body);
    expect(bodies).toContain('We are looking into it.');
    expect(JSON.stringify(view.json)).not.toContain('INTERNAL: check the payout ledger');
    // customer view never names the staff member
    const staffMsg = view.json.messages.find((m: { senderType: string }) => m.senderType === 'STAFF');
    expect(staffMsg.senderName).toBe('Happy Trader Support');
  });
  it('a customer can reply to their own ticket', async () => {
    expect((await call('POST', `${SUP}/tickets/${ticketId}/messages`, tok.custA, { body: 'here is more detail' })).status).toBe(200);
    expect((await call('POST', `${SUP}/tickets/${ticketId}/messages`, tok.custB, { body: 'sneaky' })).status).toBe(404);
  });
  it('assign, priority and status transitions work', async () => {
    expect((await call('POST', `${OPS}/support/tickets/${ticketId}/assign`, tok.support, { assigneeUserId: null, team: 'PAYOUT_OPERATIONS' })).status).toBe(200);
    expect((await call('POST', `${OPS}/support/tickets/${ticketId}/priority`, tok.support, { priority: 'HIGH' })).status).toBe(200);
    expect((await call('POST', `${OPS}/support/tickets/${ticketId}/status`, tok.support, { to: 'IN_PROGRESS' })).status).toBe(200);
  });
});

describe('remediation four-eyes + role gates', () => {
  let ticketId = '';
  beforeAll(async () => { ticketId = (await call('POST', `${SUP}/tickets`, tok.custA, { categoryKey: 'OTHER', subject: 'rem', body: 'x' })).json.id; });
  it('SUPPORT can request remediation but not approve it', async () => {
    const req = await call('POST', `${OPS}/support/tickets/${ticketId}/remediations`, tok.support, { type: 'OTHER', reason: 'goodwill' });
    expect(req.status).toBe(200);
    const remId = req.json.id;
    // support lacks approve permission
    expect((await call('POST', `${OPS}/support/remediations/${remId}/approve`, tok.support)).status).toBe(403);
    // admin approves + executes
    expect((await call('POST', `${OPS}/support/remediations/${remId}/approve`, tok.admin)).status).toBe(200);
    const exec = await call('POST', `${OPS}/support/remediations/${remId}/execute`, tok.admin);
    expect(exec.status).toBe(200);
    expect(exec.json.status).toBe('EXECUTED');
  });
  it('four-eyes: the same admin cannot approve what they requested', async () => {
    const req = await call('POST', `${OPS}/support/tickets/${ticketId}/remediations`, tok.admin, { type: 'OTHER', reason: 'self' });
    expect((await call('POST', `${OPS}/support/remediations/${req.json.id}/approve`, tok.admin)).status).toBe(403);
  });
});

describe('resolution + csat + reopen', () => {
  let ticketId = '';
  beforeAll(async () => { ticketId = (await call('POST', `${SUP}/tickets`, tok.custA, { categoryKey: 'ACCOUNT', subject: 'res', body: 'x' })).json.id; });
  it('resolve requires a summary and surfaces it to the customer', async () => {
    expect((await call('POST', `${OPS}/support/tickets/${ticketId}/resolve`, tok.support, { resolutionCode: 'EXPLANATION_ONLY', customerSummary: '' })).status).toBeGreaterThanOrEqual(400);
    expect((await call('POST', `${OPS}/support/tickets/${ticketId}/resolve`, tok.support, { resolutionCode: 'CUSTOMER_EDUCATION', customerSummary: 'Here is how the rule works.', internalNotes: 'secret internal' })).status).toBe(200);
    const view = await call('GET', `${SUP}/tickets/${ticketId}`, tok.custA);
    expect(view.json.ticket.resolutionSummaryCustomer).toBe('Here is how the rule works.');
    expect(JSON.stringify(view.json)).not.toContain('secret internal');
  });
  it('the customer can rate and reopen', async () => {
    expect((await call('POST', `${SUP}/tickets/${ticketId}/csat`, tok.custA, { rating: 5, comment: 'great' })).status).toBe(200);
    expect((await call('POST', `${SUP}/tickets/${ticketId}/reopen`, tok.custA, { reason: 'still stuck' })).status).toBe(200);
  });
});

describe('attachments: safe upload + signed download', () => {
  let ticketId = '';
  beforeAll(async () => { ticketId = (await call('POST', `${SUP}/tickets`, tok.custA, { categoryKey: 'TECHNICAL', subject: 'att', body: 'x' })).json.id; });
  it('accepts an allowed image and returns a signed token; rejects an executable', async () => {
    const ok = await call('POST', `${SUP}/tickets/${ticketId}/attachments`, tok.custA, { filename: 'screenshot.png', contentType: 'image/png', dataBase64: PNG_B64 });
    expect(ok.status).toBe(200);
    expect(ok.json.downloadToken).toBeTruthy();
    const bad = await call('POST', `${SUP}/tickets/${ticketId}/attachments`, tok.custA, { filename: 'malware.exe', contentType: 'application/x-msdownload', dataBase64: PNG_B64 });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });
  it('download requires a valid token and ownership', async () => {
    const up = await call('POST', `${SUP}/tickets/${ticketId}/attachments`, tok.custA, { filename: 'a.png', contentType: 'image/png', dataBase64: PNG_B64 });
    const id = up.json.id; const token = up.json.downloadToken;
    expect((await call('GET', `${SUP}/attachments/${id}/download?token=${token}`, tok.custA)).status).toBe(200);
    expect((await call('GET', `${SUP}/attachments/${id}/download`, tok.custA)).status).toBe(403); // no token
    expect((await call('GET', `${SUP}/attachments/${id}/download?token=bad`, tok.custA)).status).toBe(403);
    expect((await call('GET', `${SUP}/attachments/${id}/download?token=${token}`, tok.custB)).status).toBe(403); // not owner
  });
});
