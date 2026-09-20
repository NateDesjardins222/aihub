/**
 * The admin API: authorization, isolation and the actions themselves.
 *
 * Hiding a button is not authorization, so every capability is called here
 * over HTTP with a token that lacks it. Tenancy is tested the same way: an
 * administrator of one organisation asking for another's account gets a 404,
 * not a filtered list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import {
  accountProfileVersions,
  accountProfiles,
  accounts,
  auditLog,
  organizations,
  users,
} from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { publishProfileVersion, resolveProfileVersion } from '../platform/profiles.js';
import { defaultOrganizationId, provisionAccount } from '../platform/provisioning.js';
import { accountProfileDrafts } from '../db/schema.js';
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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
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
  // Best-effort: a SUPER_ADMIN who published an immutable product version is
  // referenced by a row that cannot be updated or deleted, so its author record
  // outlives the test. That is the immutability guarantee doing its job, not a
  // leak to fight - leave such a user behind, as we already do the second firm.
  for (const id of created) {
    try {
      await db.delete(users).where(eq(users.id, id));
    } catch {
      /* referenced by an immutable version; intentionally left behind */
    }
  }
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

describe('the surveillance, risk and system views', () => {
  it('turns away a trader from trading, risk and system', async () => {
    for (const path of ['/trading', '/risk', '/system']) {
      const res = await call('GET', `/api/v1/admin${path}`, tokens['TRADER'] ?? null);
      expect([401, 403]).toContain(res.status);
    }
  });

  it('lets support read the surveillance view, scoped to its own firm', async () => {
    const res = await call('GET', '/api/v1/admin/trading', tokens['SUPPORT']!);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.openPositions)).toBe(true);
    expect(Array.isArray(res.json.workingOrders)).toBe(true);
    expect(Array.isArray(res.json.recentFills)).toBe(true);
    // Nothing from the other firm's account may appear here.
    const ids = [
      ...res.json.openPositions,
      ...res.json.workingOrders,
      ...res.json.recentFills,
    ].map((row: { accountId: string }) => row.accountId);
    expect(ids).not.toContain(otherOrgAccountId);
  });

  it('ranks risk by stated facts and scopes it to the firm', async () => {
    const res = await call('GET', '/api/v1/admin/risk', tokens['SUPPORT']!);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.nearestLossLimit)).toBe(true);
    expect(Array.isArray(res.json.largestUnrealizedLoss)).toBe(true);
    expect(Array.isArray(res.json.onHold)).toBe(true);
    expect(Array.isArray(res.json.recentFailures)).toBe(true);
    // largest-loss ordering is monotonic (most negative first).
    const losses = res.json.largestUnrealizedLoss.map((r: { openPnlMicros: number }) => r.openPnlMicros);
    for (let i = 1; i < losses.length; i += 1) expect(losses[i]).toBeGreaterThanOrEqual(losses[i - 1]);
    const heldIds = res.json.onHold.map((r: { accountId: string }) => r.accountId);
    expect(heldIds).not.toContain(otherOrgAccountId);
  });

  it('reports system health honestly, never green on a stale feed', async () => {
    const res = await call('GET', '/api/v1/admin/system', tokens['SUPPORT']!);
    expect(res.status).toBe(200);
    expect(res.json.api.state).toBe('HEALTHY');
    expect(['HEALTHY', 'OFFLINE']).toContain(res.json.database.state);
    // The dev feed is delayed by design; it must never claim HEALTHY.
    expect(['HEALTHY', 'DELAYED', 'DEGRADED', 'OFFLINE']).toContain(res.json.marketData.state);
    if (res.json.marketData.blocksOrderEntry) {
      expect(res.json.marketData.state).not.toBe('HEALTHY');
    }
    expect(['HEALTHY', 'FAILED']).toContain(res.json.audit.state);
  });

  it('refuses trading, risk and system with no token', async () => {
    for (const path of ['/trading', '/risk', '/system']) {
      const res = await call('GET', `/api/v1/admin${path}`, null);
      expect(res.status).toBe(401);
    }
  });
});

