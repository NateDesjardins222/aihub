/**
 * Owner OS observability (M10-C): unified event query + streams, correlation
 * trace, global search, and the state/rules inspectors that consume
 * server-authoritative reason codes. Runs against the test database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, dailyAccountStats } from '../db/schema.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { requestPayout } from './payouts.js';
import { addDestination } from './payout-destinations.js';
import { SYSTEM_ACTOR } from './actor.js';
import { hashPassword } from '../auth/password.js';
import { users } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { queryOpsEvents, correlationTrace } from './ops-events.js';
import { globalSearch } from './search.js';
import { inspectAccount, inspectPayout, payoutStateMachine } from './inspectors.js';
import { explainObject } from './object-explorer.js';

const M = 1_000_000;
const $ = (d: number) => d * M;
let db: Database;
let handleSql: { end: (o?: unknown) => Promise<void> };
let organizationId: string;
let seq = 0;
const KEY = 'm10c-obs-50k';

function fundedConfig(size: number) {
  return {
    rules: { accountSizeMicros: size, profitTargetMicros: 0, maxLossMicros: $(2000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true },
    execution: null, instruments: { allowed: null, maxContracts: 50, perInstrument: {} }, display: { startingBalanceMicros: size },
    payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000), $(2000), $(2000), $(2000), $(2000)] } },
    fundedDestinationKey: null, whopPlanId: null,
  };
}

async function fundedTrader(): Promise<{ userId: string; accountId: string; identityId: string; publicId: string; payoutId: string }> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `obs-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('obs-pw-1234567890'), displayName: `Obs Trader ${seq}`, role: 'TRADER', status: 'ACTIVE', organizationId }).returning();
  const ident = await ensureCustomerIdentity(db, { organizationId, userId: u!.id });
  const { accountId } = await provisionAccount(db, { organizationId, userId: u!.id, profileKey: KEY });
  const balance = $(53_000);
  await db.update(accounts).set({ balanceMicros: balance, startingBalanceMicros: $(50_000), dayStartBalanceMicros: balance, dayStartEquityMicros: balance, highWaterMarkMicros: Math.max(balance, $(50_000)), activatedAt: new Date('2026-02-01T00:00:00Z') }).where(eq(accounts.id, accountId));
  for (let i = 0; i < 5; i += 1) {
    await db.insert(dailyAccountStats).values({ accountId, tradeDate: `2026-03-1${i}`, startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true });
  }
  await addDestination(db, { organizationId, customerIdentityId: ident.id, provider: 'MOCK', providerRef: `mock_obs_${seq}` });
  const r = await requestPayout(db, { accountId, userId: u!.id, requestedGrossMicros: $(1000), idempotencyKey: `obs-req-${accountId}`, actor: SYSTEM_ACTOR });
  const [row] = await db.select({ publicId: accounts.publicId }).from(accounts).where(eq(accounts.id, accountId));
  return { userId: u!.id, accountId, identityId: ident.id, publicId: row!.publicId!, payoutId: r.id };
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: KEY, name: 'Obs 50K', accountType: 'FUNDED_SIM', config: fundedConfig($(50_000)) });
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('unified event query + streams', () => {
  it('classifies staff/security actions into the SECURITY stream', async () => {
    await recordAudit(db, { organizationId, actor: { type: 'ADMIN', label: 'op@test' }, subjectType: 'USER', subjectId: crypto.randomUUID(), action: 'staff.invited', reason: 'test' });
    const sec = await queryOpsEvents(db, organizationId, { stream: 'SECURITY', limit: 50 });
    expect(sec.every((e) => e.stream === 'SECURITY')).toBe(true);
    expect(sec.some((e) => e.type === 'staff.invited')).toBe(true);
  });

  it('an ordinary admin action lands in the AUDIT stream, not SECURITY', async () => {
    await recordAudit(db, { organizationId, actor: { type: 'ADMIN', label: 'op@test' }, subjectType: 'ACCOUNT', subjectId: crypto.randomUUID(), action: 'admin.account.note', reason: 'test' });
    const audit = await queryOpsEvents(db, organizationId, { stream: 'AUDIT', limit: 100 });
    expect(audit.some((e) => e.type === 'admin.account.note')).toBe(true);
    expect(audit.every((e) => e.stream === 'AUDIT')).toBe(true);
  });

  it('returns newest-first and respects the limit', async () => {
    const rows = await queryOpsEvents(db, organizationId, { limit: 5 });
    expect(rows.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < rows.length; i += 1) expect(rows[i - 1]!.at >= rows[i]!.at).toBe(true);
  });
});

describe('correlation trace', () => {
  it('pulls every event tied to a correlation id, oldest first', async () => {
    const correlationId = `corr-${crypto.randomUUID()}`;
    await recordAudit(db, { organizationId, actor: SYSTEM_ACTOR, subjectType: 'ACCOUNT', subjectId: crypto.randomUUID(), action: 'trace.step.one', context: { correlationId } });
    await recordAudit(db, { organizationId, actor: SYSTEM_ACTOR, subjectType: 'ACCOUNT', subjectId: crypto.randomUUID(), action: 'trace.step.two', context: { correlationId } });
    const trace = await correlationTrace(db, organizationId, correlationId);
    expect(trace.length).toBeGreaterThanOrEqual(2);
    expect(trace.every((e) => e.correlationId === correlationId)).toBe(true);
    for (let i = 1; i < trace.length; i += 1) expect(trace[i - 1]!.at <= trace[i]!.at).toBe(true); // oldest first
  });

  it('an unknown correlation id yields an empty trace', async () => {
    expect(await correlationTrace(db, organizationId, 'nope-does-not-exist')).toHaveLength(0);
  });
});

describe('global search', () => {
  it('finds an account by its public id and a customer by email', async () => {
    const t = await fundedTrader();
    const byAccount = await globalSearch(db, organizationId, t.publicId);
    expect(byAccount.groups.find((g) => g.type === 'account')?.results.some((r) => r.id === t.accountId)).toBe(true);
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, t.userId));
    const byEmail = await globalSearch(db, organizationId, u!.email);
    expect(byEmail.groups.find((g) => g.type === 'customer')?.results.some((r) => r.id === t.userId)).toBe(true);
  });

  it('a too-short query returns nothing', async () => {
    expect((await globalSearch(db, organizationId, 'a')).total).toBe(0);
  });

  it('finds a payout by uuid', async () => {
    const t = await fundedTrader();
    const res = await globalSearch(db, organizationId, t.payoutId);
    expect(res.groups.find((g) => g.type === 'payout')?.results.some((r) => r.id === t.payoutId)).toBe(true);
  });
});

describe('inspectors consume server-authoritative reason codes', () => {
  it('the payout inspector reports real eligibility reason codes and the real state machine', async () => {
    const t = await fundedTrader();
    const view = await inspectPayout(db, t.payoutId);
    expect(view.stateMachine.kind).toBe('payout');
    expect(Array.isArray(view.eligibility.reasonCodes)).toBe(true);
    expect(view.maxCycles).toBe(5);
    // REQUESTED transitions are exactly the domain machine's.
    expect(payoutStateMachine('REQUESTED').validNext).toContain('APPROVED');
    expect(payoutStateMachine('PAID').terminal).toBe(true);
  });

  it('the account inspector reports the drawdown band and lifecycle history', async () => {
    const t = await fundedTrader();
    const view = await inspectAccount(db, t.accountId);
    expect(view.publicId).toBe(t.publicId);
    expect(['SAFE', 'APPROACHING', 'AT_RISK', 'BREACHED']).toContain(view.drawdown.band);
    expect(Array.isArray(view.lifecycles)).toBe(true);
  });

  it('the object explorer resolves account, customer and payout without dumping secrets', async () => {
    const t = await fundedTrader();
    const acct = await explainObject(db, organizationId, 'account', t.accountId);
    expect(acct.title).toBe(t.publicId);
    const cust = await explainObject(db, organizationId, 'customer', t.userId);
    expect(cust.related.some((r) => r.id === t.accountId)).toBe(true);
    const payout = await explainObject(db, organizationId, 'payout', t.payoutId);
    expect(payout.related.some((r) => r.id === t.accountId)).toBe(true);
    await expect(explainObject(db, organizationId, 'nonsense', 'x')).rejects.toThrow();
  });
});
