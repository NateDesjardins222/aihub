/**
 * Engineering Resilience Phase 2 — Parts XVI/XVII/XXIII: payout failure durability.
 *
 * RES-P2-1: a payout debits the balance at approval. When a payout DEFINITIVELY
 * fails at the provider, the debit must be reversed (balance restored + a REVERSAL
 * ledger row) — atomically, idempotently, and with no way to double-credit. This
 * proves:
 *   - a definitive PAYOUT_FAILED restores the balance exactly and writes one REVERSAL;
 *   - the reconciliation oracle + integrity checks are clean afterwards;
 *   - a duplicate failure event never double-credits;
 *   - a crash mid-reversal rolls back completely (no partial restore, no orphan
 *     REVERSAL) and a retry then completes the reversal exactly once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import { accounts, dailyAccountStats, payoutLedger, payoutRequests, users } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { defaultOrganizationId, provisionAccount } from '../provisioning.js';
import { publishProfileVersion } from '../profiles.js';
import { SYSTEM_ACTOR } from '../actor.js';
import { ensureCustomerIdentity } from '../customer-identity.js';
import { requestPayout } from '../payouts.js';
import { addDestination } from '../payout-destinations.js';
import { updateOpsConfig, closeCircuitBreaker } from '../payout-ops-config.js';
import { mockPayoutProvider, resetMockPayoutProvider } from '../payout-provider-registry.js';
import { getOperationByRequest, ingestProviderEvent, runFastLane, submitPayable, failPayout } from '../payout-operations.js';
import { runIntegrityChecks } from './integrity-checks.js';
import { reconcileAccount } from './reconcile.js';
import { FaultInjector, FailpointError } from './failpoints.js';

const M = 1_000_000;
const $ = (d: number) => d * M;
let db: Database;
let organizationId: string;
let seq = 0;
const PROFILE = `res2-payout-${Math.random().toString(36).slice(2, 7)}`;

function cfg(size: number) {
  return {
    rules: { accountSizeMicros: size, profitTargetMicros: 0, maxLossMicros: $(2000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true },
    execution: null, instruments: { allowed: null, maxContracts: 50, perInstrument: {} }, display: { startingBalanceMicros: size },
    payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000), $(2000), $(2000), $(2000), $(2000)] } },
    fundedDestinationKey: null, whopPlanId: null,
  };
}

interface F { accountId: string; userId: string }
async function makeEligible(): Promise<F> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `res2pay-${seq}-${Date.now()}@test.local`, passwordHash: await hashPassword('x'), displayName: 'R2', organizationId }).returning();
  const ident = await ensureCustomerIdentity(db, { organizationId, userId: u!.id });
  const { accountId } = await provisionAccount(db, { organizationId, userId: u!.id, profileKey: PROFILE });
  await db.update(accounts).set({ balanceMicros: $(53_000), startingBalanceMicros: $(50_000), realizedPnlMicros: $(3_000), feesMicros: 0, dayStartBalanceMicros: $(53_000), dayStartEquityMicros: $(53_000), highWaterMarkMicros: $(53_000), activatedAt: new Date('2026-02-01T00:00:00Z') }).where(eq(accounts.id, accountId));
  for (let i = 0; i < 5; i += 1) await db.insert(dailyAccountStats).values({ accountId, tradeDate: `2026-03-0${i + 1}`, startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true });
  await addDestination(db, { organizationId, customerIdentityId: ident.id, provider: 'MOCK', providerRef: `mock_dest_${seq}` });
  return { accountId, userId: u!.id };
}

async function balanceOf(accountId: string): Promise<number> {
  const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  return a!.balanceMicros;
}
async function ledgerOf(requestId: string, entryType: string) {
  return db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, requestId), eq(payoutLedger.entryType, entryType)));
}
/**
 * Money-integrity lines only. These fixtures set realizedPnlMicros directly (a
 * funded-account shortcut with no backing executions), so the execution-derived
 * position/account-realized checks legitimately flag the shortcut; the payout
 * reversal is about the balance identity + ledger arithmetic, which use stored
 * realized and must stay exact.
 */
async function moneyLines(accountId: string) {
  const lines = await reconcileAccount(db, accountId);
  return lines.filter((l) => l.kind === 'BALANCE_IDENTITY' || l.kind === 'LEDGER_ARITHMETIC');
}

