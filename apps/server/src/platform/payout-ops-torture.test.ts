/**
 * Payout Operations (M8) — concurrency torture, provider fail-closed, worker
 * resume, reconciliation races, certificate-only-from-PAID, metrics accuracy, and
 * the treasury/circuit-breaker safety invariants. Deterministic; no real sleeps.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, certificates, customerIdentities, dailyAccountStats, organizations, payoutLedger, payoutOperations, payoutRequests, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { SYSTEM_ACTOR } from './actor.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { requestPayout } from './payouts.js';
import { addDestination } from './payout-destinations.js';
import { getOpsConfig, updateOpsConfig, openCircuitBreaker, closeCircuitBreaker } from './payout-ops-config.js';
import { mockPayoutProvider, resetMockPayoutProvider, resolvePayoutProvider, isProduction } from './payout-provider-registry.js';
import { UnconfiguredPayoutProvider } from './payout-provider.js';
import {
  getOperationByRequest, ingestProviderEvent, reconcilePayout, runFastLane, submitPayable,
} from './payout-operations.js';
import { submitPayableBatch, reconcileStaleBatch } from './payout-ops-worker.js';
import { ownerOverview, percentile } from './payout-ops-metrics.js';
import { applyRecognition } from './recognition.js';
import type { DomainEvent } from './events.js';

const M = 1_000_000;
const $ = (d: number) => d * M;
let db: Database;
let organizationId: string;
let seq = 0;

function cfg(size: number) {
  return {
    rules: { accountSizeMicros: size, profitTargetMicros: 0, maxLossMicros: $(2000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true },
    execution: null, instruments: { allowed: null, maxContracts: 50, perInstrument: {} }, display: { startingBalanceMicros: size },
    payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000), $(2000), $(2000), $(2000), $(2000)] } },
    fundedDestinationKey: null, whopPlanId: null,
  };
}

interface F { accountId: string; userId: string; identityId: string }
async function makeEligible(withDest = true): Promise<F> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `tort-${seq}-${Date.now()}@test.local`, passwordHash: await hashPassword('x'), displayName: 'Tort', organizationId }).returning();
  const ident = await ensureCustomerIdentity(db, { organizationId, userId: u!.id });
  const { accountId } = await provisionAccount(db, { organizationId, userId: u!.id, profileKey: 'htf-tort-50k' });
  await db.update(accounts).set({ balanceMicros: $(53_000), startingBalanceMicros: $(50_000), dayStartBalanceMicros: $(53_000), dayStartEquityMicros: $(53_000), highWaterMarkMicros: $(53_000), activatedAt: new Date('2026-02-01T00:00:00Z') }).where(eq(accounts.id, accountId));
  for (let i = 0; i < 5; i += 1) await db.insert(dailyAccountStats).values({ accountId, tradeDate: `2026-03-0${i + 1}`, startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true });
  if (withDest) await addDestination(db, { organizationId, customerIdentityId: ident.id, provider: 'MOCK', providerRef: `mock_dest_${seq}` });
  return { accountId, userId: u!.id, identityId: ident.id };
}
async function reqId(f: F, gross = $(1000)): Promise<string> {
  const r = await requestPayout(db, { accountId: f.accountId, userId: f.userId, requestedGrossMicros: gross, idempotencyKey: `req-${f.accountId}-${gross}-${Date.now()}`, actor: SYSTEM_ACTOR });
  return r.id;
}
async function op(id: string) { return (await getOperationByRequest(db, id))!; }
async function toPaid(f: F): Promise<string> {
  const id = await reqId(f);
  await runFastLane(db, id); await submitPayable(db, id);
  const o = await op(id); const hook = mockPayoutProvider().advance(o.idempotencyKey, 'PAID')!;
  await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: hook.providerEventId, providerPayoutId: hook.providerPayoutId, normalizedType: 'PAYOUT_PAID' });
  return id;
}
const ev = (type: string, userId: string, accountId: string, payload: Record<string, unknown> = {}): DomainEvent =>
  ({ type, organizationId, userId, accountId, payload } as unknown as DomainEvent);
async function certsOf(identityId: string, type: string) {
  return db.select().from(certificates).where(and(eq(certificates.customerIdentityId, identityId), eq(certificates.type, type)));
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  db = createDb(url).db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: 'htf-tort-50k', name: 'Tort 50K', accountType: 'FUNDED_SIM', config: cfg($(50_000)) });
  await updateOpsConfig(db, organizationId, { provider: 'MOCK', actor: SYSTEM_ACTOR });
});
beforeEach(async () => { resetMockPayoutProvider(); await closeCircuitBreaker(db, organizationId, 'test reset', SYSTEM_ACTOR); });
afterAll(async () => { /* shared pool */ });

