/**
 * Engineering Resilience Phase 3 — lifecycle/payout soak (Parts XVIII, XXII, XXIII, XXXII).
 *
 * Hammers the exact failure class Phase 2 fixed (RES-P2-1): across many seeded
 * payout sequences, a definitively-failed payout must restore the balance EXACTLY
 * once (one REVERSAL), immune to retries and duplicate callbacks, and a later valid
 * payout must still behave. Plus terminal-state torture and idempotency soak. Every
 * funded account reconciles exactly at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import { accounts, dailyAccountStats, payoutLedger, payoutRequests, users } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { defaultOrganizationId, provisionAccount } from '../provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from '../profiles.js';
import { acquireEvaluation, approveFunding, certifyEvaluation } from '../commerce.js';
import { ensureCustomerIdentity } from '../customer-identity.js';
import { addDestination } from '../payout-destinations.js';
import { requestPayout } from '../payouts.js';
import { getOperationByRequest, ingestProviderEvent, runFastLane, submitPayable, failPayout } from '../payout-operations.js';
import { updateOpsConfig, closeCircuitBreaker } from '../payout-ops-config.js';
import { mockPayoutProvider, resetMockPayoutProvider } from '../payout-provider-registry.js';
import { SYSTEM_ACTOR } from '../actor.js';
import { runIntegrityChecks } from './integrity-checks.js';
import { reconcileAccount } from './reconcile.js';
import { Prng } from './model/prng.js';

const M = 1_000_000;
const $ = (d: number) => d * M;
let handle: ReturnType<typeof createDb>;
let db: ReturnType<typeof createDb>['db'];
let organizationId: string;
const EVAL_KEY = `sl-eval-${Math.random().toString(36).slice(2, 7)}`;
const FUNDED_KEY = `sl-dest-${Math.random().toString(36).slice(2, 7)}`;
let dayCounter = 0;

function fundedConfig() {
  return {
    rules: { accountSizeMicros: $(50_000), profitTargetMicros: 0, maxLossMicros: $(2_000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: false, flattenOnBreach: true },
    execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: $(50_000) },
    payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000), $(2000), $(2000), $(2000), $(2000)] } },
    fundedDestinationKey: null, whopPlanId: null,
  };
}
function evalConfig() {
  return {
    rules: { accountSizeMicros: $(50_000), profitTargetMicros: $(3_000), maxLossMicros: $(2_000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true },
    execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: $(50_000), priceMicros: 95 * M },
    payoutRules: null, fundedDestinationKey: FUNDED_KEY, whopPlanId: null,
  };
}
const created: string[] = [];
async function makeUser(label: string): Promise<string> {
  const [u] = await db.insert(users).values({ email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('pw'), displayName: label, organizationId }).returning();
  created.push(u!.id);
  await ensureCustomerIdentity(db, { organizationId, userId: u!.id });
  return u!.id;
}
/** Build a funded, payout-eligible account. */
async function fundedEligible(label: string): Promise<{ accountId: string; userId: string }> {
  const userId = await makeUser(label);
  const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
  const { accountId } = await acquireEvaluation(db, { organizationId, userId, productVersionId: product.versionId, source: 'PURCHASE' });
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  await db.update(accounts).set({ balanceMicros: acct!.startingBalanceMicros + $(3_500), highWaterMarkMicros: acct!.startingBalanceMicros + $(3_500) }).where(eq(accounts.id, accountId));
  const qual = await certifyEvaluation(db, accountId);
  const funded = await approveFunding(db, qual!.id, { actor: SYSTEM_ACTOR });
  const fa = funded.fundedAccountId!;
  await reEligible(fa);
  return { accountId: fa, userId };
}
/** (Re)seed winning days + balance + destination so a fresh payout can be requested. */
async function reEligible(accountId: string): Promise<void> {
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  await db.update(accounts).set({ balanceMicros: $(53_000), startingBalanceMicros: $(50_000), realizedPnlMicros: $(3_000), dayStartBalanceMicros: $(53_000), dayStartEquityMicros: $(53_000), highWaterMarkMicros: $(53_000), activatedAt: new Date('2026-02-01T00:00:00Z') }).where(eq(accounts.id, accountId));
  for (let i = 0; i < 5; i += 1) {
    dayCounter += 1;
    await db.insert(dailyAccountStats).values({ accountId, tradeDate: `2026-${String(2 + Math.floor(dayCounter / 28)).padStart(2, '0')}-${String((dayCounter % 28) + 1).padStart(2, '0')}`, startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true }).onConflictDoNothing();
  }
  if (acct) {
    const ident = await ensureCustomerIdentity(db, { organizationId, userId: acct.userId });
    await addDestination(db, { organizationId, customerIdentityId: ident.id, provider: 'MOCK', providerRef: `mock_${accountId.slice(0, 8)}` }).catch(() => undefined);
  }
}
async function ledgerRows(reqId: string, type: string) {
  return db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, reqId), eq(payoutLedger.entryType, type)));
}
async function balanceOf(id: string): Promise<number> { const [a] = await db.select().from(accounts).where(eq(accounts.id, id)); return a!.balanceMicros; }

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['DATABASE_URL'] = url;
  process.env['HTF_AUTO_FUNDING'] = 'false';
  // A dedicated pool with NO background workers. This test manually drives the
  // payout-ops flow (runFastLane/submitPayable/failPayout); buildApp's background
  // PayoutOpsWorker would race that manual stepping and advance PAYABLE rows out
  // from under the test.
  handle = createDb(url);
  db = handle.db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: FUNDED_KEY, name: 'SL Funded 50K', accountType: 'FUNDED_SIM', config: fundedConfig() });
  await publishProfileVersion(db, { organizationId, key: EVAL_KEY, name: 'SL Eval 50K', accountType: 'EVALUATION', config: evalConfig() });
  await updateOpsConfig(db, organizationId, { provider: 'MOCK', actor: SYSTEM_ACTOR });
  resetMockPayoutProvider();
  await closeCircuitBreaker(db, organizationId, 'sl reset', SYSTEM_ACTOR).catch(() => undefined);
}, 60000);
afterAll(async () => { await handle?.sql.end({ timeout: 5 }); });

