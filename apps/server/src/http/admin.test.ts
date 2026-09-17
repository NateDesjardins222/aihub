/**
 * The admin API: authorization, isolation and the actions themselves.
 *
 * Hiding a button is not authorization, so every capability is called here
 * over HTTP with a token that lacks it. Tenancy is tested the same way: an
 * administrator of one organisation asking for another's account gets a 404,
 * not a filtered list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { accounts, auditLog, organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { publishProfileVersion } from '../platform/profiles.js';
import { defaultOrganizationId, provisionAccount } from '../platform/provisioning.js';
import { hashProvisioningKey } from './routes/provisioning.js';
import { provisioningKeys } from '../db/schema.js';

const M = 1_000_000;
const PASSWORD = 'admin-suite-password';

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
let otherOrganizationId: string;
let productKey: string;

const created: string[] = [];
const tokens: Record<string, string> = {};
let traderId = '';
let traderAccountId = '';
let otherOrgAccountId = '';

async function makeUser(role: string, organization = organizationId): Promise<{ id: string; token: string }> {
  const email = `admin-suite-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      displayName: role,
      role,
      organizationId: organization,
      isAdmin: role === 'ADMIN' || role === 'SUPER_ADMIN',
    })
    .returning();
  created.push(user!.id);

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  return { id: user!.id, token: JSON.parse(response.body).accessToken };
}

function call(
  method: 'GET' | 'POST',
  url: string,
  token: string | null,
  payload?: unknown,
): Promise<{ status: number; json: any }> {
  return app
    .inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: payload as never,
    })
    .then((response) => ({
      status: response.statusCode,
      json: response.body ? safeJson(response.body) : null,
    }));
}

function safeJson(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);

  const [other] = await db
    .insert(organizations)
    .values({ slug: `other-firm-${crypto.randomUUID().slice(0, 8)}`, name: 'Other Firm' })
    .returning();
  otherOrganizationId = other!.id;

  productKey = `admin-suite-${crypto.randomUUID().slice(0, 8)}`;
  await publishProfileVersion(db, {
    organizationId,
    key: productKey,
    name: 'Admin Suite 100K',
    accountType: 'EVALUATION',
    config: {
      rules: {
        accountSizeMicros: 100_000 * M,
        profitTargetMicros: 6_000 * M,
        maxLossMicros: 3_000 * M,
        drawdownType: 'STATIC',
        trailingLockAtMicros: null,
        dailyLossLimitMicros: null,
        dailyLossPolicy: 'LOCK_DAY',
        consistencyFormula: 'BEST_DAY_OVER_TOTAL',
        consistencyThreshold: null,
        minTradingDays: 0,
        minWinningDays: 0,
        maxTradingDays: null,
        minDailyPnlToCountMicros: 0,
        minWinningDayPnlMicros: 1,
        maxContracts: 10,
        microsCountAsFraction: true,
        flattenOnBreach: true,
      },
      execution: null,
      instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
      display: { startingBalanceMicros: 100_000 * M },
      payoutRules: null,
    },
  });

  const trader = await makeUser('TRADER');
  traderId = trader.id;
  tokens['TRADER'] = trader.token;
  tokens['SUPPORT'] = (await makeUser('SUPPORT')).token;
  tokens['ADMIN'] = (await makeUser('ADMIN')).token;
  tokens['SUPER_ADMIN'] = (await makeUser('SUPER_ADMIN')).token;

  const provisioned = await provisionAccount(db, {
    organizationId,
    userId: traderId,
    profileKey: productKey,
    displayName: 'Suite Account',
  });
  traderAccountId = provisioned.accountId;

  // An account belonging to a different firm entirely.
  const foreignTrader = await makeUser('TRADER', otherOrganizationId);
  await publishProfileVersion(db, {
    organizationId: otherOrganizationId,
    key: productKey,
    name: 'Other Firm 100K',
    accountType: 'EVALUATION',
    config: {
      rules: {
        accountSizeMicros: 100_000 * M,
        profitTargetMicros: 6_000 * M,
        maxLossMicros: 3_000 * M,
        drawdownType: 'STATIC',
        trailingLockAtMicros: null,
        dailyLossLimitMicros: null,
        dailyLossPolicy: 'LOCK_DAY',
        consistencyFormula: 'BEST_DAY_OVER_TOTAL',
        consistencyThreshold: null,
        minTradingDays: 0,
        minWinningDays: 0,
        maxTradingDays: null,
        minDailyPnlToCountMicros: 0,
        minWinningDayPnlMicros: 1,
        maxContracts: 10,
        microsCountAsFraction: true,
        flattenOnBreach: true,
      },
      execution: null,
      instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
      display: { startingBalanceMicros: 100_000 * M },
      payoutRules: null,
    },
  });
  otherOrgAccountId = (
    await provisionAccount(db, {
      organizationId: otherOrganizationId,
      userId: foreignTrader.id,
      profileKey: productKey,
    })
  ).accountId;
});

afterAll(async () => {
  // Users cascade to their accounts. The second organisation is left behind on
  // purpose: its product versions reference it, and a published version is
  // immutable by design - there is nothing to gain from fighting that in a
  // test database.
  for (const id of created) await db.delete(users).where(eq(users.id, id));
  await app.close();
});

describe('who may reach the operator console', () => {
  it('turns away a request with no token', async () => {
    expect((await call('GET', '/api/v1/admin/overview', null)).status).toBe(401);
  });

  it('turns away a trader', async () => {
    const response = await call('GET', '/api/v1/admin/overview', tokens['TRADER']!);
    expect(response.status).toBe(403);
    expect(response.json.error.code).toBe('FORBIDDEN');
  });

  it('lets support read', async () => {
    const response = await call('GET', '/api/v1/admin/overview', tokens['SUPPORT']!);
    expect(response.status).toBe(200);
    expect(response.json.accounts.total).toBeGreaterThan(0);
    expect(response.json.money).toHaveProperty('balanceMicros');
  });
});

describe('what support may not do', () => {
  const mutations: Array<[string, unknown]> = [
    ['/api/v1/admin/accounts/:id/lock', { confirm: true, reason: 'testing' }],
    ['/api/v1/admin/accounts/:id/disable', { confirm: true, reason: 'testing' }],
    ['/api/v1/admin/accounts/:id/reset', { confirm: true, reason: 'testing' }],
    ['/api/v1/admin/accounts/:id/archive', { confirm: true, reason: 'testing' }],
  ];

  for (const [path, payload] of mutations) {
    it(`refuses ${path.split('/').pop()}`, async () => {
      const response = await call(
        'POST',
        path.replace(':id', traderAccountId),
        tokens['SUPPORT']!,
        payload,
      );
      expect(response.status).toBe(403);
    });
  }

  it('refuses provisioning', async () => {
    const response = await call('POST', '/api/v1/admin/accounts', tokens['SUPPORT']!, {
      userId: traderId,
      profileKey: productKey,
    });
    expect(response.status).toBe(403);
  });

  it('refuses publishing a product', async () => {
    const response = await call('POST', '/api/v1/admin/profiles', tokens['ADMIN']!, {
      key: 'nope',
      name: 'Nope',
      accountType: 'EVALUATION',
      config: {},
    });
    // Even an ADMIN may not change what a product is: that is SUPER_ADMIN.
    expect(response.status).toBe(403);
  });

  it('refuses changing a role', async () => {
    const response = await call('POST', `/api/v1/admin/users/${traderId}/role`, tokens['ADMIN']!, {
      confirm: true,
      reason: 'testing',
      role: 'ADMIN',
    });
    expect(response.status).toBe(403);
  });
});

describe('destructive actions', () => {
  it('will not run without an explicit confirmation', async () => {
    const response = await call(
      'POST',
      `/api/v1/admin/accounts/${traderAccountId}/lock`,
      tokens['ADMIN']!,
      { reason: 'no confirmation given' },
    );
    expect(response.status).toBe(400);
  });

  it('will not run without a reason', async () => {
    const response = await call(
      'POST',
      `/api/v1/admin/accounts/${traderAccountId}/lock`,
      tokens['ADMIN']!,
      { confirm: true },
    );
    expect(response.status).toBe(400);
  });

  it('locks, records who and why, and unlocks', async () => {
    const locked = await call(
      'POST',
      `/api/v1/admin/accounts/${traderAccountId}/lock`,
      tokens['ADMIN']!,
      { confirm: true, reason: 'Suspected rule breach' },
    );
    expect(locked.status).toBe(200);

    const [account] = await db.select().from(accounts).where(eq(accounts.id, traderAccountId));
    expect(account!.status).toBe('LOCKED');

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.accountId, traderAccountId));
    const lock = entries.find((entry) => entry.action === 'admin.account.locked');
    expect(lock).toBeDefined();
    expect(lock!.reason).toBe('Suspected rule breach');
    expect(lock!.actorType).toBe('ADMIN');
    expect(lock!.actorLabel).toContain('@atlas.test');

    const unlocked = await call(
      'POST',
      `/api/v1/admin/accounts/${traderAccountId}/unlock`,
      tokens['ADMIN']!,
      { confirm: true, reason: 'Cleared' },
    );
    expect(unlocked.status).toBe(200);
    const [after] = await db.select().from(accounts).where(eq(accounts.id, traderAccountId));
    expect(after!.status).toBe('ACTIVE');
  });

  it('refuses a transition that does not make sense', async () => {
    const response = await call(
      'POST',
      `/api/v1/admin/accounts/${traderAccountId}/unlock`,
      tokens['ADMIN']!,
      { confirm: true, reason: 'It is not locked' },
    );
    expect(response.status).toBe(409);
    expect(response.json.error.code).toBe('INVALID_TRANSITION');
  });
});

describe('organisation isolation', () => {
  it('hides an account belonging to another firm', async () => {
    const response = await call(
      'GET',
      `/api/v1/admin/accounts/${otherOrgAccountId}`,
      tokens['ADMIN']!,
    );
    expect(response.status).toBe(404);
  });

  it('hides it from the live view', async () => {
    const response = await call(
      'GET',
      `/api/v1/admin/accounts/${otherOrgAccountId}/live`,
      tokens['ADMIN']!,
    );
    expect(response.status).toBe(404);
  });

  it('refuses to act on it', async () => {
    const response = await call(
      'POST',
      `/api/v1/admin/accounts/${otherOrgAccountId}/lock`,
      tokens['ADMIN']!,
      { confirm: true, reason: 'should not be possible' },
    );
    expect(response.status).toBe(404);
  });

  it('leaves it out of the account list', async () => {
    const response = await call('GET', '/api/v1/admin/accounts?limit=200', tokens['ADMIN']!);
    const ids = response.json.accounts.map((row: { id: string }) => row.id);
    expect(ids).toContain(traderAccountId);
    expect(ids).not.toContain(otherOrgAccountId);

    // The per-row figures are correlated subqueries, which is exactly where a
    // silently wrong answer hides: assert they are reported, not merely absent.
    const mine = response.json.accounts.find((row: { id: string }) => row.id === traderAccountId);
    expect(mine.openContracts).toBe(0);
    expect(mine.lastTradedAt).toBeNull();
    expect(mine.owner.id).toBe(traderId);
  });
});

describe('the admin views', () => {
  it('shows an account with its rules, lifecycles and history', async () => {
    const response = await call('GET', `/api/v1/admin/accounts/${traderAccountId}`, tokens['SUPPORT']!);
    expect(response.status).toBe(200);
    expect(response.json.account.publicId).toMatch(/^SIM-\d{6}$/);
    expect(response.json.rules.maxContracts).toBe(10);
    expect(response.json.lifecycles).toHaveLength(1);
    expect(response.json.owner.id).toBe(traderId);
    expect(Array.isArray(response.json.audit)).toBe(true);
  });

  it('shows the live view from the engine itself', async () => {
    const response = await call(
      'GET',
      `/api/v1/admin/accounts/${traderAccountId}/live`,
      tokens['SUPPORT']!,
    );
    expect(response.status).toBe(200);
    expect(response.json.valuation.accountId).toBe(traderAccountId);
    expect(response.json.valuation).toHaveProperty('equityMicros');
    expect(response.json.valuation).toHaveProperty('rules');
    expect(Array.isArray(response.json.workingOrders)).toBe(true);
  });

  it('finds a user by e-mail and lists their accounts', async () => {
    const [user] = await db.select().from(users).where(eq(users.id, traderId));
    const search = await call(
      'GET',
      `/api/v1/admin/users?q=${encodeURIComponent(user!.email)}`,
      tokens['SUPPORT']!,
    );
    expect(search.json.users).toHaveLength(1);
    expect(search.json.users[0].accountCount).toBeGreaterThan(0);

    const detail = await call('GET', `/api/v1/admin/users/${traderId}`, tokens['SUPPORT']!);
    expect(detail.status).toBe(200);
    expect(detail.json.accounts.map((a: { id: string }) => a.id)).toContain(traderAccountId);
  });

  it('reports whether the audit chain still verifies', async () => {
    const response = await call('GET', '/api/v1/admin/audit/verify', tokens['SUPPORT']!);
    expect(response.status).toBe(200);
    expect(response.json).toHaveProperty('ok');
    expect(response.json.checked).toBeGreaterThan(0);
  });
});

describe('creating a user', () => {
  it('is refused to support', async () => {
    const response = await call('POST', '/api/v1/admin/users', tokens['SUPPORT']!, {
      email: `support-made-${crypto.randomUUID().slice(0, 8)}@atlas.test`,
      displayName: 'Nope',
      password: 'a-long-enough-password',
    });
    expect(response.status).toBe(403);
  });

  it('creates a trader with a practice account and an audit record', async () => {
    const email = `onboarded-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
    const response = await call('POST', '/api/v1/admin/users', tokens['ADMIN']!, {
      email,
      displayName: 'Onboarded Trader',
      password: 'a-long-enough-password',
    });
    expect(response.status).toBe(201);
    created.push(response.json.user.id);
    expect(response.json.user.role).toBe('TRADER');

    const owned = await db.select().from(accounts).where(eq(accounts.userId, response.json.user.id));
    expect(owned).toHaveLength(1);
    expect(owned[0]!.accountType).toBe('PRACTICE');

    // And they can sign in with the password the operator set.
    const login = await call('POST', '/api/v1/auth/login', null, {
      email,
      password: 'a-long-enough-password',
    });
    expect(login.status).toBe(200);
  });

  it('refuses an address that is already registered', async () => {
    const email = `dupe-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
    const first = await call('POST', '/api/v1/admin/users', tokens['ADMIN']!, {
      email,
      displayName: 'First',
      password: 'a-long-enough-password',
      withPracticeAccount: false,
    });
    created.push(first.json.user.id);
    const second = await call('POST', '/api/v1/admin/users', tokens['ADMIN']!, {
      email,
      displayName: 'Second',
      password: 'a-long-enough-password',
      withPracticeAccount: false,
    });
    expect(second.status).toBe(409);
  });
});

describe('provisioning through the admin API', () => {
  it('creates an account for a user', async () => {
    const response = await call('POST', '/api/v1/admin/accounts', tokens['ADMIN']!, {
      userId: traderId,
      profileKey: productKey,
      displayName: 'Second Account',
    });
    expect(response.status).toBe(201);
    expect(response.json.publicId).toMatch(/^SIM-\d{6}$/);

    const owned = await db.select().from(accounts).where(eq(accounts.userId, traderId));
    expect(owned.length).toBeGreaterThanOrEqual(2);
    expect(new Set(owned.map((row) => row.publicId)).size).toBe(owned.length);
  });

  it('insists on a product', async () => {
    const response = await call('POST', '/api/v1/admin/accounts', tokens['ADMIN']!, {
      userId: traderId,
    });
    expect(response.status).toBe(400);
  });
});

describe('the machine-to-machine seam', () => {
  it('turns away a call with no key', async () => {
    const response = await call('POST', '/api/v1/provisioning/accounts', null, {
      userId: traderId,
      profileKey: productKey,
    });
    expect(response.status).toBe(401);
  });

  it('provisions with a key, once per idempotency key', async () => {
    const secret = `atlas_${crypto.randomUUID()}`;
    await db.insert(provisioningKeys).values({
      organizationId,
      name: 'Test purchase flow',
      prefix: secret.slice(0, 12),
      keyHash: hashProvisioningKey(secret),
    });

    const key = `order-${crypto.randomUUID()}`;
    const send = () =>
      app
        .inject({
          method: 'POST',
          url: '/api/v1/provisioning/accounts',
          headers: { 'x-api-key': secret, 'idempotency-key': key },
          payload: { userId: traderId, profileKey: productKey, displayName: 'Bought' } as never,
        })
        .then((response) => ({ status: response.statusCode, json: safeJson(response.body) }));

    const first = await send();
    expect(first.status).toBe(201);
    const second = await send();
    expect(second.status).toBe(200);
    expect(second.json.accountId).toBe(first.json.accountId);
    expect(second.json.reused).toBe(true);
  });

  it('refuses without an idempotency key', async () => {
    const secret = `atlas_${crypto.randomUUID()}`;
    await db.insert(provisioningKeys).values({
      organizationId,
      name: 'Another flow',
      prefix: secret.slice(0, 12),
      keyHash: hashProvisioningKey(secret),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/provisioning/accounts',
      headers: { 'x-api-key': secret },
      payload: { userId: traderId, profileKey: productKey } as never,
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});