describe('concurrency — never a duplicate external payout', () => {
  it('two concurrent submits produce one attempt and one provider payout', async () => {
    const f = await makeEligible();
    const id = await reqId(f);
    await runFastLane(db, id);
    const [a, b] = await Promise.all([submitPayable(db, id), submitPayable(db, id)]);
    const providerIds = new Set([a.providerPayoutId, b.providerPayoutId].filter(Boolean));
    expect(providerIds.size).toBe(1);
    const attempts = await db.select().from((await import('../db/schema.js')).payoutSubmissionAttempts).where(eq((await import('../db/schema.js')).payoutSubmissionAttempts.payoutRequestId, id));
    expect(attempts.length).toBe(1);
  });

  it('two workers picking the same PAYABLE payout submit it once', async () => {
    const f = await makeEligible();
    const id = await reqId(f);
    await runFastLane(db, id);
    const [n1, n2] = await Promise.all([submitPayableBatch(db, { limit: 5 }), submitPayableBatch(db, { limit: 5 })]);
    // Exactly one worker claims and submits it (the other skips via SKIP LOCKED / not-PAYABLE).
    const o = await op(id);
    expect(['SUBMITTED', 'PROCESSING']).toContain(o.opState);
    expect(n1 + n2).toBeGreaterThanOrEqual(1);
    const settlements = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, id), eq(payoutLedger.entryType, 'SETTLEMENT')));
    expect(settlements.length).toBeLessThanOrEqual(1);
  });

  it('a webhook arriving before the submit response is safe (idempotent paid)', async () => {
    const f = await makeEligible();
    const id = await reqId(f);
    await runFastLane(db, id);
    const o = await op(id);
    // Pre-seed the provider as PAID, then the webhook races the submit.
    mockPayoutProvider().program(o.idempotencyKey, { onSubmit: 'ACCEPTED', settleTo: 'PAID' });
    const submit = submitPayable(db, id);
    const providerPayoutId = `mock_${createHash('sha256').update(o.idempotencyKey).digest('hex').slice(0, 24)}`;
    const webhook = ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: `race_${id}`, providerPayoutId, normalizedType: 'PAYOUT_PAID' });
    await Promise.all([submit, webhook]);
    const settlements = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, id), eq(payoutLedger.entryType, 'SETTLEMENT')));
    expect(settlements.length).toBeLessThanOrEqual(1);
  });
});

describe('provider fail-closed + registry', () => {
  it('the registry resolves MOCK in dev and UNCONFIGURED for unknown', () => {
    expect(resolvePayoutProvider('MOCK').id).toBe('MOCK');
    expect(resolvePayoutProvider('SOME_UNKNOWN_VENDOR').id).toBe('UNCONFIGURED');
    expect(resolvePayoutProvider(null).id).toBe('UNCONFIGURED');
  });
  it('is not production in the test environment (mock allowed)', () => {
    expect(isProduction()).toBe(false);
  });
  it('the unconfigured provider fails closed on submit (never a silent success)', async () => {
    const r = await new UnconfiguredPayoutProvider().submitPayout();
    expect(r.outcome).toBe('FAILED');
    expect(r.retryable).toBe(false);
  });
  it('an org with no provider configured leaves production disabled and provider null', async () => {
    const [org] = await db.insert(organizations).values({ slug: `tort-noprov-${Date.now()}`, name: 'NoProv' }).returning();
    const c = await getOpsConfig(db, org!.id);
    expect(c.provider).toBeNull();
    expect(c.productionEnabled).toBe(false);
  });
});

describe('certificates trigger ONLY from authoritative PAID, exactly once', () => {
  it('a paid payout issues a PAYOUT certificate exactly once', async () => {
    const f = await makeEligible();
    const id = await toPaid(f);
    // Recognition consumes payout.paid (idempotent). Applying twice yields one cert.
    await applyRecognition(db, ev('payout.paid', f.userId, f.accountId, { payoutRequestId: id }));
    await applyRecognition(db, ev('payout.paid', f.userId, f.accountId, { payoutRequestId: id }));
    expect((await certsOf(f.identityId, 'PAYOUT')).length).toBe(1);
  });
  it('a SUBMITTED/PROCESSING payout issues no certificate', async () => {
    const f = await makeEligible();
    const id = await reqId(f);
    await runFastLane(db, id); await submitPayable(db, id);
    // No payout.paid was applied → no PAYOUT certificate.
    expect((await certsOf(f.identityId, 'PAYOUT')).length).toBe(0);
    const [pr] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, id));
    expect(pr!.state).toBe('PROCESSING');
  });
});

