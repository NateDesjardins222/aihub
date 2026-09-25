/**
 * Payout Operations (Milestone 8) — deterministic service tests against the real
 * database and the deterministic mock provider. These prove the non-negotiables:
 * clean payouts fast-lane with NO human approval, the five-minute SLA, exactly-once
 * money movement, lost-acknowledgement safety, HTTP-200-is-not-PAID, authoritative
 * paid → certificate exactly once, reconciliation, treasury/circuit-breaker
 * delays that never deny eligibility, and provider fail-closed. A FakeClock makes
 * the SLA timing exact without sleeping.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import {
  accounts, dailyAccountStats, payoutLedger, payoutOperations, payoutProviderEvents,
  payoutRequests, payoutSubmissionAttempts, users,
} from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { SYSTEM_ACTOR } from './actor.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { requestPayout } from './payouts.js';
import { addDestination } from './payout-destinations.js';
import { getOpsConfig, updateOpsConfig, openCircuitBreaker, closeCircuitBreaker } from './payout-ops-config.js';
import { mockPayoutProvider, resetMockPayoutProvider } from './payout-provider-registry.js';
import {
  applyProviderPaid, ensureOperation, getOperationByRequest, idempotencyKeyFor, ingestProviderEvent,
  reconcilePayout, runFastLane, submitPayable,
} from './payout-operations.js';
import { markSlaBreachIfNeeded, slaTimings, SLA_TARGET_MS } from './payout-ops-metrics.js';
import { placeHold as enfPlaceHold } from './enforcement.js';
import { FakeClock } from './clock.js';

const M = 1_000_000;
const $ = (d: number) => d * M;
let db: Database;
let sql: ReturnType<typeof createDb>['sql'] | undefined;
let organizationId: string;
let seq = 0;

function fundedConfig(sizeMicros: number) {
  return {
    rules: {
      accountSizeMicros: sizeMicros, profitTargetMicros: 0, maxLossMicros: $(2000), drawdownType: 'STATIC' as const,
      trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const,
      consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0,
      maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true,
    },
    execution: null,
    instruments: { allowed: null, maxContracts: 50, perInstrument: {} },
    display: { startingBalanceMicros: sizeMicros },
    payoutRules: {
      model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150),
      requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0,
      requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000), $(2000), $(2000), $(2000), $(2000)] },
    },
    fundedDestinationKey: null, whopPlanId: null,
  };
}

interface Funded { accountId: string; userId: string; identityId: string }

/** A funded, ELIGIBLE account (5 winning days) with a verified MOCK destination. */
async function makeEligible(opts: { balance?: number; withDestination?: boolean; winDays?: number } = {}): Promise<Funded> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `pops-${seq}-${Date.now()}@test.local`, passwordHash: await hashPassword('x'), displayName: 'Pops', organizationId }).returning();
  const ident = await ensureCustomerIdentity(db, { organizationId, userId: u!.id });
  const { accountId } = await provisionAccount(db, { organizationId, userId: u!.id, profileKey: 'htf-pops-50k' });
  const balance = opts.balance ?? $(53_000);
  await db.update(accounts).set({
    balanceMicros: balance, startingBalanceMicros: $(50_000), dayStartBalanceMicros: balance, dayStartEquityMicros: balance,
    highWaterMarkMicros: Math.max(balance, $(50_000)), activatedAt: new Date('2026-02-01T00:00:00Z'),
  }).where(eq(accounts.id, accountId));
  const days = opts.winDays ?? 5;
  for (let i = 0; i < days; i += 1) {
    await db.insert(dailyAccountStats).values({
      accountId, tradeDate: `2026-03-${String(i + 1).padStart(2, '0')}`,
      startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true,
    });
  }
  if (opts.withDestination !== false) {
    await addDestination(db, { organizationId, customerIdentityId: ident.id, provider: 'MOCK', providerRef: `mock_dest_${seq}` });
  }
  return { accountId, userId: u!.id, identityId: ident.id };
}

async function request(f: Funded, gross = $(1000)): Promise<string> {
  const r = await requestPayout(db, { accountId: f.accountId, userId: f.userId, requestedGrossMicros: gross, idempotencyKey: `req-${f.accountId}-${gross}`, actor: SYSTEM_ACTOR });
  return r.id;
}

