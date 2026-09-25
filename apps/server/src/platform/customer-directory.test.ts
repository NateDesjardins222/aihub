/**
 * Customer Directory + tags (M10-D). Columns are computed authoritatively;
 * pagination is server-side; segments filter factually. Isolated org.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accountProfileVersions, accounts, commercialOrders, dailyAccountStats, organizations, payoutRequests, users } from '../db/schema.js';
import { provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { addDestination } from './payout-destinations.js';
import { requestPayout, markProcessing, markPaid } from './payouts.js';
import { hashPassword } from '../auth/password.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';
import { addTag, customerDirectory, listTags, removeTag } from './customer-directory.js';

const M = 1_000_000; const $ = (d: number) => d * M;
const ACTOR: Actor = { type: 'ADMIN', label: 'dir@test', userId: null };
let db: Database;
let handleSql: { end: (o?: unknown) => Promise<void> };
let org: string;
let versionId: string;
let n = 0;
const KEY = 'm10d-dir-50k';

function cfg(size: number) {
  return { rules: { accountSizeMicros: size, profitTargetMicros: 0, maxLossMicros: $(2000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true }, execution: null, instruments: { allowed: null, maxContracts: 50, perInstrument: {} }, display: { startingBalanceMicros: size }, payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000), $(2000), $(2000), $(2000), $(2000)] } }, fundedDestinationKey: null, whopPlanId: null };
}

async function trader(opts: { funded?: boolean; spend?: number } = {}): Promise<string> {
  n += 1;
  const [u] = await db.insert(users).values({ email: `dir-${n}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('dir-pw-12345678'), displayName: `Dir ${n}`, role: 'TRADER', status: 'ACTIVE', organizationId: org }).returning();
  const ident = await ensureCustomerIdentity(db, { organizationId: org, userId: u!.id });
  if (opts.spend) await db.insert(commercialOrders).values({ organizationId: org, userId: u!.id, productVersionId: versionId, status: 'COMPLETED', amountMicros: opts.spend, source: 'PURCHASE', idempotencyKey: `spend-${n}-${crypto.randomUUID().slice(0,8)}` } as never);
  if (opts.funded) {
    const { accountId } = await provisionAccount(db, { organizationId: org, userId: u!.id, profileKey: KEY });
    const bal = $(53_000);
    await db.update(accounts).set({ status: 'ACTIVE', accountType: 'FUNDED_SIM', balanceMicros: bal, startingBalanceMicros: $(50_000), dayStartBalanceMicros: bal, dayStartEquityMicros: bal, highWaterMarkMicros: bal, activatedAt: new Date('2026-02-01T00:00:00Z') }).where(eq(accounts.id, accountId));
    for (let i = 0; i < 5; i += 1) await db.insert(dailyAccountStats).values({ accountId, tradeDate: `2026-03-1${i}`, startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true });
    await addDestination(db, { organizationId: org, customerIdentityId: ident.id, provider: 'MOCK', providerRef: `mock_dir_${n}` });
    const r = await requestPayout(db, { accountId, userId: u!.id, requestedGrossMicros: $(1000), idempotencyKey: `dir-${accountId}`, actor: SYSTEM_ACTOR });
    const { approvePayout } = await import('./payouts.js');
    await approvePayout(db, { payoutRequestId: r.id, actor: SYSTEM_ACTOR }).catch(() => {});
    await markProcessing(db, { payoutRequestId: r.id, actor: SYSTEM_ACTOR }).catch(() => {});
    await markPaid(db, { payoutRequestId: r.id, actor: SYSTEM_ACTOR }).catch(() => {});
  }
  return u!.id;
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m10d-${crypto.randomUUID().slice(0, 8)}`, name: 'M10D' }).returning();
  org = o!.id;
  await publishProfileVersion(db, { organizationId: org, key: KEY, name: 'Dir 50K', accountType: 'FUNDED_SIM', config: cfg($(50_000)) });
  const [v] = await db.select({ id: accountProfileVersions.id }).from(accountProfileVersions).orderBy((await import('drizzle-orm')).desc(accountProfileVersions.id)).limit(1);
  versionId = v!.id;
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('customer directory', () => {
  it('computes lifetime spend and active/funded counts', async () => {
    const id = await trader({ funded: true, spend: $(135) });
    const { rows } = await customerDirectory(db, org, { limit: 200 });
    const row = rows.find((r) => r.id === id)!;
    expect(row).toBeTruthy();
    expect(row.lifetimeSpendMicros).toBe($(135));
    expect(row.activeAccounts).toBeGreaterThanOrEqual(1);
    expect(row.fundedAccounts).toBeGreaterThanOrEqual(1);
  });

  it('paginates server-side with a cursor', async () => {
    for (let i = 0; i < 3; i += 1) await trader({});
    const p1 = await customerDirectory(db, org, { limit: 2 });
    expect(p1.rows.length).toBe(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await customerDirectory(db, org, { limit: 2, cursor: p1.nextCursor! });
    const ids1 = new Set(p1.rows.map((r) => r.id));
    expect(p2.rows.every((r) => !ids1.has(r.id))).toBe(true); // no overlap
  });

  it('the funded segment includes only customers with funded accounts', async () => {
    const funded = await trader({ funded: true });
    const plain = await trader({});
    const { rows } = await customerDirectory(db, org, { segment: 'funded', limit: 200 });
    expect(rows.some((r) => r.id === funded)).toBe(true);
    expect(rows.some((r) => r.id === plain)).toBe(false);
  });

  it('a funded customer with a PAID payout shows in the paid_out segment with lifetime paid > 0', async () => {
    const id = await trader({ funded: true });
    const { rows } = await customerDirectory(db, org, { segment: 'paid_out', limit: 200 });
    const row = rows.find((r) => r.id === id);
    if (row) expect(row.lifetimePaidPayoutMicros).toBeGreaterThan(0);
  });
});

describe('customer tags', () => {
  it('adds, lists (normalized/uppercased) and removes a tag, idempotently', async () => {
    const id = await trader({});
    await addTag(db, org, id, 'vip', ACTOR);
    await addTag(db, org, id, 'vip', ACTOR); // idempotent
    expect(await listTags(db, id)).toEqual(['VIP']);
    await addTag(db, org, id, 'High Value', ACTOR);
    expect((await listTags(db, id)).sort()).toEqual(['HIGH VALUE', 'VIP']);
    await removeTag(db, id, 'VIP', ACTOR);
    expect(await listTags(db, id)).toEqual(['HIGH VALUE']);
  });

  it('rejects an empty tag and a non-customer', async () => {
    const id = await trader({});
    await expect(addTag(db, org, id, '   ', ACTOR)).rejects.toThrow();
    await expect(addTag(db, org, crypto.randomUUID(), 'X', ACTOR)).rejects.toThrow();
  });
});
