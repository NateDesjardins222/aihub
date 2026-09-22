/**
 * Adversarial authorization: RBAC, IDOR, and mass assignment (F-verify).
 *
 * These attacks assume a valid, ordinary trader session and try to reach beyond
 * it: to another trader's account (IDOR), to the operator console (privilege),
 * or to a privileged role by smuggling fields into registration (mass
 * assignment). Each must fail closed. This complements owner-isolation.test.ts
 * (cross-tenant) with same-tenant privilege and ownership boundaries.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
const created: string[] = [];

interface Session {
  token: string;
  userId: string;
  accountId: string;
}

async function registerTrader(extra: Record<string, unknown> = {}): Promise<Session> {
  const email = `authz-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'a-strong-password-123', displayName: 'Authz', ...extra },
  });
  expect(reg.statusCode).toBe(201);
  const body = JSON.parse(reg.body);
  created.push(body.user.id);
  // Registration provisions a practice account; find it.
  const accts = await app.inject({
    method: 'GET',
    url: '/api/v1/accounts',
    headers: { authorization: `Bearer ${body.accessToken}` },
  });
  const list = JSON.parse(accts.body);
  const accountId = (list.accounts ?? list)[0]?.id as string;
  return { token: body.accessToken, userId: body.user.id, accountId };
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
});

afterAll(async () => {
  if (created.length > 0) await db.delete(users).where(inArray(users.id, created));
  await app.close();
});

describe('authorization boundaries', () => {
  it('an unauthenticated request to a protected route is 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/overview' });
    expect(res.statusCode).toBe(401);
  });

  it('a TRADER token cannot reach the operator console (403, DB-backed RBAC)', async () => {
    const trader = await registerTrader();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: { authorization: `Bearer ${trader.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a trader cannot touch another trader\'s account (IDOR → 404, no oracle)', async () => {
    const a = await registerTrader();
    const b = await registerTrader();
    expect(b.accountId).toBeTruthy();

    // A reads B's positions.
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/positions?accountId=${b.accountId}`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(read.statusCode).toBe(404);

    // A places a well-formed order on B's account — so it clears validation and
    // is stopped by the ownership check, not by a 400.
    const order = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { authorization: `Bearer ${a.token}` },
      payload: {
        accountId: b.accountId,
        clientOrderId: crypto.randomUUID(),
        symbol: 'NQ',
        side: 'BUY',
        qty: 1,
        type: 'MARKET',
      },
    });
    expect(order.statusCode).toBe(404);
  });

  it('registration cannot smuggle a privileged role (mass assignment)', async () => {
    // Hostile body claims admin. The schema strips unknown keys and the service
    // sets role explicitly, so the new user must still be an ordinary trader.
    const sneaky = await registerTrader({ role: 'SUPER_ADMIN', isAdmin: true, status: 'ACTIVE' });

    // The DB row is the ground truth: role TRADER, not admin.
    const [row] = await db
      .select({ role: users.role, isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, sneaky.userId));
    expect(row?.role).toBe('TRADER');
    expect(row?.isAdmin).toBe(false);

    // And behaviourally: the smuggled token is refused at the operator console.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: { authorization: `Bearer ${sneaky.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a tampered/garbage bearer token is rejected, not trusted', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: { authorization: 'Bearer not.a.real.jwt' },
    });
    expect(res.statusCode).toBe(401);
  });
});
