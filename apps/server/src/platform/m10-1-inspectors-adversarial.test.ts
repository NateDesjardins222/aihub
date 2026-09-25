/**
 * M10.1 hardening — search & inspectors adversarial.
 *
 * Feeds hostile input to the read surfaces: injection-shaped search strings must
 * return safe, grouped results (never a thrown query or a leak), inspectors and
 * the money-trace on non-existent ids must fail closed, and the object explorer
 * must refuse unknown types rather than dumping rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { globalSearch } from './search.js';
import { explainObject } from './object-explorer.js';
import { inspectAccount, inspectPayout } from './inspectors.js';
import { payoutMoneyTrace } from './financial-ops.js';

const M = 1_000_000; const $ = (d: number) => d * M;
let db: Database;
let handleSql: { end: (o?: unknown) => Promise<void> };
let org: string; let accountId = '';
const KEY = 'm101adv-50k';

function cfg(size: number) {
  return { rules: { accountSizeMicros: size, profitTargetMicros: $(3000), maxLossMicros: $(2000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true }, execution: null, instruments: { allowed: null, maxContracts: 50, perInstrument: {} }, display: { startingBalanceMicros: size, priceMicros: $(135) }, payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] } }, fundedDestinationKey: null, whopPlanId: null };
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m101adv-${crypto.randomUUID().slice(0, 8)}`, name: 'M101ADV' }).returning();
  org = o!.id;
  await publishProfileVersion(db, { organizationId: org, key: KEY, name: 'Adv 50K', accountType: 'EVALUATION', config: cfg($(50_000)) });
  const [u] = await db.insert(users).values({ email: `adv-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('adv-pw-12345678'), displayName: 'Adversary', role: 'TRADER', status: 'ACTIVE', organizationId: org }).returning({ id: users.id });
  const prov = await provisionAccount(db, { organizationId: org, userId: u!.id, profileKey: KEY });
  accountId = prov.accountId;
  await db.update(accounts).set({ status: 'ACTIVE', activatedAt: new Date() }).where(eq(accounts.id, accountId));
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

const HOSTILE = [
  "'; DROP TABLE users; --",
  "%' OR '1'='1",
  '\\x00\\x1f',
  '../../etc/passwd',
  '<script>alert(1)</script>',
  'a'.repeat(500),
  '   ',
  '👾🔥',
];

describe('global search survives hostile input', () => {
  it.each(HOSTILE)('returns a safe grouped response for %j', async (q) => {
    const res = await globalSearch(db, org, q);
    expect(Array.isArray(res.groups)).toBe(true);
    expect(typeof res.total).toBe('number');
  });
  it('a too-short query returns nothing', async () => {
    const res = await globalSearch(db, org, 'a');
    expect(res.total).toBe(0);
  });
  it('a non-uuid that looks like one is handled safely', async () => {
    const res = await globalSearch(db, org, '00000000-0000-0000-0000-00000000zzzz');
    expect(Array.isArray(res.groups)).toBe(true);
  });
});

describe('inspectors and money-trace fail closed on unknown ids', () => {
  it('inspectAccount on a real account succeeds', async () => {
    const a = await inspectAccount(db, accountId);
    expect(a.status).toBeTruthy();
  });
  it('inspectAccount on a non-existent id throws', async () => {
    await expect(inspectAccount(db, crypto.randomUUID())).rejects.toThrow();
  });
  it('inspectPayout on a non-existent id throws', async () => {
    await expect(inspectPayout(db, crypto.randomUUID())).rejects.toThrow();
  });
  it('payoutMoneyTrace on a non-existent id throws', async () => {
    await expect(payoutMoneyTrace(db, crypto.randomUUID())).rejects.toThrow();
  });
});

describe('object explorer refuses garbage rather than dumping rows', () => {
  it('explains a real account', async () => {
    const v = await explainObject(db, org, 'account', accountId);
    expect(v.type).toBe('account');
    expect(JSON.stringify(v)).not.toContain('passwordHash');
  });
  it.each(['organizations', 'users', 'secrets', 'sessions', 'payout_ledger', '../etc'])('refuses unsupported type %j', async (type) => {
    await expect(explainObject(db, org, type, accountId)).rejects.toThrow();
  });
  it('a supported type with a missing id throws not-found', async () => {
    await expect(explainObject(db, org, 'account', crypto.randomUUID())).rejects.toThrow();
    await expect(explainObject(db, org, 'customer', crypto.randomUUID())).rejects.toThrow();
  });
});
