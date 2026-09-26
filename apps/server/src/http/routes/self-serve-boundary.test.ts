/**
 * HTF-21 — the self-serve rule / reset / environment boundary.
 *
 * A trader owns a free PRACTICE simulator and may retune it, restart it, and
 * change its fill assumptions as often as they like. The very same endpoints,
 * pointed at a commercially-weighted account — a paid EVALUATION or a FUNDED
 * account — would let the trader weaken the risk rules they are judged by, revive
 * a breached evaluation for free, or turn off fees / soften fills on the account
 * they get paid from. That is refused: those are operator decisions, made through
 * the Owner OS, never self-served. Read paths stay open.
 *
 * This suite drives the real HTTP app against the real database with a real
 * trader token, and asserts the boundary from the outside — the way an attacker
 * would hit it — not by calling the helper.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { getDb } from '../../db/client.js';
import { accounts, users } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { signAccessToken } from '../../auth/tokens.js';
import { defaultOrganizationId, provisionAccount } from '../../platform/provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from '../../platform/profiles.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const userIds: string[] = [];
const suffix = Math.random().toString(36).slice(2, 8);
const EVAL_KEY = `ss-eval-${suffix}`;
const PRAC_KEY = `ss-prac-${suffix}`;
const FUND_KEY = `ss-fund-${suffix}`;

function config() {
  return {
    rules: {
      accountSizeMicros: 50_000 * M, profitTargetMicros: 3_000 * M, maxLossMicros: 2_000 * M,
      drawdownType: 'EOD_TRAILING', trailingLockAtMicros: 0, dailyLossLimitMicros: null,
      dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: 0.5,
      minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0,
      minWinningDayPnlMicros: 150 * M, maxContracts: 5, microsCountAsFraction: true, flattenOnBreach: true,
    },
    execution: null,
    instruments: { allowed: null, maxContracts: 5, perInstrument: {} },
    display: { startingBalanceMicros: 50_000 * M },
    payoutRules: null,
    fundedDestinationKey: null,
  };
}

async function makeUser(): Promise<{ id: string; token: string }> {
  const email = `ss-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword('pw'), displayName: 'SS Trader', organizationId })
    .returning();
  userIds.push(user!.id);
  const token = signAccessToken({ sub: user!.id, email, isAdmin: false, role: 'TRADER', organizationId });
  return { id: user!.id, token };
}

async function provision(userId: string, key: string): Promise<string> {
  const product = await resolveProfileByKey(db, organizationId, key);
  const r = await provisionAccount(db, {
    organizationId, userId, profileVersionId: product.versionId, activate: true,
  });
  return r.accountId;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['HTF_AUTO_FUNDING'] = 'false';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: EVAL_KEY, name: 'SS Eval 50K', accountType: 'EVALUATION', config: config() });
  await publishProfileVersion(db, { organizationId, key: PRAC_KEY, name: 'SS Practice', accountType: 'PRACTICE', config: config() });
  await publishProfileVersion(db, { organizationId, key: FUND_KEY, name: 'SS Funded 50K', accountType: 'FUNDED_SIM', config: config() });
});

afterAll(async () => {
  if (userIds.length > 0) {
    // Accounts cascade from users; delete the users we created.
    await db.delete(accounts).where(inArray(accounts.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  await app.close();
});

describe('HTF-21 self-serve boundary', () => {
  it('PRACTICE: the owner may edit rules, reset and change environment', async () => {
    const trader = await makeUser();
    const acc = await provision(trader.id, PRAC_KEY);

    const rules = await app.inject({
      method: 'PUT', url: `/api/v1/accounts/${acc}/rules`, headers: auth(trader.token),
      payload: { profitTargetMicros: 1_000 * M },
    });
    expect(rules.statusCode).toBe(200);
    expect(rules.json().config.profitTargetMicros).toBe(1_000 * M);

    const env = await app.inject({
      method: 'PUT', url: `/api/v1/accounts/${acc}/environment`, headers: auth(trader.token),
      payload: { feesEnabled: false },
    });
    expect(env.statusCode).toBe(200);
    expect(env.json().environment.feesEnabled).toBe(false);

    const reset = await app.inject({
      method: 'POST', url: `/api/v1/accounts/${acc}/reset`, headers: auth(trader.token), payload: {},
    });
    expect(reset.statusCode).toBe(200);
  });

  it('EVALUATION: rules, reset and environment self-serve are all refused (403 SELF_SERVE_FORBIDDEN)', async () => {
    const trader = await makeUser();
    const acc = await provision(trader.id, EVAL_KEY);

    const rules = await app.inject({
      method: 'PUT', url: `/api/v1/accounts/${acc}/rules`, headers: auth(trader.token),
      // A trader trying to WEAKEN their own risk: bigger drawdown, no consistency.
      payload: { maxLossMicros: 100_000 * M, consistencyThreshold: null },
    });
    expect(rules.statusCode).toBe(403);
    expect(rules.json().error.code).toBe('SELF_SERVE_FORBIDDEN');

    const reset = await app.inject({
      method: 'POST', url: `/api/v1/accounts/${acc}/reset`, headers: auth(trader.token), payload: {},
    });
    expect(reset.statusCode).toBe(403);
    expect(reset.json().error.code).toBe('SELF_SERVE_FORBIDDEN');

    const env = await app.inject({
      method: 'PUT', url: `/api/v1/accounts/${acc}/environment`, headers: auth(trader.token),
      payload: { feesEnabled: false, marketSlippageTicks: 0 },
    });
    expect(env.statusCode).toBe(403);
    expect(env.json().error.code).toBe('SELF_SERVE_FORBIDDEN');
  });

  it('EVALUATION: the risk parameters are UNCHANGED after a refused edit (the write never happened)', async () => {
    const trader = await makeUser();
    const acc = await provision(trader.id, EVAL_KEY);

    await app.inject({
      method: 'PUT', url: `/api/v1/accounts/${acc}/rules`, headers: auth(trader.token),
      payload: { maxLossMicros: 999_999 * M },
    });

    const [row] = await db
      .select({ overrides: accounts.ruleOverrides, floor: accounts.drawdownFloorMicros })
      .from(accounts)
      .where(inArray(accounts.id, [acc]));
    // No override was persisted, and the provisioned $48k floor stands.
    expect(row!.overrides).toBeNull();
    expect(row!.floor).toBe(48_000 * M);
  });

  it('FUNDED_SIM: self-serve mutations are refused (a funded trader cannot soften their own account)', async () => {
    const trader = await makeUser();
    const acc = await provision(trader.id, FUND_KEY);

    const env = await app.inject({
      method: 'PUT', url: `/api/v1/accounts/${acc}/environment`, headers: auth(trader.token),
      payload: { feesEnabled: false },
    });
    expect(env.statusCode).toBe(403);
    expect(env.json().error.code).toBe('SELF_SERVE_FORBIDDEN');
  });

  it('EVALUATION: the READ paths stay open — a trader can always see their own terms', async () => {
    const trader = await makeUser();
    const acc = await provision(trader.id, EVAL_KEY);

    const rules = await app.inject({
      method: 'GET', url: `/api/v1/accounts/${acc}/rules`, headers: auth(trader.token),
    });
    expect(rules.statusCode).toBe(200);
    expect(rules.json().accountId).toBe(acc);

    const env = await app.inject({
      method: 'GET', url: `/api/v1/accounts/${acc}/environment`, headers: auth(trader.token),
    });
    expect(env.statusCode).toBe(200);
  });

  it('another trader cannot even see the account (ownership still comes first)', async () => {
    const owner = await makeUser();
    const attacker = await makeUser();
    const acc = await provision(owner.id, EVAL_KEY);

    const res = await app.inject({
      method: 'PUT', url: `/api/v1/accounts/${acc}/rules`, headers: auth(attacker.token),
      payload: { profitTargetMicros: 1 * M },
    });
    // Ownership is checked before the self-serve gate, so a stranger gets 404,
    // never a hint that the account exists.
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ACCOUNT_NOT_FOUND');
  });
});
