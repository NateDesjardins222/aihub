/**
 * Provisioning, lifecycles, products and the audit trail.
 *
 * Against the real database and the real HTTP layer, because the guarantees
 * being tested are exactly the ones a mock would assume: that a webhook firing
 * twice produces one account, that a trader's ten accounts do not share state,
 * that a reset keeps the history it resets past, and that editing a product
 * cannot change the terms of an account already trading it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import {
  accountLifecycles,
  accountProfileVersions,
  accountProfiles,
  accounts,
  auditLog,
  domainEvents,
  trades,
  users,
} from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { loadAccountAndTemplate } from '../trading/account-rules.js';
import { publishProfileVersion, resolveProfileByKey } from './profiles.js';
import {
  ProvisioningError,
  defaultOrganizationId,
  ensurePracticeAccount,
  provisionAccount,
} from './provisioning.js';
import { resetAccount } from './account-service.js';
import { verifyAuditChain } from './audit.js';

const M = 1_000_000;

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
let startedAt: Date;
const users_: string[] = [];

/** A product with permissive terms, published for this run only. */
const TEST_KEY = `test-product-${Math.random().toString(36).slice(2, 8)}`;

function rules(overrides: Record<string, unknown> = {}) {
  return {
    accountSizeMicros: 150_000 * M,
    profitTargetMicros: 9_000 * M,
    maxLossMicros: 4_500 * M,
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
    maxContracts: 15,
    microsCountAsFraction: true,
    flattenOnBreach: true,
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    rules: rules(overrides['rules'] as Record<string, unknown>),
    execution: null,
    instruments: { allowed: null, maxContracts: 15, perInstrument: {} },
    display: { startingBalanceMicros: 150_000 * M },
    payoutRules: null,
  };
}