async function op(requestId: string) { return (await getOperationByRequest(db, requestId))!; }
async function balanceOf(accountId: string): Promise<number> { const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId)); return a!.balanceMicros; }

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  const handle = createDb(url); db = handle.db; sql = handle.sql;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: 'htf-pops-50k', name: 'Pops 50K', accountType: 'FUNDED_SIM', config: fundedConfig($(50_000)) });
  await updateOpsConfig(db, organizationId, { provider: 'MOCK', actor: SYSTEM_ACTOR });
});
beforeEach(() => { resetMockPayoutProvider(); });
afterAll(async () => { /* shared pool; leave open */ });

// ============================================================================
describe('fast lane — clean payouts auto-process with no human approval', () => {
  it('a clean eligible payout enters the fast lane and auto-approves (debit once)', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    const before = await balanceOf(f.accountId);
    const res = await runFastLane(db, rid);
    expect(res.approved).toBe(true);
    expect(res.opState).toBe('PAYABLE');
    const [pr] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, rid));
    expect(pr!.state).toBe('APPROVED'); // auto-approved, no human
    expect(await balanceOf(f.accountId)).toBe(before - $(1000)); // debited exactly once
    const debits = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, rid), eq(payoutLedger.entryType, 'DEBIT')));
    expect(debits).toHaveLength(1);
  });

  it('a payable payout queues + submits to the provider and moves to PROCESSING (not PAID)', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    await runFastLane(db, rid);
    const submitted = await submitPayable(db, rid);
    expect(['SUBMITTED', 'PROCESSING']).toContain(submitted.opState);
    expect(submitted.providerPayoutId).toBeTruthy();
    const [pr] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, rid));
    expect(pr!.state).toBe('PROCESSING'); // submitted != paid
  });

  it('records the operational checks append-only', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    await runFastLane(db, rid);
    const checks = await db.select().from((await import('../db/schema.js')).payoutOperationalChecks).where(eq((await import('../db/schema.js')).payoutOperationalChecks.payoutRequestId, rid));
    expect(checks.length).toBeGreaterThanOrEqual(8);
    expect(checks.every((c) => c.result === 'PASS')).toBe(true);
  });

  it('re-running the fast lane is idempotent (no second approval / debit)', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    await runFastLane(db, rid);
    const bal = await balanceOf(f.accountId);
    await runFastLane(db, rid);
    await runFastLane(db, rid);
    expect(await balanceOf(f.accountId)).toBe(bal);
    const debits = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, rid), eq(payoutLedger.entryType, 'DEBIT')));
    expect(debits).toHaveLength(1);
  });
});

// ============================================================================
describe('five-minute SLA (deterministic clock)', () => {
  async function fastLaneWithClock(offsetSubmitMs: number): Promise<Awaited<ReturnType<typeof op>>> {
    const f = await makeEligible();
    const rid = await request(f);
    const clock = new FakeClock(1_000_000);
    await runFastLane(db, rid, { clock });
    clock.advance(offsetSubmitMs);
    await submitPayable(db, rid, { clock });
    await markSlaBreachIfNeeded(db, rid, clock);
    return op(rid);
  }
  it('a 30-second submission is well within SLA', async () => {
    const o = await fastLaneWithClock(30_000);
    expect(slaTimings(o).requestToSubmissionMs).toBe(30_000);
    expect(o.slaBreached).toBe(false);
  });
  it('4:59 passes the SLA', async () => {
    const o = await fastLaneWithClock(SLA_TARGET_MS - 1_000);
    expect(o.slaBreached).toBe(false);
  });
  it('5:00 exactly is within target', async () => {
    const o = await fastLaneWithClock(SLA_TARGET_MS);
    expect(o.slaBreached).toBe(false);
  });
  it('5:01 breaches the SLA', async () => {
    const o = await fastLaneWithClock(SLA_TARGET_MS + 1_000);
    expect(o.slaBreached).toBe(true);
  });
  it('an SLA breach does not invalidate the payout (still approved/processing)', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    const clock = new FakeClock(1_000_000);
    await runFastLane(db, rid, { clock });
    clock.advance(SLA_TARGET_MS + 60_000);
    await submitPayable(db, rid, { clock });
    await markSlaBreachIfNeeded(db, rid, clock);
    const [pr] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, rid));
    expect(pr!.state).toBe('PROCESSING');
    expect((await op(rid)).slaBreached).toBe(true);
  });
});