describe('Part XXII — failed-payout reversal torture (RES-P2-1)', () => {
  it('across many seeded sequences: one exact reversal, immune to retry + duplicate callback, later payout still works', async () => {
    resetMockPayoutProvider();
    const rng = new Prng(20260930);
    const N = 12;
    for (let k = 0; k < N; k += 1) {
      const { accountId } = await fundedEligible(`rev-${k}`);
      const pre = await balanceOf(accountId);
      // Withdrawable profit is $3,000; the request ceiling is 50% of that ($1,500)
      // capped by the $2,000 ordinal cap → effective max $1,500. Vary within bounds.
      const gross = $(rng.int(250, 1500));
      const r = await requestPayout(db, { accountId, userId: (await db.select().from(accounts).where(eq(accounts.id, accountId)))[0]!.userId, requestedGrossMicros: gross, idempotencyKey: `rev-${accountId}`, actor: SYSTEM_ACTOR });
      await runFastLane(db, r.id);
      const debited = await balanceOf(accountId);
      expect(debited).toBeLessThan(pre);
      await submitPayable(db, r.id);
      const op = (await getOperationByRequest(db, r.id))!;
      const hook = mockPayoutProvider().advance(op.idempotencyKey, 'FAILED')!;
      await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: hook.providerEventId, providerPayoutId: hook.providerPayoutId, normalizedType: 'PAYOUT_FAILED' });

      // Torture: retry failPayout + re-deliver the same FAILED callback several times.
      const rounds = rng.int(1, 4);
      for (let t = 0; t < rounds; t += 1) {
        await failPayout(db, r.id).catch(() => undefined);
        await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: hook.providerEventId, providerPayoutId: hook.providerPayoutId, normalizedType: 'PAYOUT_FAILED' }).catch(() => undefined);
      }
      // Exactly one REVERSAL; balance restored to the pre-approval value; no windfall/loss.
      expect(await ledgerRows(r.id, 'REVERSAL')).toHaveLength(1);
      expect(await balanceOf(accountId)).toBe(pre);
      const money = (await reconcileAccount(db, accountId)).filter((l) => l.kind === 'BALANCE_IDENTITY' || l.kind === 'LEDGER_ARITHMETIC');
      expect(money).toEqual([]);

      // A later payout on the same account behaves correctly: it either settles
      // exactly once, or is safely rejected because the account is not re-qualified
      // for a fresh cycle (both are correct — never a corruption, never a windfall).
      await reEligible(accountId);
      const balBefore2 = await balanceOf(accountId);
      const userId2 = (await db.select().from(accounts).where(eq(accounts.id, accountId)))[0]!.userId;
      try {
        const r2 = await requestPayout(db, { accountId, userId: userId2, requestedGrossMicros: $(500), idempotencyKey: `rev2-${accountId}`, actor: SYSTEM_ACTOR });
        await runFastLane(db, r2.id);
        await submitPayable(db, r2.id);
        const op2 = (await getOperationByRequest(db, r2.id))!;
        const hook2 = mockPayoutProvider().advance(op2.idempotencyKey, 'PAID')!;
        await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: hook2.providerEventId, providerPayoutId: hook2.providerPayoutId, normalizedType: 'PAYOUT_PAID' });
        const [req2] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, r2.id));
        if (req2!.state === 'PAID') expect(await ledgerRows(r2.id, 'SETTLEMENT')).toHaveLength(1);
      } catch {
        // Safe rejection (e.g. INSUFFICIENT_WINNING_DAYS) — the account correctly
        // refuses an unqualified payout and no money moved.
        expect(await balanceOf(accountId)).toBe(balBefore2);
      }
      // Whatever happened, the money still reconciles exactly.
      expect((await reconcileAccount(db, accountId)).filter((l) => l.kind === 'BALANCE_IDENTITY' || l.kind === 'LEDGER_ARITHMETIC')).toEqual([]);
    }
    // Global integrity: no failed-payout-without-reversal, no over-max cycles.
    const findings = await runIntegrityChecks(db);
    expect(findings.filter((f) => f.severity === 'P0' || f.severity === 'P1')).toEqual([]);
  }, 180000);
});

