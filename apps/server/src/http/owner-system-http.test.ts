/**
 * Owner OS System Doctor / integrity / reconciliation over HTTP (M10-G).
 * Read/run surfaces are permission-gated and return truthful statuses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';

const PASSWORD = 'sys-http-pw-1234';
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
const tokens: Record<string, string> = {};

async function makeUser(role: string) {
  const email = `syshttp-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  await db.insert(users).values({ email, passwordHash: await hashPassword(PASSWORD), displayName: role, role, isAdmin: role === 'ADMIN' || role === 'SUPER_ADMIN' }).returning();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  return JSON.parse(res.body).accessToken as string;
}
function call(method: 'GET' | 'POST', url: string, token?: string) {
  return app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {} }).then((r) => ({ status: r.statusCode, json: r.body ? JSON.parse(r.body) : null }));
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app; await app.ready();
  db = getDb().db;
  for (const role of ['TRADER', 'SUPPORT', 'ADMIN']) tokens[role] = await makeUser(role);
}, 60_000);
afterAll(async () => { await app.close(); });

describe('system doctor / integrity authorization + truthfulness', () => {
  it('trader is denied; support can read the doctor with a truthful Rithmic status', async () => {
    expect((await call('GET', '/api/v1/admin/ops/system/doctor', tokens.TRADER)).status).toBe(403);
    const r = await call('GET', '/api/v1/admin/ops/system/doctor', tokens.SUPPORT);
    expect(r.status).toBe(200);
    expect(['HEALTHY', 'WARNING', 'CRITICAL']).toContain(r.json.overall);
    const rith = r.json.checks.find((c: { key: string }) => c.key === 'rithmic');
    expect(['NOT_CONFIGURED', 'NOT_VERIFIED']).toContain(rith.status);
  });

  it('integrity runs and reports an ok boolean', async () => {
    const r = await call('GET', '/api/v1/admin/ops/system/integrity', tokens.ADMIN);
    expect(r.status).toBe(200);
    expect(typeof r.json.ok).toBe('boolean');
    expect(r.json.checks.some((c: { key: string }) => c.key === 'INV_AUDIT_CHAIN_INTACT')).toBe(true);
  });

  it('reconciliation center aggregates systems', async () => {
    const r = await call('GET', '/api/v1/admin/ops/system/reconciliation', tokens.SUPPORT);
    expect(r.status).toBe(200);
    expect(r.json.systems.length).toBeGreaterThanOrEqual(4);
  });

  it('full system test needs the run permission and returns a composite result', async () => {
    expect((await call('POST', '/api/v1/admin/ops/system/full-test', tokens.SUPPORT)).status).toBe(403);
    const r = await call('POST', '/api/v1/admin/ops/system/full-test', tokens.ADMIN);
    expect(r.status).toBe(200);
    expect(r.json.doctor).toBeTruthy();
    expect(r.json.integrity).toBeTruthy();
    expect(r.json.reconciliation).toBeTruthy();
  });
});