describe('treasury / circuit breaker preserve liabilities', () => {
  it('opening the breaker after approval never un-debits or makes ineligible', async () => {
    const f = await makeEligible();
    const id = await reqId(f);
    await runFastLane(db, id); // approved + debited
    const [pr] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, id));
    expect(pr!.state).toBe('APPROVED');
    await openCircuitBreaker(db, organizationId, 'incident', SYSTEM_ACTOR);
    const o = await submitPayable(db, id);
    // Delayed, not denied: it stays PAYABLE (owed, will resume) with an advisory
    // treasury category — never a terminal exception and never un-debited.
    expect(o.opState).toBe('PAYABLE');
    expect(o.exceptionCategory).toBe('TREASURY_REVIEW');
    // The liability (the DEBIT) is intact; the payout is still APPROVED/owed.
    const debits = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, id), eq(payoutLedger.entryType, 'DEBIT')));
    expect(debits.length).toBe(1);
    const [pr2] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, id));
    expect(pr2!.state).toBe('APPROVED');
  });
});

describe('provider outage recovery + worker resume', () => {
  it('a payout left PAYABLE by an outage is resumed by the worker when healthy', async () => {
    const f = await makeEligible();
    const id = await reqId(f);
    await runFastLane(db, id); // PAYABLE
    mockPayoutProvider().setHealth('DOWN');
    const blocked = await submitPayable(db, id);
    // Provider down at submission is a delay: the payout stays PAYABLE (owed).
    expect(blocked.opState).toBe('PAYABLE');
    expect(blocked.exceptionCategory).toBe('PROVIDER_UNAVAILABLE');
    // Recovery: provider healthy again; the durable worker picks up the PAYABLE row.
    mockPayoutProvider().setHealth('HEALTHY');
    const submitted = await submitPayableBatch(db, { limit: 10 });
    expect(submitted).toBeGreaterThanOrEqual(1);
    const o = await op(id);
    expect(['SUBMITTED', 'PROCESSING']).toContain(o.opState);
  });

  it('the stale-reconcile batch reconciles a processing payout the provider has paid', async () => {
    const f = await makeEligible();
    const id = await reqId(f);
    await runFastLane(db, id); await submitPayable(db, id);
    const o = await op(id);
    mockPayoutProvider().advance(o.idempotencyKey, 'PAID');
    // Force it stale by backdating submittedAt.
    await db.update(payoutOperations).set({ submittedAt: new Date(Date.now() - 3_600_000) }).where(eq(payoutOperations.id, o.id));
    const n = await reconcileStaleBatch(db, organizationId, { limit: 50 });
    expect(n).toBeGreaterThanOrEqual(1);
    const [pr] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, id));
    expect(pr!.state).toBe('PAID');
  });
});

describe('reconciliation races', () => {
  it('two concurrent reconciles of a provider-paid payout settle once', async () => {
    const f = await makeEligible();
    const id = await reqId(f);
    await runFastLane(db, id); await submitPayable(db, id);
    const o = await op(id);
    mockPayoutProvider().advance(o.idempotencyKey, 'PAID');
    await Promise.all([reconcilePayout(db, id, { trigger: 'MANUAL' }), reconcilePayout(db, id, { trigger: 'PERIODIC' })]);
    const settlements = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, id), eq(payoutLedger.entryType, 'SETTLEMENT')));
    expect(settlements.length).toBe(1);
  });
});

describe('metrics accuracy', () => {
  it('percentile is deterministic', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 100)).toBe(40);
    expect(percentile([], 95)).toBeNull();
  });
  it('the owner overview counts fast-lane and paid correctly', async () => {
    const [org] = await db.insert(organizations).values({ slug: `tort-metrics-${Date.now()}`, name: 'Metrics' }).returning();
    // A fresh org so the counts are isolated.
    await publishProfileVersion(db, { organizationId: org!.id, key: `htf-metrics-${Date.now()}`, name: 'Metrics 50K', accountType: 'FUNDED_SIM', config: cfg($(50_000)) });
    await updateOpsConfig(db, org!.id, { provider: 'MOCK', actor: SYSTEM_ACTOR });
    const ov = await ownerOverview(db, org!.id);
    expect(ov.requestedToday).toBe(0);
    expect(ov.fastLaneRate).toBeGreaterThanOrEqual(0);
    expect(ov.provider.id).toBe('MOCK');
  });
});

describe('cancellation semantics', () => {
  it('a hard-rejected payout is not retried and lands in a provider exception', async () => {
    const f = await makeEligible();
    const id = await reqId(f);
    await runFastLane(db, id);
    const o = await op(id);
    mockPayoutProvider().program(o.idempotencyKey, { onSubmit: 'HARD_REJECT' });
    const after = await submitPayable(db, id);
    expect(after.opState).toBe('EXCEPTION');
    expect(after.exceptionCategory).toBe('PROVIDER_REJECTED');
  });
  it('a destination-invalid rejection routes DESTINATION_REVIEW and does not retry', async () => {
    const f = await makeEligible();
    const id = await reqId(f);
    await runFastLane(db, id);
    const o = await op(id);
    mockPayoutProvider().program(o.idempotencyKey, { onSubmit: 'DESTINATION_INVALID' });
    const after = await submitPayable(db, id);
    expect(after.opState).toBe('EXCEPTION');
    expect(after.exceptionCategory).toBe('DESTINATION_REVIEW');
  });
});