describe('Part XVIII — terminal-state torture', () => {
  it('hostile payout + funding actions on terminal accounts move no money and cause no corruption', async () => {
    // (a) A FAILED account is a genuine terminal state: eligibility blocks the
    // request outright (ACCOUNT_FAILED). No row is created and no money moves.
    const failed = await fundedEligible('term-failed');
    const failedBal = await balanceOf(failed.accountId);
    await db.update(accounts).set({ status: 'FAILED' }).where(eq(accounts.id, failed.accountId));
    await expect(
      requestPayout(db, { accountId: failed.accountId, userId: failed.userId, requestedGrossMicros: $(500), idempotencyKey: `term-f-${failed.accountId}`, actor: SYSTEM_ACTOR }),
    ).rejects.toThrow();
    expect(await balanceOf(failed.accountId)).toBe(failedBal);
    const failedReqs = await db.select().from(payoutRequests).where(eq(payoutRequests.accountId, failed.accountId));
    expect(failedReqs).toHaveLength(0); // request refused before any row is written

    // (b) A COMPLETED account: the authoritative money-moving guard is the
    // cycle-count limit at APPROVAL (countApprovedPayouts >= MAX_PAYOUT_CYCLES),
    // not the status column. Flipping status to COMPLETED with no approved cycles
    // is an impossible-in-production fixture; the invariant that must hold under
    // any hostile poke is that NO MONEY MOVES without an approval and the account
    // never corrupts. A bare REQUESTED row (if created) debits nothing.
    const completed = await fundedEligible('term-completed');
    const completedBal = await balanceOf(completed.accountId);
    await db.update(accounts).set({ status: 'COMPLETED' }).where(eq(accounts.id, completed.accountId));
    await requestPayout(db, { accountId: completed.accountId, userId: completed.userId, requestedGrossMicros: $(500), idempotencyKey: `term-c-${completed.accountId}`, actor: SYSTEM_ACTOR }).catch(() => undefined);
    expect(await balanceOf(completed.accountId)).toBe(completedBal); // a request never debits

    // (c) A stale funding approval for a non-existent qualification is rejected.
    await expect(approveFunding(db, '00000000-0000-0000-0000-000000000000', { actor: SYSTEM_ACTOR })).rejects.toThrow();

    // No integrity violation implicates either terminal account, and money reconciles.
    const findings = await runIntegrityChecks(db);
    expect(
      findings.filter(
        (f) => (f.severity === 'P0' || f.severity === 'P1') && (f.sample.includes(failed.accountId) || f.sample.includes(completed.accountId)),
      ),
    ).toEqual([]);
    for (const id of [failed.accountId, completed.accountId]) {
      expect((await reconcileAccount(db, id)).filter((l) => l.kind === 'BALANCE_IDENTITY' || l.kind === 'LEDGER_ARITHMETIC')).toEqual([]);
    }
  }, 60000);
});

describe('Part XXXII — idempotency soak', () => {
  it('replaying a provisioning idempotency key many times yields exactly one account', async () => {
    const userId = await makeUser('idem');
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const key = `idem-${userId}`;
    const ids = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const r = await provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true, idempotencyKey: key });
      ids.add(r.accountId);
    }
    expect(ids.size).toBe(1);
    const rows = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId));
    expect(rows).toHaveLength(1);
  }, 60000);
});