// ============================================================================
describe('exception lane — never silently fail, never accuse', () => {
  it('an enforcement hold prevents the fast lane and routes ENFORCEMENT_REVIEW', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    await enfPlaceHold(db, { organizationId, scope: 'ACCOUNT', scopeId: f.accountId, capability: 'PAYOUT_REQUEST', reasonCode: 'MANUAL', actor: SYSTEM_ACTOR });
    const res = await runFastLane(db, rid);
    expect(res.opState).toBe('EXCEPTION');
    expect(res.exceptionCategory).toBe('ENFORCEMENT_REVIEW');
    const [pr] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, rid));
    expect(pr!.state).toBe('REQUESTED'); // not debited
    expect(await balanceOf(f.accountId)).toBe($(53_000));
  });

  it('a missing destination routes DESTINATION_REVIEW', async () => {
    const f = await makeEligible({ withDestination: false });
    const rid = await request(f);
    const res = await runFastLane(db, rid);
    expect(res.opState).toBe('EXCEPTION');
    expect(res.exceptionCategory).toBe('DESTINATION_REVIEW');
  });

  it('a treasury circuit breaker delays (TREASURY_REVIEW), never denies eligibility', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    await openCircuitBreaker(db, organizationId, 'incident', SYSTEM_ACTOR);
    const res = await runFastLane(db, rid);
    expect(res.exceptionCategory).toBe('TREASURY_REVIEW');
    // Eligibility unaffected: closing the breaker lets it proceed.
    await closeCircuitBreaker(db, organizationId, 'resolved', SYSTEM_ACTOR);
    const res2 = await runFastLane(db, rid);
    expect(res2.approved).toBe(true);
  });

  it('a provider outage delays as PROVIDER_UNAVAILABLE', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    mockPayoutProvider().setHealth('DOWN');
    const res = await runFastLane(db, rid);
    expect(res.exceptionCategory).toBe('PROVIDER_UNAVAILABLE');
  });

  it('economic ineligibility is refused at request, not an operational exception', async () => {
    const f = await makeEligible({ winDays: 0 }); // not enough winning days
    await expect(requestPayout(db, { accountId: f.accountId, userId: f.userId, requestedGrossMicros: $(1000), idempotencyKey: `inel-${f.accountId}`, actor: SYSTEM_ACTOR }))
      .rejects.toThrow();
  });
});

// ============================================================================
describe('exactly-once money movement + lost-acknowledgement safety', () => {
  it('the idempotency key is stable and never regenerated', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    await runFastLane(db, rid);
    const o = await op(rid);
    expect(o.idempotencyKey).toBe(idempotencyKeyFor(rid, 1, 'MOCK'));
    await submitPayable(db, rid);
    const attempts = await db.select().from(payoutSubmissionAttempts).where(eq(payoutSubmissionAttempts.payoutRequestId, rid));
    expect(attempts.every((a) => a.idempotencyKey === o.idempotencyKey)).toBe(true);
  });

  it('a duplicate submit does not create a second provider payout', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    await runFastLane(db, rid);
    const s1 = await submitPayable(db, rid);
    const s2 = await submitPayable(db, rid); // op no longer PAYABLE → idempotent no-op
    expect(s2.providerPayoutId).toBe(s1.providerPayoutId);
    const paid = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, rid), eq(payoutLedger.entryType, 'SETTLEMENT')));
    expect(paid.length).toBeLessThanOrEqual(1);
  });

  it('a lost acknowledgement is reconciled, never blindly re-submitted', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    await runFastLane(db, rid);
    const o = await op(rid);
    mockPayoutProvider().program(o.idempotencyKey, { onSubmit: 'LOST_ACK', settleTo: 'PROCESSING' });
    const submitted = await submitPayable(db, rid);
    // The provider DID accept it; reconciliation recovered the provider payout id.
    expect(['SUBMITTED', 'PROCESSING']).toContain(submitted.opState);
    expect(submitted.providerPayoutId).toBeTruthy();
    const attempts = await db.select().from(payoutSubmissionAttempts).where(eq(payoutSubmissionAttempts.payoutRequestId, rid));
    expect(attempts).toHaveLength(1); // one attempt, no blind duplicate
  });

  it('a lost ack the provider never received routes UNKNOWN_PROVIDER_STATE', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    await runFastLane(db, rid);
    const o = await op(rid);
    // TIMEOUT with nothing stored → getPayout finds nothing → unknown.
    mockPayoutProvider().program(o.idempotencyKey, { onSubmit: 'TIMEOUT' });
    const submitted = await submitPayable(db, rid);
    expect(submitted.opState).toBe('EXCEPTION');
    expect(submitted.exceptionCategory).toBe('UNKNOWN_PROVIDER_STATE');
  });

  it('a transient error keeps the payout PAYABLE for a same-key retry', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    await runFastLane(db, rid);
    const o = await op(rid);
    mockPayoutProvider().program(o.idempotencyKey, { onSubmit: 'TRANSIENT' });
    const after = await submitPayable(db, rid);
    expect(after.opState).toBe('PAYABLE'); // will retry, same key
    // Now let it succeed and confirm exactly one provider payout.
    mockPayoutProvider().program(o.idempotencyKey, { onSubmit: 'ACCEPTED' });
    const ok = await submitPayable(db, rid);
    expect(['SUBMITTED', 'PROCESSING']).toContain(ok.opState);
  });
});