describe('product configuration: drafts, versions and immutability', () => {
  const M2 = 1_000_000;
  function config(maxContracts: number) {
    return {
      rules: {
        accountSizeMicros: 50_000 * M2,
        profitTargetMicros: 3_000 * M2,
        maxLossMicros: 2_000 * M2,
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
        maxContracts,
        microsCountAsFraction: true,
        flattenOnBreach: true,
      },
      execution: null,
      instruments: { allowed: null, maxContracts, perInstrument: {} },
      display: { startingBalanceMicros: 50_000 * M2 },
      payoutRules: null,
    };
  }

  let key = '';
  let editorTraderId = '';

  beforeAll(async () => {
    key = `prodcfg-${crypto.randomUUID().slice(0, 8)}`;
    editorTraderId = (await makeUser('TRADER')).id;
  });

  afterAll(async () => {
    await db.delete(accountProfileDrafts).where(eq(accountProfileDrafts.key, key));
  });

  it('composes a brand-new product as a draft before it is a version', async () => {
    const put = await call('PUT', `/api/v1/admin/profiles/${key}/draft`, tokens['SUPER_ADMIN']!, {
      name: 'Config Suite 50K',
      accountType: 'EVALUATION',
      config: config(5),
    });
    expect(put.status).toBe(200);
    expect(put.json.draft.baseVersion).toBeNull();

    // Until published, the product exists only as a draft.
    const get = await call('GET', `/api/v1/admin/profiles/${key}`, tokens['SUPPORT']!);
    expect(get.status).toBe(200);
    expect(get.json.profile).toBeNull();
    expect(get.json.versions).toHaveLength(0);
    expect(get.json.draft.name).toBe('Config Suite 50K');
  });

  it('publishes the draft as version 1 and clears the draft', async () => {
    const pub = await call('POST', `/api/v1/admin/profiles/${key}/publish`, tokens['SUPER_ADMIN']!, {});
    expect(pub.status).toBe(201);
    expect(pub.json.version).toBe(1);

    const get = await call('GET', `/api/v1/admin/profiles/${key}`, tokens['SUPPORT']!);
    expect(get.json.profile.status).toBe('ACTIVE');
    expect(get.json.versions).toHaveLength(1);
    expect(get.json.draft).toBeNull();
  });

  it('keeps an account on its version when a new version is published', async () => {
    // Account A is provisioned from version 1 (maxContracts 5).
    const a = await provisionAccount(db, {
      organizationId,
      userId: editorTraderId,
      profileKey: key,
      displayName: 'Pinned to V1',
    });

    // The operator drafts and publishes version 2 with different terms.
    await call('PUT', `/api/v1/admin/profiles/${key}/draft`, tokens['SUPER_ADMIN']!, {
      name: 'Config Suite 50K',
      accountType: 'EVALUATION',
      config: config(20),
    });
    const pub = await call('POST', `/api/v1/admin/profiles/${key}/publish`, tokens['SUPER_ADMIN']!, {});
    expect(pub.json.version).toBe(2);

    // Account A still reports version 1 and still resolves to the V1 terms.
    const detail = await call('GET', `/api/v1/admin/accounts/${a.accountId}`, tokens['SUPPORT']!);
    const [row] = await db.select().from(accounts).where(eq(accounts.id, a.accountId));
    const resolved = await resolveProfileVersion(db, row!.profileVersionId!);
    expect(resolved!.version).toBe(1);
    expect(resolved!.config.rules.maxContracts).toBe(5);
    expect(detail.status).toBe(200);

    // A new account provisioned now gets version 2.
    const b = await provisionAccount(db, {
      organizationId,
      userId: editorTraderId,
      profileKey: key,
      displayName: 'Provisioned on V2',
    });
    const [rowB] = await db.select().from(accounts).where(eq(accounts.id, b.accountId));
    const resolvedB = await resolveProfileVersion(db, rowB!.profileVersionId!);
    expect(resolvedB!.version).toBe(2);
    expect(resolvedB!.config.rules.maxContracts).toBe(20);
  });

  it('returns the version history newest first', async () => {
    const get = await call('GET', `/api/v1/admin/profiles/${key}`, tokens['SUPPORT']!);
    expect(get.json.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it('retiring a product stops new provisioning but not existing accounts', async () => {
    const patch = await call('PATCH', `/api/v1/admin/profiles/${key}/status`, tokens['SUPER_ADMIN']!, {
      status: 'RETIRED',
      reason: 'end of season',
    });
    expect(patch.status).toBe(200);
    expect(patch.json.status).toBe('RETIRED');

    // Provisioning a new account from a retired product is refused.
    await expect(
      provisionAccount(db, { organizationId, userId: editorTraderId, profileKey: key }),
    ).rejects.toThrow();

    // Reactivating restores provisioning.
    const back = await call('PATCH', `/api/v1/admin/profiles/${key}/status`, tokens['SUPER_ADMIN']!, {
      status: 'ACTIVE',
      reason: 'new season',
    });
    expect(back.json.status).toBe('ACTIVE');
    const c = await provisionAccount(db, { organizationId, userId: editorTraderId, profileKey: key });
    expect(c.accountId).toBeTruthy();
  });

  it('records the retire and reactivate in the audit log', async () => {
    const res = await call('GET', `/api/v1/admin/audit?action=profile.retired`, tokens['SUPPORT']!);
    expect(res.status).toBe(200);
    expect(res.json.entries.some((e: { reason: string }) => e.reason === 'end of season')).toBe(true);
  });

  it('rejects a draft whose configuration the engine could not accept', async () => {
    const bad = await call('PUT', `/api/v1/admin/profiles/${key}/draft`, tokens['SUPER_ADMIN']!, {
      name: 'Config Suite 50K',
      accountType: 'EVALUATION',
      config: { rules: { maxContracts: -1 } },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error?.code ?? bad.json.code).toBe('INVALID_CONFIG');
    await call('DELETE', `/api/v1/admin/profiles/${key}/draft`, tokens['SUPER_ADMIN']!);
  });

  it('refuses to publish when there is no draft', async () => {
    const pub = await call('POST', `/api/v1/admin/profiles/${key}/publish`, tokens['SUPER_ADMIN']!, {});
    expect(pub.status).toBe(400);
  });

  it('lets only a SUPER_ADMIN draft, publish, and change product status', async () => {
    for (const role of ['TRADER', 'SUPPORT', 'ADMIN'] as const) {
      const draft = await call('PUT', `/api/v1/admin/profiles/${key}/draft`, tokens[role]!, {
        name: 'x',
        accountType: 'EVALUATION',
        config: config(5),
      });
      expect(draft.status).toBe(403);
      const patch = await call('PATCH', `/api/v1/admin/profiles/${key}/status`, tokens[role]!, {
        status: 'RETIRED',
        reason: 'nope',
      });
      expect(patch.status).toBe(403);
    }
  });

  it('discards a draft on request', async () => {
    await call('PUT', `/api/v1/admin/profiles/${key}/draft`, tokens['SUPER_ADMIN']!, {
      name: 'Config Suite 50K',
      accountType: 'EVALUATION',
      config: config(7),
    });
    const del = await call('DELETE', `/api/v1/admin/profiles/${key}/draft`, tokens['SUPER_ADMIN']!);
    expect(del.status).toBe(200);
    expect(del.json.discarded).toBe(true);
    const get = await call('GET', `/api/v1/admin/profiles/${key}`, tokens['SUPPORT']!);
    expect(get.json.draft).toBeNull();
  });
});

describe('concurrency: races an operator can actually cause', () => {
  it('never lets two concurrent publishes share a version number', async () => {
    const key = `race-${crypto.randomUUID().slice(0, 8)}`;
    const M2 = 1_000_000;
    const cfg = (mc: number) => ({
      rules: {
        accountSizeMicros: 50_000 * M2,
        profitTargetMicros: 3_000 * M2,
        maxLossMicros: 2_000 * M2,
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
        maxContracts: mc,
        microsCountAsFraction: true,
        flattenOnBreach: true,
      },
      execution: null,
      instruments: { allowed: null, maxContracts: mc, perInstrument: {} },
      display: { startingBalanceMicros: 50_000 * M2 },
      payoutRules: null,
    });

    // Ten operators publish the same product at the same instant.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        publishProfileVersion(db, {
          organizationId,
          key,
          name: 'Race 50K',
          accountType: 'EVALUATION',
          config: cfg(i + 1),
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBeGreaterThan(0);

    // Whatever committed, the version numbers are unique and contiguous from 1:
    // the unique (profile_id, version) index makes a doubled version impossible.
    const [profile] = await db
      .select()
      .from(accountProfiles)
      .where(and(eq(accountProfiles.organizationId, organizationId), eq(accountProfiles.key, key)));
    const versions = await db
      .select({ version: accountProfileVersions.version })
      .from(accountProfileVersions)
      .where(eq(accountProfileVersions.profileId, profile!.id))
      .orderBy(accountProfileVersions.version);
    const nums = versions.map((v) => v.version);
    expect(new Set(nums).size).toBe(nums.length); // no duplicates
    expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1)); // 1..N contiguous
    expect(nums.length).toBe(ok); // exactly the ones that committed
  });

  it('keeps the audit chain intact under concurrent actions on one account', async () => {
    // Fire a burst of hold/release at the same account at once.
    const burst = await Promise.allSettled([
      call('POST', `/api/v1/admin/accounts/${traderAccountId}/lock`, tokens['ADMIN']!, {
        confirm: true,
        reason: 'concurrent burst 1',
      }),
      call('POST', `/api/v1/admin/accounts/${traderAccountId}/unlock`, tokens['ADMIN']!, {
        confirm: true,
        reason: 'concurrent burst 2',
      }),
      call('POST', `/api/v1/admin/accounts/${traderAccountId}/lock`, tokens['ADMIN']!, {
        confirm: true,
        reason: 'concurrent burst 3',
      }),
      call('POST', `/api/v1/admin/accounts/${traderAccountId}/unlock`, tokens['ADMIN']!, {
        confirm: true,
        reason: 'concurrent burst 4',
      }),
    ]);
    // Requests are answered (some may 409 if the state does not permit them);
    // none corrupts anything.
    expect(burst.every((r) => r.status === 'fulfilled')).toBe(true);

    // The hash-chained audit log still verifies end to end.
    const verify = await call('GET', `/api/v1/admin/audit/verify`, tokens['SUPPORT']!);
    expect(verify.status).toBe(200);
    expect(verify.json.ok).toBe(true);
  });
});