/** Approve + submit a payout to the mock provider; returns { requestId, idemKey, providerPayoutId }. */
async function approveAndSubmit(f: F, gross = $(1000)) {
  const r = await requestPayout(db, { accountId: f.accountId, userId: f.userId, requestedGrossMicros: gross, idempotencyKey: `req-${f.accountId}-${Date.now()}-${Math.random()}`, actor: SYSTEM_ACTOR });
  await runFastLane(db, r.id); // approve (debits) + PAYABLE
  await submitPayable(db, r.id); // submit to mock → op has providerPayoutId
  const o = (await getOperationByRequest(db, r.id))!;
  return { requestId: r.id, idemKey: o.idempotencyKey };
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  db = createDb(process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test').db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: PROFILE, name: 'R2 Payout 50K', accountType: 'FUNDED_SIM', config: cfg($(50_000)) });
  await updateOpsConfig(db, organizationId, { provider: 'MOCK', actor: SYSTEM_ACTOR });
});
beforeEach(async () => { resetMockPayoutProvider(); await closeCircuitBreaker(db, organizationId, 'reset', SYSTEM_ACTOR); });

describe('RES-P2-1 — a definitively failed payout reverses the debit atomically', () => {
  it('PAYOUT_FAILED restores the balance exactly and writes one REVERSAL', async () => {
    const f = await makeEligible();
    const preApprove = await balanceOf(f.accountId); // $53,000
    const { requestId, idemKey } = await approveAndSubmit(f);

    const afterDebit = await balanceOf(f.accountId);
    expect(afterDebit).toBeLessThan(preApprove); // debited
    expect(await ledgerOf(requestId, 'DEBIT')).toHaveLength(1);
    const debit = afterDebit; // balance while APPROVED/PROCESSING

    // Provider definitively fails the payout.
    const hook = mockPayoutProvider().advance(idemKey, 'FAILED')!;
    await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: hook.providerEventId, providerPayoutId: hook.providerPayoutId, normalizedType: 'PAYOUT_FAILED' });

    // Request FAILED; balance restored to the pre-approval value; exactly one REVERSAL.
    const [req] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, requestId));
    expect(req!.state).toBe('FAILED');
    expect(await balanceOf(f.accountId)).toBe(preApprove);
    const reversals = await ledgerOf(requestId, 'REVERSAL');
    expect(reversals).toHaveLength(1);
    expect(reversals[0]!.amountMicros).toBe(preApprove - debit);

    // Oracle + integrity clean; the stranded-debit detector does not fire.
    expect(await moneyLines(f.accountId)).toEqual([]);
    const findings = await runIntegrityChecks(db);
    expect(findings.find((x) => x.check === 'FAILED_PAYOUT_DEBIT_NOT_REVERSED' && x.sample.includes(requestId))).toBeUndefined();
  }, 60000);

  it('a duplicate failure event never double-credits', async () => {
    const f = await makeEligible();
    const pre = await balanceOf(f.accountId);
    const { requestId, idemKey } = await approveAndSubmit(f);
    const hook = mockPayoutProvider().advance(idemKey, 'FAILED')!;
    await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: hook.providerEventId, providerPayoutId: hook.providerPayoutId, normalizedType: 'PAYOUT_FAILED' });
    // Re-ingest the SAME event (deduped) AND re-run failPayout directly (terminal → no-op).
    await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: hook.providerEventId, providerPayoutId: hook.providerPayoutId, normalizedType: 'PAYOUT_FAILED' });
    await failPayout(db, requestId);
    expect(await balanceOf(f.accountId)).toBe(pre); // restored exactly once
    expect(await ledgerOf(requestId, 'REVERSAL')).toHaveLength(1);
  }, 60000);

  it('a crash mid-reversal rolls back completely, and a retry then reverses exactly once', async () => {
    const f = await makeEligible();
    const pre = await balanceOf(f.accountId);
    const { requestId } = await approveAndSubmit(f);
    const debited = await balanceOf(f.accountId);
    expect(debited).toBeLessThan(pre);

    // Inject a fault inside failPayout's transaction (the 2nd write: after the
    // REVERSAL insert, on the balance UPDATE). The whole transaction must roll back.
    const fx = new FaultInjector().failOnWrite(2);
    await expect(failPayout(fx.wrap(db), requestId)).rejects.toBeInstanceOf(FailpointError);

    // Nothing partial survived: balance still debited, no REVERSAL, request not FAILED.
    expect(await balanceOf(f.accountId)).toBe(debited);
    expect(await ledgerOf(requestId, 'REVERSAL')).toHaveLength(0);
    const [midReq] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, requestId));
    expect(midReq!.state === 'APPROVED' || midReq!.state === 'PROCESSING').toBe(true);

    // Retry with the real handle: reversal completes exactly once.
    await failPayout(db, requestId);
    expect(await balanceOf(f.accountId)).toBe(pre);
    expect(await ledgerOf(requestId, 'REVERSAL')).toHaveLength(1);
    const [finalReq] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, requestId));
    expect(finalReq!.state).toBe('FAILED');
    expect(await moneyLines(f.accountId)).toEqual([]);
  }, 60000);
});

afterAll(async () => { /* shared pool; fixtures are per-user */ });