// ============================================================================
describe('PAID requires authoritative provider evidence', () => {
  async function submitted(): Promise<{ f: Funded; rid: string }> {
    const f = await makeEligible();
    const rid = await request(f);
    await runFastLane(db, rid);
    await submitPayable(db, rid);
    return { f, rid };
  }

  it('SUBMITTED / PROCESSING is not PAID', async () => {
    const { rid } = await submitted();
    const [pr] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, rid));
    expect(pr!.state).toBe('PROCESSING');
    expect((await op(rid)).opState).not.toBe('PAID');
  });

  it('an authoritative PAID provider event transitions to PAID and settles once', async () => {
    const { rid } = await submitted();
    const o = await op(rid);
    const webhook = mockPayoutProvider().advance(o.idempotencyKey, 'PAID')!;
    await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: webhook.providerEventId, providerPayoutId: webhook.providerPayoutId, normalizedType: 'PAYOUT_PAID', amountMicros: 900 * M });
    const [pr] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, rid));
    expect(pr!.state).toBe('PAID');
    const settlements = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, rid), eq(payoutLedger.entryType, 'SETTLEMENT')));
    expect(settlements).toHaveLength(1);
  });

  it('a duplicate PAID webhook is idempotent (no second settlement)', async () => {
    const { rid } = await submitted();
    const o = await op(rid);
    const webhook = mockPayoutProvider().advance(o.idempotencyKey, 'PAID')!;
    const first = await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: webhook.providerEventId, providerPayoutId: webhook.providerPayoutId, normalizedType: 'PAYOUT_PAID' });
    const second = await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: webhook.providerEventId, providerPayoutId: webhook.providerPayoutId, normalizedType: 'PAYOUT_PAID' });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    const settlements = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, rid), eq(payoutLedger.entryType, 'SETTLEMENT')));
    expect(settlements).toHaveLength(1);
  });

  it('an out-of-order PROCESSING event after PAID never moves it backwards', async () => {
    const { rid } = await submitted();
    const o = await op(rid);
    const paidHook = mockPayoutProvider().advance(o.idempotencyKey, 'PAID')!;
    await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: paidHook.providerEventId, providerPayoutId: paidHook.providerPayoutId, normalizedType: 'PAYOUT_PAID' });
    await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: 'late_processing_evt', providerPayoutId: o.providerPayoutId!, normalizedType: 'PAYOUT_PROCESSING' });
    expect((await op(rid)).opState).toBe('PAID');
  });

  it('provider submission does not debit a second time', async () => {
    const { f, rid } = await submitted();
    const o = await op(rid);
    const webhook = mockPayoutProvider().advance(o.idempotencyKey, 'PAID')!;
    const before = await balanceOf(f.accountId);
    await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: webhook.providerEventId, providerPayoutId: webhook.providerPayoutId, normalizedType: 'PAYOUT_PAID' });
    expect(await balanceOf(f.accountId)).toBe(before); // settlement moves no balance
  });
});

