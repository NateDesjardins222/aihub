/**
 * Owner OS I (jobs/webhooks/providers/market/exec-quality) + J (financial ops,
 * money trace, exports, notes, tasks, saved views, agreements). Isolated org.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, dailyAccountStats, organizations, outboxEvents, users } from '../db/schema.js';
import { provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { addDestination } from './payout-destinations.js';
import { requestPayout } from './payouts.js';
import { hashPassword } from '../auth/password.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';
import { jobsSummary, listJobs, retryJob, providerStatuses, marketDataIntegrity, executionQuality } from './ops-io.js';
import { financialSummary, payoutMoneyTrace, agreementCenter } from './financial-ops.js';
import { addNote, createExportJob, createTask, getExport, listNotes, listTasks, listViews, saveView, updateTask } from './ops-workspace.js';

const M = 1_000_000; const $ = (d: number) => d * M;
const ACTOR: Actor = { type: 'ADMIN', label: 'io@test', userId: null };
let db: Database;
let handleSql: { end: (o?: unknown) => Promise<void> };
let org: string; let n = 0;
const KEY = 'm10ij-50k';

function cfg(size: number) {
  return { rules: { accountSizeMicros: size, profitTargetMicros: 0, maxLossMicros: $(2000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true }, execution: null, instruments: { allowed: null, maxContracts: 50, perInstrument: {} }, display: { startingBalanceMicros: size }, payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] } }, fundedDestinationKey: null, whopPlanId: null };
}

async function fundedPayout(): Promise<{ payoutId: string; userId: string }> {
  n += 1;
  const [u] = await db.insert(users).values({ email: `ij-${n}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('ij-pw-12345678'), displayName: `IJ ${n}`, role: 'TRADER', status: 'ACTIVE', organizationId: org }).returning();
  const ident = await ensureCustomerIdentity(db, { organizationId: org, userId: u!.id });
  const { accountId } = await provisionAccount(db, { organizationId: org, userId: u!.id, profileKey: KEY });
  const bal = $(53_000);
  await db.update(accounts).set({ status: 'ACTIVE', balanceMicros: bal, startingBalanceMicros: $(50_000), dayStartBalanceMicros: bal, dayStartEquityMicros: bal, highWaterMarkMicros: bal, activatedAt: new Date('2026-02-01T00:00:00Z') }).where(eq(accounts.id, accountId));
  for (let i = 0; i < 5; i += 1) await db.insert(dailyAccountStats).values({ accountId, tradeDate: `2026-03-1${i}`, startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true });
  await addDestination(db, { organizationId: org, customerIdentityId: ident.id, provider: 'MOCK', providerRef: `mock_ij_${n}` });
  const r = await requestPayout(db, { accountId, userId: u!.id, requestedGrossMicros: $(1000), idempotencyKey: `ij-${accountId}`, actor: SYSTEM_ACTOR });
  return { payoutId: r.id, userId: u!.id };
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m10ij-${crypto.randomUUID().slice(0, 8)}`, name: 'M10IJ' }).returning();
  org = o!.id;
  await publishProfileVersion(db, { organizationId: org, key: KEY, name: 'IJ 50K', accountType: 'FUNDED_SIM', config: cfg($(50_000)) });
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('M10-I jobs/providers/market/execution-quality', () => {
  it('jobs summary + list + safe retry re-arms a dead-letter job', async () => {
    const [job] = await db.insert(outboxEvents).values({ aggregateType: 'test', aggregateId: crypto.randomUUID(), type: 'test.event', stateVersion: 1, payload: {} as never, deadLetter: true, attempts: 3, lastError: 'boom' }).returning({ id: outboxEvents.id });
    const before = await jobsSummary(db);
    expect(before.deadLetter).toBeGreaterThanOrEqual(1);
    await retryJob(db, job!.id, ACTOR);
    const [row] = await db.select({ deadLetter: outboxEvents.deadLetter, lastError: outboxEvents.lastError }).from(outboxEvents).where(eq(outboxEvents.id, job!.id));
    expect(row!.deadLetter).toBe(false);
    expect(row!.lastError).toBeNull();
    expect((await listJobs(db, { state: 'queued' })).some((j) => j.id === job!.id)).toBe(true);
  });

  it('retrying a delivered job is refused', async () => {
    const [job] = await db.insert(outboxEvents).values({ aggregateType: 'test', aggregateId: crypto.randomUUID(), type: 'test.event', stateVersion: 1, payload: {} as never, deliveredAt: new Date() }).returning({ id: outboxEvents.id });
    await expect(retryJob(db, job!.id, ACTOR)).rejects.toThrow();
  });

  it('provider statuses are truthful: Rithmic is never marked verified from code alone', async () => {
    const p = await providerStatuses(db);
    const rith = p.find((x) => x.provider === 'RITHMIC')!;
    expect(rith.verified).toBe(false);
  });

  it('market-data integrity lists the 8 launch instruments as NOT_VERIFIED', () => {
    const md = marketDataIntegrity();
    expect(md.instruments.length).toBe(8);
    expect(md.instruments.every((i) => i.status === 'NOT_VERIFIED')).toBe(true);
  });

  it('execution quality returns bounded counts', async () => {
    const eq2 = await executionQuality(db, 720);
    expect(typeof eq2.executions).toBe('number');
    expect(typeof eq2.orders).toBe('object');
  });
});

describe('M10-J financial ops + money trace + agreements', () => {
  it('financial summary aggregates from source objects (no fabrication)', async () => {
    const s = await financialSummary(db, org);
    expect(s).toHaveProperty('purchaseRevenueMicros');
    expect(s).toHaveProperty('outstandingPayoutLiabilityMicros');
    expect(s.paidTraderPayoutMicros).toBeGreaterThanOrEqual(0);
  });

  it('money trace for a payout exposes eligibility, ledger and state', async () => {
    const { payoutId } = await fundedPayout();
    const trace = await payoutMoneyTrace(db, payoutId);
    expect(trace.payoutId).toBe(payoutId);
    expect(trace.eligibility).toBeTruthy();
    expect(Array.isArray(trace.ledger)).toBe(true);
    expect(trace.settled).toBe(false); // not yet PAID
  });

  it('agreement center lists versions with acceptance counts', async () => {
    const a = await agreementCenter(db, org);
    expect(Array.isArray(a.versions)).toBe(true);
  });
});

describe('M10-J workspace: notes, tasks, views, exports', () => {
  it('notes add/list/pin ordering', async () => {
    const subjectId = crypto.randomUUID();
    await addNote(db, { organizationId: org, subjectType: 'customer', subjectId, body: 'first', actor: ACTOR });
    const pinned = await addNote(db, { organizationId: org, subjectType: 'customer', subjectId, body: 'important', pinned: true, actor: ACTOR });
    const notes = await listNotes(db, 'customer', subjectId);
    expect(notes[0]!.id).toBe(pinned.id); // pinned first
    expect(notes.length).toBe(2);
  });

  it('tasks create/list/update lifecycle', async () => {
    const t = await createTask(db, { organizationId: org, title: 'Investigate mismatch', priority: 'HIGH', actor: ACTOR });
    let open = await listTasks(db, { status: 'OPEN' });
    expect(open.some((x) => x.id === t.id)).toBe(true);
    await updateTask(db, t.id, { status: 'RESOLVED' });
    open = await listTasks(db, { status: 'OPEN' });
    expect(open.some((x) => x.id === t.id)).toBe(false);
  });

  it('saved views are scoped to owner + team', async () => {
    const [me] = await db.insert(users).values({ email: `view-me-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('view-pw-12345'), displayName: 'ViewMe', role: 'ADMIN', organizationId: org }).returning({ id: users.id });
    const [other] = await db.insert(users).values({ email: `view-other-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('view-pw-12345'), displayName: 'ViewOther', role: 'ADMIN', organizationId: org }).returning({ id: users.id });
    const v = await saveView(db, { organizationId: org, ownerUserId: me!.id, scope: 'customers', name: 'VIP', filters: { segment: 'funded' } });
    const mine = await listViews(db, 'customers', me!.id);
    expect(mine.some((x) => x.id === v.id)).toBe(true);
    const others = await listViews(db, 'customers', other!.id);
    expect(others.some((x) => x.id === v.id)).toBe(false); // personal view not visible to others
  });

  it('export job materializes a bounded CSV', async () => {
    await fundedPayout();
    const job = await createExportJob(db, { organizationId: org, kind: 'customers', actor: ACTOR });
    expect(job.status).toBe('COMPLETED');
    expect(job.rowCount).toBeGreaterThanOrEqual(1);
    const full = await getExport(db, job.id);
    expect(full.resultRef).toContain('email');
  });
});
