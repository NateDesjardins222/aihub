/**
 * Owner OS observability over HTTP (M10-C): the read surfaces are granularly
 * authorized (audit.read / customers.read / accounts.read / payouts.read), a
 * trader never reaches them, and unauthenticated calls are rejected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';

const PASSWORD = 'obs-http-pw-12345';
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
const tokens: Record<string, string> = {};

async function makeUser(role: string): Promise<string> {
  const email = `obshttp-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  await db.insert(users).values({ email, passwordHash: await hashPassword(PASSWORD), displayName: role, role, isAdmin: role === 'ADMIN' || role === 'SUPER_ADMIN' }).returning();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  return JSON.parse(res.body).accessToken;
}
function call(url: string, token?: string) {
  return app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} }).then((r) => ({ status: r.statusCode, json: r.body ? JSON.parse(r.body) : null }));
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  for (const role of ['TRADER', 'SUPPORT', 'ADMIN']) tokens[role] = await makeUser(role);
}, 60_000);
afterAll(async () => { await app.close(); });

describe('observability authorization', () => {
  it('GET /events needs audit.read: unauth 401, trader 403, support 200', async () => {
    expect((await call('/api/v1/admin/ops/events')).status).toBe(401);
    expect((await call('/api/v1/admin/ops/events', tokens.TRADER)).status).toBe(403);
    expect((await call('/api/v1/admin/ops/events', tokens.SUPPORT)).status).toBe(200);
  });

  it('GET /search needs customers.read: trader 403, support 200 with grouped shape', async () => {
    expect((await call('/api/v1/admin/ops/search?q=zzz', tokens.TRADER)).status).toBe(403);
    const ok = await call('/api/v1/admin/ops/search?q=zzz', tokens.SUPPORT);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.json.groups)).toBe(true);
  });

  it('GET /events supports stream filtering', async () => {
    const r = await call('/api/v1/admin/ops/events?stream=SECURITY&limit=10', tokens.ADMIN);
    expect(r.status).toBe(200);
    expect((r.json.events as Array<{ stream: string }>).every((e) => e.stream === 'SECURITY')).toBe(true);
  });

  it('inspectors are gated and 404 for an unknown id', async () => {
    expect((await call(`/api/v1/admin/ops/inspect/account/${crypto.randomUUID()}`, tokens.TRADER)).status).toBe(403);
    expect((await call(`/api/v1/admin/ops/inspect/account/${crypto.randomUUID()}`, tokens.SUPPORT)).status).toBe(404);
    expect((await call(`/api/v1/admin/ops/inspect/payout/${crypto.randomUUID()}`, tokens.SUPPORT)).status).toBe(404);
  });

  it('correlation trace is gated by audit.read', async () => {
    expect((await call('/api/v1/admin/ops/correlation/none', tokens.TRADER)).status).toBe(403);
    const ok = await call('/api/v1/admin/ops/correlation/none', tokens.SUPPORT);
    expect(ok.status).toBe(200);
    expect(ok.json.trace).toEqual([]);
  });
});