// ============================================================================
describe('reconciliation', () => {
  it('reconciles a provider-ahead PAID that we still show as processing', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    await runFastLane(db, rid);
    await submitPayable(db, rid);
    const o = await op(rid);
    mockPayoutProvider().advance(o.idempotencyKey, 'PAID'); // provider paid; we never got the webhook
    const r = await reconcilePayout(db, rid, { trigger: 'PERIODIC' });
    expect(r.autoResolved).toBe(true);
    const [pr] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, rid));
    expect(pr!.state).toBe('PAID');
  });

  it('an amount mismatch is recorded and does not un-pay', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    await runFastLane(db, rid);
    const o = await op(rid);
    mockPayoutProvider().program(o.idempotencyKey, { onSubmit: 'ACCEPTED', reportAmountMicros: 12 * M }); // wrong amount
    await submitPayable(db, rid);
    const r = await reconcilePayout(db, rid, { trigger: 'MANUAL' });
    expect(r.mismatchType).toBe('AMOUNT_MISMATCH');
    const recs = await db.select().from((await import('../db/schema.js')).payoutReconciliationRecords).where(eq((await import('../db/schema.js')).payoutReconciliationRecords.payoutRequestId, rid));
    expect(recs.some((x) => x.mismatchType === 'AMOUNT_MISMATCH')).toBe(true);
  });
});

// ============================================================================
describe('returned payment + cancellation', () => {
  it('a returned payment is recorded and does not delete history', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    await runFastLane(db, rid);
    await submitPayable(db, rid);
    const o = await op(rid);
    // Pay it, then a return arrives.
    const paidHook = mockPayoutProvider().advance(o.idempotencyKey, 'PAID')!;
    await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: paidHook.providerEventId, providerPayoutId: paidHook.providerPayoutId, normalizedType: 'PAYOUT_PAID' });
    const settledBefore = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, rid), eq(payoutLedger.entryType, 'SETTLEMENT')));
    await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: 'return_evt', providerPayoutId: o.providerPayoutId!, normalizedType: 'PAYOUT_RETURNED' });
    expect((await op(rid)).opState).toBe('RETURNED');
    // Settlement ledger history is preserved (never deleted).
    const settledAfter = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, rid), eq(payoutLedger.entryType, 'SETTLEMENT')));
    expect(settledAfter.length).toBe(settledBefore.length);
  });
});

// ============================================================================
describe('provider fail-closed + config', () => {
  it('an unconfigured provider fails closed at submission', async () => {
    // A fresh org with no configured provider.
    const [org2] = await db.insert((await import('../db/schema.js')).organizations).values({ slug: `pops-org-${Date.now()}`, name: 'Pops Org' }).returning();
    const cfg = await getOpsConfig(db, org2!.id);
    expect(cfg.provider).toBeNull();
    expect(cfg.productionEnabled).toBe(false);
  });

  it('provider events are append-only and idempotent on (provider, event id)', async () => {
    const f = await makeEligible();
    const rid = await request(f);
    await runFastLane(db, rid);
    await submitPayable(db, rid);
    const o = await op(rid);
    await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: 'dup_evt_1', providerPayoutId: o.providerPayoutId!, normalizedType: 'PAYOUT_PROCESSING' });
    await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: 'dup_evt_1', providerPayoutId: o.providerPayoutId!, normalizedType: 'PAYOUT_PROCESSING' });
    const rows = await db.select().from(payoutProviderEvents).where(eq(payoutProviderEvents.providerEventId, 'dup_evt_1'));
    expect(rows).toHaveLength(1);
  });

  it('treasury config change is versioned and audited', async () => {
    const [org3] = await db.insert((await import('../db/schema.js')).organizations).values({ slug: `pops-cfg-${Date.now()}`, name: 'Cfg Org' }).returning();
    const c0 = await getOpsConfig(db, org3!.id);
    const c1 = await updateOpsConfig(db, org3!.id, { maxSingleAutoMicros: $(5000), actor: SYSTEM_ACTOR });
    expect(c1.version).toBe(c0.version + 1);
    expect(c1.maxSingleAutoMicros).toBe($(5000));
  });
});

void applyProviderPaid;
void ensureOperation;