async function makeUser(label: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`,
      passwordHash: await hashPassword('provisioning-test-password'),
      displayName: label,
      organizationId,
    })
    .returning();
  users_.push(user!.id);
  return user!.id;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  startedAt = new Date();

  await publishProfileVersion(db, {
    organizationId,
    key: TEST_KEY,
    name: 'Test Product 150K',
    accountType: 'EVALUATION',
    config: config(),
  });

  // The practice product the registration path provisions from. Published here
  // because a bare test database has never been seeded.
  await publishProfileVersion(db, {
    organizationId,
    key: 'practice-150k',
    name: 'Practice 150K',
    accountType: 'PRACTICE',
    config: config({ rules: { maxLossMicros: 150_000 * M, profitTargetMicros: 0 } }),
  }).catch(() => undefined);
});

afterAll(async () => {
  for (const id of users_) await db.delete(users).where(eq(users.id, id));
  await app.close();
});

describe('provisioning', () => {
  it('creates an account with a public number, a lifecycle and a pinned product', async () => {
    const userId = await makeUser('provision');
    const result = await provisionAccount(db, {
      organizationId,
      userId,
      profileKey: TEST_KEY,
      displayName: 'Evaluation A',
    });

    expect(result.publicId).toMatch(/^SIM-\d{6}$/);

    const [account] = await db.select().from(accounts).where(eq(accounts.id, result.accountId));
    expect(account!.status).toBe('ACTIVE');
    expect(account!.organizationId).toBe(organizationId);
    expect(account!.profileVersionId).toBe(result.profile.versionId);
    expect(account!.balanceMicros).toBe(150_000 * M);
    expect(account!.drawdownFloorMicros).toBe(150_000 * M - 4_500 * M);
    expect(account!.activatedAt).not.toBeNull();

    const [lifecycle] = await db
      .select()
      .from(accountLifecycles)
      .where(eq(accountLifecycles.id, account!.currentLifecycleId!));
    expect(lifecycle!.seq).toBe(1);
    expect(lifecycle!.endedAt).toBeNull();
  });

  it('can hand out an account that is not yet tradeable', async () => {
    const userId = await makeUser('pending');
    const result = await provisionAccount(db, {
      organizationId,
      userId,
      profileKey: TEST_KEY,
      activate: false,
    });
    const [account] = await db.select().from(accounts).where(eq(accounts.id, result.accountId));
    expect(account!.status).toBe('PENDING');
    expect(account!.activatedAt).toBeNull();
  });

  it('is idempotent: the same key returns the same account', async () => {
    const userId = await makeUser('idempotent');
    const key = `purchase-${crypto.randomUUID()}`;
    const first = await provisionAccount(db, {
      organizationId,
      userId,
      profileKey: TEST_KEY,
      idempotencyKey: key,
    });
    const second = await provisionAccount(db, {
      organizationId,
      userId,
      profileKey: TEST_KEY,
      idempotencyKey: key,
    });

    expect(second.accountId).toBe(first.accountId);
    expect(second.reused).toBe(true);

    const rows = await db.select().from(accounts).where(eq(accounts.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it('refuses the same key for a different request', async () => {
    const userId = await makeUser('conflict');
    const key = `purchase-${crypto.randomUUID()}`;
    await provisionAccount(db, { organizationId, userId, profileKey: TEST_KEY, idempotencyKey: key });
    await expect(
      provisionAccount(db, {
        organizationId,
        userId,
        profileKey: TEST_KEY,
        startingBalanceMicros: 999 * M,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('refuses a product that does not exist', async () => {
    const userId = await makeUser('missing-product');
    await expect(
      provisionAccount(db, { organizationId, userId, profileKey: 'no-such-product' }),
    ).rejects.toBeInstanceOf(ProvisioningError);
  });

  it('refuses to provision for a user in another organisation', async () => {
    const userId = await makeUser('other-org');
    await db
      .update(users)
      .set({ organizationId: null })
      .where(eq(users.id, userId));
    await db
      .update(users)
      .set({ organizationId: crypto.randomUUID() })
      .where(eq(users.id, userId))
      .catch(() => undefined);
    // A foreign key stops the fake organisation being stored, so the check is
    // exercised through a real second organisation instead.
    const [other] = await db
      .insert(await import('../db/schema.js').then((m) => m.organizations))
      .values({ slug: `other-${crypto.randomUUID().slice(0, 8)}`, name: 'Other Firm' })
      .returning();
    await db.update(users).set({ organizationId: other!.id }).where(eq(users.id, userId));

    await expect(
      provisionAccount(db, { organizationId, userId, profileKey: TEST_KEY }),
    ).rejects.toMatchObject({ code: 'ORGANIZATION_MISMATCH' });
  });
});

describe('registration', () => {
  it('gives a new trader a practice account through the provisioning service', async () => {
    const email = `signup-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'a-long-enough-password', displayName: 'New Trader' },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    users_.push(body.user.id);

    const rows = await db.select().from(accounts).where(eq(accounts.userId, body.user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountType).toBe('PRACTICE');
    expect(rows[0]!.status).toBe('ACTIVE');
    expect(rows[0]!.currentLifecycleId).not.toBeNull();

    // And it is the account the terminal will show, through the ordinary API.
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    const listedBody = JSON.parse(listed.body);
    expect(listedBody.accounts).toHaveLength(1);
    expect(listedBody.accounts[0].publicId).toMatch(/^SIM-\d{6}$/);
    expect(listedBody.accounts[0].product.key).toBe('practice-150k');
  });

  it('does not give a second one when registration is retried', async () => {
    const userId = await makeUser('retry');
    await ensurePracticeAccount(db, userId, organizationId);
    await ensurePracticeAccount(db, userId, organizationId);
    const rows = await db.select().from(accounts).where(eq(accounts.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it('refuses a disabled user a session', async () => {
    const email = `disabled-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'a-long-enough-password', displayName: 'Disabled' },
    });
    const body = JSON.parse(registered.body);
    users_.push(body.user.id);

    await db.update(users).set({ status: 'DISABLED' }).where(eq(users.id, body.user.id));

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'a-long-enough-password' },
    });
    expect(login.statusCode).toBe(401);
    expect(JSON.parse(login.body).error.code).toBe('USER_DISABLED');
  });
});

describe('a trader with many accounts', () => {
  it('gets all of them, each with its own number, balance and lifecycle', async () => {
    const userId = await makeUser('many');
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const result = await provisionAccount(db, {
        organizationId,
        userId,
        profileKey: TEST_KEY,
        displayName: `Account ${i + 1}`,
        startingBalanceMicros: (50_000 + i * 1_000) * M,
      });
      ids.push(result.accountId);
    }

    const rows = await db.select().from(accounts).where(eq(accounts.userId, userId));
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((r) => r.publicId)).size).toBe(10);
    expect(new Set(rows.map((r) => r.currentLifecycleId)).size).toBe(10);
    expect(new Set(rows.map((r) => r.balanceMicros)).size).toBe(10);

    // Changing one account's balance leaves the other nine alone.
    await db
      .update(accounts)
      .set({ balanceMicros: 1 })
      .where(eq(accounts.id, ids[0]!));
    const after = await db.select().from(accounts).where(eq(accounts.userId, userId));
    expect(after.filter((row) => row.balanceMicros === 1)).toHaveLength(1);
  });
});

describe('reset', () => {
  it('restores the balance, opens a new life and keeps the old one', async () => {
    const userId = await makeUser('reset');
    const { accountId } = await provisionAccount(db, {
      organizationId,
      userId,
      profileKey: TEST_KEY,
    });

    // Trade the account down, and leave a trade in the record.
    await db
      .update(accounts)
      .set({ balanceMicros: 148_000 * M, tradingDaysCount: 3, bestDayProfitMicros: 500 * M })
      .where(eq(accounts.id, accountId));
    await db.insert(trades).values({
      accountId,
      symbol: 'NQ',
      side: 'LONG',
      qty: 1,
      entryTicksScaled: 80_000 * M,
      exitTicksScaled: 79_900 * M,
      entryTime: new Date(),
      exitTime: new Date(),
      grossPnlMicros: -2_000 * M,
      feesMicros: 0,
      netPnlMicros: -2_000 * M,
      tradeDate: '2026-09-16',
    });

    const result = await resetAccount(db, accountId, {
      actor: { type: 'ADMIN', label: 'tester' },
      reason: 'Trader asked for a fresh start',
    });

    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(account!.balanceMicros).toBe(150_000 * M);
    expect(account!.tradingDaysCount).toBe(0);
    expect(account!.bestDayProfitMicros).toBe(0);
    expect(account!.status).toBe('ACTIVE');
    expect(account!.currentLifecycleId).toBe(result.lifecycleId);

    // The previous life is closed, with what it ended on.
    const lives = await db
      .select()
      .from(accountLifecycles)
      .where(eq(accountLifecycles.accountId, accountId))
      .orderBy(accountLifecycles.seq);
    expect(lives).toHaveLength(2);
    expect(lives[0]!.endedAt).not.toBeNull();
    expect(lives[0]!.endReason).toBe('RESET');
    expect(lives[0]!.finalBalanceMicros).toBe(148_000 * M);
    expect(lives[1]!.seq).toBe(2);
    expect(lives[1]!.endedAt).toBeNull();

    // And nothing the trader did was destroyed.
    const history = await db.select().from(trades).where(eq(trades.accountId, accountId));
    expect(history).toHaveLength(1);
    expect(history[0]!.netPnlMicros).toBe(-2_000 * M);
  });
});

describe('product versions', () => {
  it('do not change the terms of an account already trading', async () => {
    const key = `versioned-${crypto.randomUUID().slice(0, 8)}`;
    await publishProfileVersion(db, {
      organizationId,
      key,
      name: 'Versioned 100K',
      accountType: 'EVALUATION',
      config: config({ rules: { maxContracts: 5 } }),
    });

    const userId = await makeUser('versioned');
    const { accountId } = await provisionAccount(db, { organizationId, userId, profileKey: key });
    const before = await loadAccountAndTemplate(db, accountId);
    expect(before!.template!.maxContracts).toBe(5);

    // The firm changes the product.
    await publishProfileVersion(db, {
      organizationId,
      key,
      name: 'Versioned 100K',
      accountType: 'EVALUATION',
      config: config({ rules: { maxContracts: 25 } }),
    });

    const after = await loadAccountAndTemplate(db, accountId);
    expect(after!.template!.maxContracts, 'the trading account kept its terms').toBe(5);

    // A NEW account gets the new terms.
    const other = await provisionAccount(db, { organizationId, userId, profileKey: key });
    const fresh = await loadAccountAndTemplate(db, other.accountId);
    expect(fresh!.template!.maxContracts).toBe(25);

    const versions = await db
      .select()
      .from(accountProfileVersions)
      .innerJoin(accountProfiles, eq(accountProfileVersions.profileId, accountProfiles.id))
      .where(eq(accountProfiles.key, key));
    expect(versions).toHaveLength(2);
  });

  it('resolve to the newest version by key', async () => {
    const resolved = await resolveProfileByKey(db, organizationId, TEST_KEY);
    expect(resolved.profileKey).toBe(TEST_KEY);
    expect(resolved.config.rules.maxContracts).toBe(15);
  });
});

describe('the record', () => {
  it('writes an audit row and an event for every provisioning and reset', async () => {
    const userId = await makeUser('audited');
    const { accountId } = await provisionAccount(db, {
      organizationId,
      userId,
      profileKey: TEST_KEY,
      actor: { type: 'ADMIN', userId, label: 'tester' },
    });
    await resetAccount(db, accountId, {
      actor: { type: 'ADMIN', userId, label: 'tester' },
      reason: 'test',
    });

    const rows = await db.select().from(auditLog).where(eq(auditLog.accountId, accountId));
    const actions = rows.map((row) => row.action);
    expect(actions).toContain('account.created');
    expect(actions).toContain('account.reset');
    for (const row of rows) expect(row.hash).toMatch(/^[0-9a-f]{64}$/);

    const published = await db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.accountId, accountId));
    const types = published.map((row) => row.type);
    expect(types).toContain('account.created');
    expect(types).toContain('account.activated');
    expect(types).toContain('account.reset');
  });

  it('keeps a hash chain that verifies', async () => {
    const userId = await makeUser('chain');
    await provisionAccount(db, { organizationId, userId, profileKey: TEST_KEY });
    // Verified over this run's window: rows written before it exist, and a
    // chain that has ever been tampered with stays broken by design.
    const verification = await verifyAuditChain(db, organizationId, { since: startedAt });
    expect(verification.ok, `broken at ${verification.brokenAt}`).toBe(true);
    expect(verification.checked).toBeGreaterThan(0);
  });

  it('records the reason an administrator gave', async () => {
    const userId = await makeUser('reasoned');
    const { accountId } = await provisionAccount(db, {
      organizationId,
      userId,
      profileKey: TEST_KEY,
    });
    await resetAccount(db, accountId, {
      actor: { type: 'ADMIN', userId, label: 'admin@atlas.test' },
      reason: 'Customer bought a reset',
    });
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, 'account.reset')));
    expect(row!.reason).toBe('Customer bought a reset');
    expect(row!.actorLabel).toBe('admin@atlas.test');
    expect((row!.prevState as { balanceMicros: number }).balanceMicros).toBe(150_000 * M);
  });
});
