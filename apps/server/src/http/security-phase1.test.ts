/**
 * Security Phase 1 — hostile-client / auth / authz / abuse regressions.
 *
 * These are the NEW attacks + repairs from Security Phase 1 (starting commit
 * ae9a4a3). Broad RBAC / IDOR / webhook / injection coverage lives in the
 * established suites (security.test.ts, authz-security.test.ts,
 * m10-1-rbac-redteam.test.ts, trading-authz-http.test.ts, owner-authz-http.test.ts,
 * enforcement-authz.test.ts, affiliate-security.test.ts, self-serve-boundary.test.ts,
 * certificate-security.routes.test.ts, ws-security.test.ts, replay-controls.test.ts);
 * this file holds Phase-1 additions so `security:check` has a single new home.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from '../platform/provisioning.js';

const PASSWORD = 'sec-p1-operator-pw-123';
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;

async function makeUser(role: string): Promise<{ id: string; token: string; email: string }> {
  const email = `secp1-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [user] = await db.insert(users).values({
    email, passwordHash: await hashPassword(PASSWORD), displayName: role, role, organizationId,
    isAdmin: role === 'ADMIN' || role === 'SUPER_ADMIN',
  }).returning();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  return { id: user!.id, token: JSON.parse(res.body).accessToken, email };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token?: string | null, payload?: unknown, headers: Record<string, string> = {}) {
  return app
    .inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: payload as never })
    .then((r) => ({ status: r.statusCode, json: r.body ? JSON.parse(r.body) : null, raw: r.body }));
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
}, 60_000);
afterAll(async () => { await app.close(); });

describe('SEC-1 — step-up (reauth) password gate is rate-limited (brute-force resistance)', () => {
  it('an unauthenticated caller cannot mint a step-up token (rejected, no token issued)', async () => {
    // The rate-limit hook runs ahead of auth in Fastify's lifecycle, so an
    // unauthenticated hit is rejected as either 401 (auth) or 429 (limit) — either
    // way it is denied BEFORE any password check and NO step-up token is minted.
    const r = await call('POST', '/api/v1/admin/security/reauth', null, { password: 'whatever', class: 'FINANCIAL' });
    expect([401, 429]).toContain(r.status);
    expect(r.json?.stepUpToken ?? r.json?.token ?? null).toBeNull();
  });

  it('the step-up mint endpoint rejects a burst of wrong-password attempts with 429 (not unlimited 401s)', async () => {
    const op = await makeUser('SUPER_ADMIN');
    // Hammer the step-up password check with wrong passwords. Before the fix this
    // endpoint had no rate limit (global limiter is `global:false`), so every one
    // of these would be an unlimited 401 — an online brute-force of the password
    // gate that guards FINANCIAL / STAFF / KILL_SWITCH actions.
    const statuses: number[] = [];
    for (let i = 0; i < 16; i += 1) {
      const r = await call('POST', '/api/v1/admin/security/reauth', op.token, { password: 'wrong-password', class: 'FINANCIAL' });
      statuses.push(r.status);
    }
    // The cap is 10/min; a valid authenticated operator gets 401 for the wrong
    // password up to the cap, then 429 — the endpoint is no longer unlimited.
    expect(statuses).toContain(429);
    // Every pre-limit response is a clean auth failure (never a 5xx / no oracle beyond 401).
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
    // The limit actually bites within the burst (at least one request was blocked).
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  }, 60_000);
});
