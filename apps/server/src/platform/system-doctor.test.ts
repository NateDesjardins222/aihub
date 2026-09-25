/**
 * System Doctor + Data Integrity Center + Reconciliation Center (M10-G).
 * Runs against an ISOLATED organization so corrupt fixtures never pollute the
 * shared default org that other suites' integrity runs scope to.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, dailyAccountStats, organizations, payoutRequests, users } from '../db/schema.js';
import { provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { requestPayout } from './payouts.js';
import { addDestination } from './payout-destinations.js';
import { hashPassword } from '../auth/password.js';
import { SYSTEM_ACTOR } from './actor.js';
import { runSystemDoctor } from './system-doctor.js';
import { runIntegrityChecks } from './integrity.js';
import { reconciliationCenter } from './reconciliation-center.js';

const M = 1_000_000; const $ = (d: number) => d * M;
let db: Database;
let handleSql: { end: (o?: unknown) => Promise<void> };
let org: string;
let seq = 0;
const KEY = 'm10g-sysdoc-50k';

function cfg(size: number) {
  return { rules: { accountSizeMicros: size, profitTargetMicros: 0, maxLossMicros: $(2000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true }, execution: null, instruments: { allowed: null, maxContracts: 50, perInstrument: {} }, display: { startingBalanceMicros: size }, payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000), $(2000), $(2000), $(2000), $(2000)] } }, fundedDestinationKey: null, whopPlanId: null };
}

async function fundedPayout(): Promise<{ payoutId: string; accountId: string }> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `sysdoc-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('sysdoc-pw-123456'), displayName: `SD ${seq}`, role: 'TRADER', status: 'ACTIVE', organizationId: org }).returning();
  const ident = await ensureCustomerIdentity(db, { organizationId: org, userId: u!.id });
  const { accountId } = await provisionAccount(db, { organizationId: org, userId: u!.id, profileKey: KEY });
  const bal = $(53_000);
  await db.update(accounts).set({ balanceMicros: bal, startingBalanceMicros: $(50_000), dayStartBalanceMicros: bal, dayStartEquityMicros: bal, highWaterMarkMicros: bal, activatedAt: new Date('2026-02-01T00:00:00Z') }).where(eq(accounts.id, accountId));
  for (let i = 0; i < 5; i += 1) await db.insert(dailyAccountStats).values({ accountId, tradeDate: `2026-03-1${i}`, startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true });
  await addDestination(db, { organizationId: org, customerIdentityId: ident.id, provider: 'MOCK', providerRef: `mock_sd_${seq}` });
  const r = await requestPayout(db, { accountId, userId: u!.id, requestedGrossMicros: $(1000), idempotencyKey: `sd-${accountId}`, actor: SYSTEM_ACTOR });
  return { payoutId: r.id, accountId };
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m10g-${crypto.randomUUID().slice(0, 8)}`, name: 'M10G Isolated' }).returning();
  org = o!.id;
  await publishProfileVersion(db, { organizationId: org, key: KEY, name: 'SysDoc 50K', accountType: 'FUNDED_SIM', config: cfg($(50_000)) });
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('System Doctor', () => {
  it('is truthful: database HEALTHY, migrations HEALTHY, Rithmic never fake-connected', async () => {
    const r = await runSystemDoctor(db, org, true);
    const byKey = new Map(r.checks.map((c) => [c.key, c]));
    expect(byKey.get('database')!.status).toBe('HEALTHY');
    expect(byKey.get('migrations')!.status).toBe('HEALTHY');
    const rith = byKey.get('rithmic')!;
    expect(['NOT_CONFIGURED', 'NOT_VERIFIED']).toContain(rith.status); // never HEALTHY/"connected" from code alone
    expect(rith.actual.toLowerCase()).not.toContain('authenticated to');
  });

  it('persists check results that the console can read back', async () => {
    const r = await runSystemDoctor(db, org, true);
    const { systemCheckResults } = await import('../db/schema.js');
    const rows = await db.select().from(systemCheckResults).where(eq(systemCheckResults.runId, r.runId));
    expect(rows.length).toBe(r.checks.length);
  });
});

describe('Data Integrity Center', () => {
  it('a clean isolated org passes every invariant', async () => {
    const r = await runIntegrityChecks(db, org, true);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.key === 'INV_AUDIT_CHAIN_INTACT')!.status).toBe('PASS');
  });

  it('detects a PAID payout with no ledger DEBIT (corrupt fixture), then clean-up restores integrity', async () => {
    const { payoutId } = await fundedPayout();
    // Corrupt: force the request to PAID without a ledger debit (bypassing markPaid).
    await db.update(payoutRequests).set({ state: 'PAID' }).where(eq(payoutRequests.id, payoutId));
    const bad = await runIntegrityChecks(db, org, false);
    const check = bad.checks.find((c) => c.key === 'INV_PAID_PAYOUT_HAS_DEBIT')!;
    expect(check.status).toBe('FAIL');
    expect(check.sampleRefs).toContain(payoutId);
    expect(bad.ok).toBe(false);
    // Clean up so the isolated org is consistent again.
    await db.delete(payoutRequests).where(eq(payoutRequests.id, payoutId));
    const good = await runIntegrityChecks(db, org, false);
    expect(good.checks.find((c) => c.key === 'INV_PAID_PAYOUT_HAS_DEBIT')!.status).toBe('PASS');
  });

  it('detects >5 active accounts for one identity (corrupt fixture)', async () => {
    seq += 1;
    const [u] = await db.insert(users).values({ email: `sixacct-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('six-pw-1234567'), displayName: 'Six', role: 'TRADER', status: 'ACTIVE', organizationId: org }).returning();
    // Provision 5 (allowed), then clone a 6th row directly to simulate corruption.
    const first = await provisionAccount(db, { organizationId: org, userId: u!.id, profileKey: KEY });
    await db.update(accounts).set({ status: 'ACTIVE' }).where(eq(accounts.id, first.accountId));
    for (let i = 0; i < 4; i += 1) {
      const p = await provisionAccount(db, { organizationId: org, userId: u!.id, profileKey: KEY });
      await db.update(accounts).set({ status: 'ACTIVE' }).where(eq(accounts.id, p.accountId));
    }
    // 6th: bypass the active-limit by cloning a full account row (corrupt fixture).
    const [clone] = await db.select().from(accounts).where(eq(accounts.id, first.accountId));
    const cloneRow = { ...(clone as Record<string, unknown>) };
    delete cloneRow['id'];
    delete cloneRow['publicId'];
    delete cloneRow['createdAt'];
    delete cloneRow['updatedAt'];
    cloneRow['status'] = 'ACTIVE';
    await db.insert(accounts).values(cloneRow as never);
    const r = await runIntegrityChecks(db, org, false);
    const check = r.checks.find((c) => c.key === 'INV_ACTIVE_ACCOUNTS_PER_IDENTITY')!;
    expect(check.status).toBe('FAIL');
    expect(check.sampleRefs.some((s) => s.startsWith(u!.id))).toBe(true);
  });
});

describe('Reconciliation Center', () => {
  it('aggregates all systems with truthful statuses', async () => {
    const r = await reconciliationCenter(db, org);
    const names = r.systems.map((s) => s.system);
    expect(names).toContain('TRADING_PROVIDER');
    expect(names).toContain('PAYOUT_PROVIDER');
    expect(names).toContain('EXECUTION');
    expect(names).toContain('COMMERCE_PROVISIONING');
    for (const s of r.systems) expect(['HEALTHY', 'WARNING', 'CRITICAL', 'EMPTY']).toContain(s.status);
  });
});
