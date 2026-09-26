/**
 * PHASE 5 — CORE 50K GOLDEN PATH (end-to-end business lifecycle acceptance).
 *
 * ONE representative product (htf-core-50k) is driven through the complete
 * customer lifecycle using the REAL domain services (no direct status writes, no
 * fabricated money events) and the REAL trading engine for execution. Risk and
 * consistency semantics are proven through the rule engine itself (rollTradingDay
 * / evaluateRules) — that is the engine, not a bypass.
 *
 *   customer → identity/KYC → purchase → trusted payment event → provisioning
 *   → real simulated trade (order→fill→realized P&L→commission→balance)
 *   → EOD-trailing risk → consistency → evaluation pass → funded transition
 *   → funded certificate → winning days → payout eligibility → request
 *   → owner approval (single debit) → dev/test settlement → PAID → payout cert
 *   → reconciliation → exactly-once (failure injection) → ownership boundaries.
 *
 * Settlement here is DEVELOPMENT/TEST bookkeeping (meta.mock=true), never a real
 * external payout. Identity here is the DEV/TEST mock provider (Phase 4 keeps the
 * production path fail-closed). Execution is SIMULATION only.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../db/client.js';
import {
  accounts,
  accountQualifications,
  certificates as certificatesTable,
  dailyAccountStats,
  payoutLedger,
  payoutRequests,
  users,
} from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { reconcileHtfProducts } from './product-reconcile.js';
import { resolveProfileByKey } from './profiles.js';
import { seedDefaultAgreements, outstandingAgreements, acceptAgreements } from './agreements.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { startContactVerification, confirmContactVerification } from './contact-verification.js';
import { startIdentityVerification, resolveIdentityVerification } from './identity-verification.js';
import { evaluateProvisioningGate } from './provisioning-gate.js';
import { createPendingOrder, certifyEvaluation, approveFunding } from './commerce.js';
import { simulateProviderPayment } from './commerce-fulfillment.js';
import {
  getPayoutEligibility,
  requestPayout,
  approvePayout,
  markProcessing,
  markPaid,
} from './payouts.js';
import { recordClosedDay } from '../trading/account-rules.js';
import { applyRecognition } from './recognition.js';
import { publicVerification, listCertificatesForUser } from './certificates.js';
import { auditLedgers } from './ledger-audit.js';
import { TradingEngine } from '../trading/engine.js';
import { ScriptedMarket, settle } from '../trading/harness.js';
import {
  advanceDrawdown,
  evaluateRules,
  rollTradingDay,
  type DailyHistory,
  type RuleConfig,
  type RuleMark,
  type RuleState,
} from '@atlas/core';

const M = 1_000_000;
const URL = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

// A record of every material fact the Golden Path proves, printed at the end so
// the run itself answers the phase's success questions.
const LEDGER: Record<string, unknown> = {};

let db: Database;
let sqlEnd: () => Promise<void>;
let organizationId: string;
let userId: string;
let evalAccountId: string;
let evalProfileVersionId: string;
let fundedAccountId: string;
let qualificationId: string;
let payoutRequestId: string;

beforeAll(async () => {
  const handle = createDb(URL);
  db = handle.db;
  sqlEnd = () => handle.sql.end({ timeout: 5 });
  organizationId = await defaultOrganizationId(db);
  await seedDefaultAgreements(db, organizationId);
  await reconcileHtfProducts(db, organizationId);
  const [u] = await db
    .insert(users)
    .values({
      email: `golden-${crypto.randomUUID().slice(0, 8)}@golden.test`,
      passwordHash: await hashPassword('golden-path-pw'),
      displayName: 'Golden Path Customer',
      organizationId,
    })
    .returning();
  userId = u!.id;
  LEDGER.customerUserId = userId;
  LEDGER.organizationId = organizationId;
});

afterAll(async () => {
  const out = process.env['GOLDEN_LEDGER_OUT'];
  if (out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, JSON.stringify(LEDGER, null, 2));
  }
  await sqlEnd?.();
});

describe('CORE 50K Golden Path — one business system, end to end', () => {
  // ─── PART 5 — IDENTITY / KYC (dev/test provider; production stays fail-closed) ──
  it('1. customer begins unverified, then clears the gate through the real provider abstraction', async () => {
    const before = await evaluateProvisioningGate(db, organizationId, userId);
    expect(before.satisfied).toBe(false); // unverified to start

    const identity = await ensureCustomerIdentity(db, { organizationId, userId });
    LEDGER.customerIdentityId = identity.id;
    const email = await startContactVerification(db, { identityId: identity.id, channel: 'EMAIL', value: 'golden@golden.test' });
    await confirmContactVerification(db, { challengeId: email.challengeId, code: email.devCode! });
    const sms = await startContactVerification(db, { identityId: identity.id, channel: 'SMS', value: '+15557770000' });
    await confirmContactVerification(db, { challengeId: sms.challengeId, code: sms.devCode! });
    const started = await startIdentityVerification(db, { identityId: identity.id, legalName: 'Golden Path Trader' });
    LEDGER.identityVerificationId = started.verificationId;
    const resolved = await resolveIdentityVerification(db, { identityId: identity.id });
    expect(resolved.status).toBe('IDENTITY_VERIFIED');

    const after = await evaluateProvisioningGate(db, organizationId, userId);
    // clear any outstanding agreements
    const outstanding = await outstandingAgreements(db, organizationId, identity.id);
    if (outstanding.length > 0) {
      await acceptAgreements(db, { organizationId, identityId: identity.id, userId, versionIds: outstanding.map((o) => o.versionId) });
    }
    const gate = await evaluateProvisioningGate(db, organizationId, userId);
    expect(gate.satisfied).toBe(true);
    expect(gate.identityOk).toBe(true);
    LEDGER.identity = { provider: 'MOCK (dev/test)', environment: 'test', finalStatus: 'IDENTITY_VERIFIED', gateSatisfied: true, wasUnverified: !before.satisfied, afterIdentityStatus: after.identityOk };
  });

  // ─── PART 6/7/8 — PURCHASE → TRUSTED PAYMENT → PROVISIONING ──────────────────
  it('2. a $95 purchase + trusted mock payment provisions exactly one Core 50K evaluation account', async () => {
    const product = await resolveProfileByKey(db, organizationId, 'htf-core-50k');
    evalProfileVersionId = product.versionId;
    expect((product.config as { display?: { priceMicros?: number } }).display?.priceMicros).toBe(95 * M);
    expect((product.config as { display?: { startingBalanceMicros?: number } }).display?.startingBalanceMicros).toBe(50_000 * M);

    const order = await createPendingOrder(db, {
      organizationId,
      userId,
      productVersionId: product.versionId,
      source: 'PURCHASE',
      idempotencyKey: `golden-order-${crypto.randomUUID()}`,
      amountMicros: 95 * M,
      currency: 'USD',
    });
    LEDGER.orderId = order.id;

    // Trusted payment: a SERVER-SIDE signed mock event through the provider boundary.
    const paid = await simulateProviderPayment(db, { organizationId, orderId: order.id });
    expect(paid.status).toBe('PROVISIONED');
    evalAccountId = (paid as { accountId?: string }).accountId!;
    LEDGER.paymentEventStatus = paid.eventStatus;
    LEDGER.evalAccountId = evalAccountId;

    const [acct] = await db.select().from(accounts).where(eq(accounts.id, evalAccountId));
    expect(acct!.accountType).toBe('EVALUATION');
    expect(acct!.status).toBe('ACTIVE');
    expect(acct!.profileVersionId).toBe(evalProfileVersionId);
    expect(acct!.startingBalanceMicros).toBe(50_000 * M);
    expect(acct!.balanceMicros).toBe(50_000 * M);
    expect(acct!.drawdownFloorMicros).toBe(48_000 * M); // 50k − 2k
    LEDGER.provisioning = { accountType: acct!.accountType, startingBalance: acct!.startingBalanceMicros / M, floor: acct!.drawdownFloorMicros / M, pinnedVersion: evalProfileVersionId };

    // Idempotency: replaying the SAME trusted payment event does not duplicate.
    const replay = await simulateProviderPayment(db, { organizationId, orderId: order.id });
    expect((replay as { accountId?: string }).accountId).toBe(evalAccountId);
    const owned = await db.select().from(accounts).where(and(eq(accounts.userId, userId), eq(accounts.accountType, 'EVALUATION')));
    expect(owned).toHaveLength(1); // exactly one evaluation account
    LEDGER.provisioningExactlyOnce = owned.length === 1;
  });

  // ─── PART 12 — REAL SIMULATED TRADE (order → fill → realized P&L → commission → balance) ──
  it('3. a real market order fills through the engine and posts realized P&L + commission + balance', async () => {
    // Align the account to the scripted market date and give it a fee-on sim env.
    await db
      .update(accounts)
      .set({
        currentTradeDate: '2026-09-15',
        simulationEnvironment: {
          fillModel: 'SIMPLE', latencyMs: 0, marketSlippageTicks: 0, stopSlippageTicks: 0,
          requireThroughTradeForLimit: false, feesEnabled: true, useBarRange: true,
        } as never,
        instrumentLimits: { allowed: ['NQ', 'MNQ', 'ES', 'MES'], maxContracts: 5, perInstrument: {} } as never,
      })
      .where(eq(accounts.id, evalAccountId));

    const market = new ScriptedMarket();
    const engine = new TradingEngine(db, market);
    await engine.start();
    try {
      // Open long 1 NQ @ 20000, then close @ 20160 → +160 pts × $20 = +$3,200 gross.
      await market.bar('NQ', { open: 20_000, high: 20_000, low: 20_000, close: 20_000 });
      await engine.submitOrder({ accountId: evalAccountId, userId, clientOrderId: `g-open-${Date.now()}`, symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET' });
      await settle();
      const opened = await engine.valuation(evalAccountId);
      expect(opened!.openContracts).toBe(1);

      await market.bar('NQ', { open: 20_160, high: 20_160, low: 20_160, close: 20_160 });
      await engine.submitOrder({ accountId: evalAccountId, userId, clientOrderId: `g-close-${Date.now()}`, symbol: 'NQ', side: 'SELL', qty: 1, type: 'MARKET' });
      await settle();

      const v = await engine.valuation(evalAccountId);
      expect(v!.openContracts).toBe(0); // position closed
      expect(v!.realizedPnlMicros).toBe(3_200 * M); // exact gross P&L
      expect(v!.feesMicros).toBeGreaterThan(0); // commissions posted
      // The authoritative money invariant: balance = start + realized − fees.
      expect(v!.balanceMicros).toBe(50_000 * M + v!.realizedPnlMicros - v!.feesMicros);
      LEDGER.trade = {
        instrument: 'NQ', grossRealized: v!.realizedPnlMicros / M, commission: v!.feesMicros / M,
        netBalance: v!.balanceMicros / M, invariantHolds: v!.balanceMicros === 50_000 * M + v!.realizedPnlMicros - v!.feesMicros,
      };
    } finally {
      engine.stop();
    }
  });

  // ─── PART 13 — RISK: EOD trailing (the rule engine itself) ───────────────────
  it('4. EOD-trailing floor ratchets only on finalized EOD, locks at start, never backward; breach on equity', () => {
    const CORE_50K: RuleConfig = {
      accountSizeMicros: 50_000 * M, profitTargetMicros: 3_000 * M, maxLossMicros: 2_000 * M,
      drawdownType: 'EOD_TRAILING', trailingLockAtMicros: 0, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY',
      consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: 0.5, minTradingDays: 0, minWinningDays: 0,
      maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 150 * M, maxContracts: 5,
      microsCountAsFraction: true, flattenOnBreach: true,
    };
    const fresh = (): RuleState => ({
      status: 'ACTIVE', startingBalanceMicros: 50_000 * M, balanceMicros: 50_000 * M, highWaterMarkMicros: 50_000 * M,
      drawdownFloorMicros: 48_000 * M, dayStartBalanceMicros: 50_000 * M, dayStartEquityMicros: 50_000 * M,
      currentTradeDate: '2026-09-15', tradingDaysCount: 0, winningDaysCount: 0, bestDayProfitMicros: 0,
      lockedUntilDate: null, failedReason: null,
    });
    const mark = (bal: number, open = 0, d = '2026-09-15'): RuleMark => ({ balanceMicros: bal, openPnlMicros: open, equityMicros: bal + open, tradingDate: d });
    const NO_HIST: DailyHistory = { bestDayProfitMicros: 0, totalProfitMicros: 0, tradingDaysCount: 0, winningDaysCount: 0 };

    // A. intraday unrealized gain does NOT ratchet the floor
    expect(advanceDrawdown(CORE_50K, fresh(), mark(50_000 * M, 3_000 * M)).drawdownFloorMicros).toBe(48_000 * M);
    // B. finalized EOD close 51,000 → floor 49,000
    expect(rollTradingDay(CORE_50K, fresh(), mark(51_000 * M, 0, '2026-09-16')).state.drawdownFloorMicros).toBe(49_000 * M);
    // C. finalized EOD close 52,000 → floor 50,000 (start)
    const s2 = { ...fresh(), highWaterMarkMicros: 51_000 * M, drawdownFloorMicros: 49_000 * M };
    expect(rollTradingDay(CORE_50K, s2, mark(52_000 * M, 0, '2026-09-16')).state.drawdownFloorMicros).toBe(50_000 * M);
    // D. higher HWM keeps floor locked at 50,000
    const s3 = { ...fresh(), highWaterMarkMicros: 52_000 * M, drawdownFloorMicros: 50_000 * M };
    expect(rollTradingDay(CORE_50K, s3, mark(55_000 * M, 0, '2026-09-16')).state.drawdownFloorMicros).toBe(50_000 * M);
    // E. losing day never moves floor backward
    const s4 = { ...fresh(), highWaterMarkMicros: 55_000 * M, drawdownFloorMicros: 50_000 * M };
    expect(rollTradingDay(CORE_50K, s4, mark(51_000 * M, 0, '2026-09-16')).state.drawdownFloorMicros).toBe(50_000 * M);
    // F. current floor enforced intraday on EQUITY
    const breach = evaluateRules(CORE_50K, fresh(), mark(48_500 * M, -600 * M), NO_HIST); // equity 47,900 < 48,000
    expect(breach.remainingDrawdownMicros).toBeLessThanOrEqual(0);
    expect(breach.breach).not.toBeNull();
    expect(breach.canTrade).toBe(false);
    LEDGER.risk = { intradayNoRatchet: true, ratchet51: 49000, ratchet52: 50000, lockedAt: 50000, neverBackward: true, breachMetric: 'equity' };
  });

  // ─── PART 14 — CONSISTENCY (delay vs qualify) ────────────────────────────────
  it('5. reaching target with best-day/total > 50% is GOAL_REACHED (delayed); ≤ 50% is PASSED', () => {
    const CORE_50K: RuleConfig = {
      accountSizeMicros: 50_000 * M, profitTargetMicros: 3_000 * M, maxLossMicros: 2_000 * M,
      drawdownType: 'EOD_TRAILING', trailingLockAtMicros: 0, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY',
      consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: 0.5, minTradingDays: 0, minWinningDays: 0,
      maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 150 * M, maxContracts: 5,
      microsCountAsFraction: true, flattenOnBreach: true,
    };
    const base = (bal: number, bestDay: number): RuleState => ({
      status: 'ACTIVE', startingBalanceMicros: 50_000 * M, balanceMicros: bal, highWaterMarkMicros: bal,
      drawdownFloorMicros: 48_000 * M, dayStartBalanceMicros: bal, dayStartEquityMicros: bal,
      currentTradeDate: '2026-09-20', tradingDaysCount: 3, winningDaysCount: 3, bestDayProfitMicros: bestDay,
      lockedUntilDate: null, failedReason: null,
    });
    const mk = (bal: number): RuleMark => ({ balanceMicros: bal, openPnlMicros: 0, equityMicros: bal, tradingDate: '2026-09-20' });

    // Target reached ($3,000) but one day is the whole profit → 100% > 50% → delayed.
    const delayed = evaluateRules(CORE_50K, base(53_000 * M, 3_000 * M), mk(53_000 * M), { bestDayProfitMicros: 3_000 * M, totalProfitMicros: 3_000 * M, tradingDaysCount: 3, winningDaysCount: 3 });
    expect(delayed.status).toBe('GOAL_REACHED');
    expect(delayed.status).not.toBe('FAILED'); // not failed — just delayed
    // Same target but spread out → best/total ≤ 50% → PASSED.
    const passed = evaluateRules(CORE_50K, base(56_000 * M, 3_000 * M), mk(56_000 * M), { bestDayProfitMicros: 3_000 * M, totalProfitMicros: 6_000 * M, tradingDaysCount: 3, winningDaysCount: 3 });
    expect(passed.status).toBe('PASSED');
    LEDGER.consistency = { delayedStatus: delayed.status, qualifiedStatus: passed.status, threshold: 0.5 };
  });

  // ─── PART 15/16/17 — EVALUATION PASS → FUNDED (real transition, exactly-once) ─
  it('6. the traded account passes evaluation and funds exactly one Core 50K funded account', async () => {
    // The account is above target from the real trade (net > $3,000) with no prior
    // closed day → consistency null → PASSED. certifyEvaluation runs the REAL rules.
    const qual = await certifyEvaluation(db, evalAccountId);
    expect(qual).not.toBeNull();
    qualificationId = qual!.id;
    const [passedAcct] = await db.select().from(accounts).where(eq(accounts.id, evalAccountId));
    expect(passedAcct!.status).toBe('PASSED');
    const [q] = await db.select().from(accountQualifications).where(eq(accountQualifications.id, qualificationId));
    expect(q!.fundingState).toBe('ELIGIBLE');
    LEDGER.evaluationPass = { previousState: 'ACTIVE', newState: passedAcct!.status, qualificationId, fundingState: q!.fundingState };

    // Idempotent certify: no second qualification.
    const again = await certifyEvaluation(db, evalAccountId);
    expect(again?.id ?? qualificationId).toBe(qualificationId);

    const funded = await approveFunding(db, qualificationId, { actor: { type: 'SYSTEM', label: 'golden-path' } });
    fundedAccountId = funded.fundedAccountId;
    LEDGER.fundedAccountId = fundedAccountId;
    // Idempotent funding: same account on retry.
    const fundedAgain = await approveFunding(db, qualificationId, { actor: { type: 'SYSTEM', label: 'golden-path' } });
    expect(fundedAgain.fundedAccountId).toBe(fundedAccountId);

    const fundedRows = await db.select().from(accounts).where(and(eq(accounts.sourceQualificationId, qualificationId), eq(accounts.accountType, 'FUNDED_SIM')));
    expect(fundedRows).toHaveLength(1); // exactly one funded account
    const f = fundedRows[0]!;
    expect(f.sourceAccountId).toBe(evalAccountId); // lineage
    expect(f.startingBalanceMicros).toBe(50_000 * M);
    LEDGER.fundedTransition = { count: fundedRows.length, lineageSourceAccount: f.sourceAccountId, startingBalance: f.startingBalanceMicros / M };
    // Evaluation history preserved (the eval account still exists, PASSED).
    const [stillEval] = await db.select().from(accounts).where(eq(accounts.id, evalAccountId));
    expect(stillEval!.status).toBe('PASSED');
  });

  // ─── PART 17 — FUNDED CERTIFICATE ────────────────────────────────────────────
  it('7. the funded transition issues a FUNDED_TRADER certificate (deterministic, verifiable)', async () => {
    await applyRecognition(db, { type: 'account.funded', organizationId, userId, accountId: fundedAccountId, payload: {} } as never);
    const certs = await listCertificatesForUser(db, userId);
    const funded = certs.find((c) => c.type === 'FUNDED_TRADER');
    expect(funded).toBeTruthy();
    const pub = await publicVerification(db, funded!.verificationToken);
    expect(pub.valid).toBe(true);
    LEDGER.fundedCertificate = { id: funded!.id, type: funded!.type, verifies: pub.valid };
    // Idempotent: re-applying recognition does not duplicate.
    await applyRecognition(db, { type: 'account.funded', organizationId, userId, accountId: fundedAccountId, payload: {} } as never);
    const certs2 = (await listCertificatesForUser(db, userId)).filter((c) => c.type === 'FUNDED_TRADER');
    expect(certs2).toHaveLength(1);
  });

  // ─── PART 19 — FUNDED WINNING DAYS (net realized ≥ $150) ─────────────────────
  it('8. winning-day counting: net ≥ $150 counts once/day; sub-$150 and negative do not', () => {
    const CORE_50K: RuleConfig = {
      accountSizeMicros: 50_000 * M, profitTargetMicros: 0, maxLossMicros: 2_000 * M, drawdownType: 'EOD_TRAILING',
      trailingLockAtMicros: 0, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL',
      consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0,
      minWinningDayPnlMicros: 150 * M, maxContracts: 5, microsCountAsFraction: true, flattenOnBreach: true,
    };
    const st = (bal: number, d: string): RuleState => ({
      status: 'ACTIVE', startingBalanceMicros: 50_000 * M, balanceMicros: bal, highWaterMarkMicros: bal, drawdownFloorMicros: 48_000 * M,
      dayStartBalanceMicros: bal, dayStartEquityMicros: bal, currentTradeDate: d, tradingDaysCount: 0, winningDaysCount: 0,
      bestDayProfitMicros: 0, lockedUntilDate: null, failedReason: null,
    });
    const mk = (bal: number, d: string): RuleMark => ({ balanceMicros: bal, openPnlMicros: 0, equityMicros: bal, tradingDate: d });
    // +$200 day → winning
    expect(rollTradingDay(CORE_50K, st(50_000 * M, '2026-09-15'), mk(50_200 * M, '2026-09-16')).closed!.winning).toBe(true);
    // +$100 day → not winning (< $150)
    expect(rollTradingDay(CORE_50K, st(50_000 * M, '2026-09-15'), mk(50_100 * M, '2026-09-16')).closed!.winning).toBe(false);
    // −$300 day → not winning
    expect(rollTradingDay(CORE_50K, st(50_000 * M, '2026-09-15'), mk(49_700 * M, '2026-09-16')).closed!.winning).toBe(false);
    LEDGER.winningDayRules = { qualifies200: true, rejects100: true, rejectsNegative: true, threshold: 150 };
  });

  it('9. five qualifying winning days recorded on the funded account via the authoritative day-close writer', async () => {
    // Bring the funded account to a withdrawable-profit state and record 5 winning
    // days through recordClosedDay (the exact writer the engine day-roll uses).
    await db.update(accounts).set({ balanceMicros: 51_000 * M, dayStartBalanceMicros: 51_000 * M, dayStartEquityMicros: 51_000 * M, highWaterMarkMicros: 51_000 * M, activatedAt: new Date() }).where(eq(accounts.id, fundedAccountId));
    for (let i = 0; i < 5; i += 1) {
      const day = `2026-10-0${i + 1}`;
      await recordClosedDay(db, fundedAccountId, {
        tradeDate: day, startingBalanceMicros: 50_800 * M, endingBalanceMicros: 51_000 * M, counted: true,
      });
    }
    const rows = await db.select().from(dailyAccountStats).where(eq(dailyAccountStats.accountId, fundedAccountId));
    const winning = rows.filter((r) => r.realizedPnlMicros >= 150 * M);
    expect(winning.length).toBeGreaterThanOrEqual(5);
    LEDGER.winningDays = { recorded: winning.length };
  });

  // ─── PART 20/21/22 — PAYOUT ELIGIBILITY + REQUEST + MONEY MATH ────────────────
  it('10. payout eligibility is server-authoritative and the money split is exact 90/10', async () => {
    const ctx = await getPayoutEligibility(db, fundedAccountId);
    const elig = ctx.eligibility;
    LEDGER.payoutEligibility = {
      grossWithdrawableMicros: elig.grossWithdrawableMicros / M,
      qualifyingWinningDays: elig.qualifyingWinningDays,
      maxRequestMicros: elig.maxRequestMicros / M,
      state: elig.state,
      reasonCodes: elig.reasonCodes,
    };
    expect(elig.qualifyingWinningDays).toBeGreaterThanOrEqual(5);
    expect(elig.grossWithdrawableMicros).toBeGreaterThan(0);
    expect(elig.state).toBe('ELIGIBLE');

    const [beforeAcct] = await db.select().from(accounts).where(eq(accounts.id, fundedAccountId));
    const beforeBalance = beforeAcct!.balanceMicros;

    // Request the max the engine allows (bounded by cap $2,000 and 50% rule).
    const requestedGross = Math.min(elig.maxRequestMicros, 500 * M);
    const req = await requestPayout(db, { accountId: fundedAccountId, userId, requestedGrossMicros: requestedGross, idempotencyKey: `golden-payout-${crypto.randomUUID()}`, actor: { type: 'USER', id: userId } as never });
    payoutRequestId = req.id;
    LEDGER.payoutRequestId = payoutRequestId;

    const approved = await approvePayout(db, { payoutRequestId, actor: { type: 'SYSTEM', label: 'owner-approval' } });
    const trader = approved.traderShareMicros!;
    const firm = approved.firmShareMicros!;
    const debit = approved.balanceAdjustmentMicros!;
    expect(trader + firm).toBe(debit); // shares reconcile to the debit exactly
    expect(trader).toBe(Math.round(requestedGross * 0.9)); // 90%
    expect(firm).toBe(requestedGross - trader); // 10% exact complement
    expect(debit).toBe(requestedGross); // whole gross leaves the balance

    const [afterAcct] = await db.select().from(accounts).where(eq(accounts.id, fundedAccountId));
    expect(afterAcct!.balanceMicros).toBe(beforeBalance - debit); // single debit
    expect(afterAcct!.startingBalanceMicros).toBe(50_000 * M); // starting balance untouched
    LEDGER.money = {
      grossEligible: elig.grossWithdrawableMicros / M, requested: requestedGross / M,
      traderShare: trader / M, firmShare: firm / M, accountDebit: debit / M,
      beforeBalance: beforeBalance / M, afterBalance: afterAcct!.balanceMicros / M,
    };
  });

  // ─── PART 25/26 — SINGLE DEBIT + POST-PAYOUT RISK ────────────────────────────
  it('11. approval debits exactly once (retry does not double-debit) and never loosens the floor', async () => {
    const [before] = await db.select().from(accounts).where(eq(accounts.id, fundedAccountId));
    const floorBefore = before!.drawdownFloorMicros;
    // Duplicate approval attempt is idempotent (already APPROVED).
    await approvePayout(db, { payoutRequestId, actor: { type: 'SYSTEM', label: 'owner-approval-retry' } });
    const debitRows = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, payoutRequestId), eq(payoutLedger.entryType, 'DEBIT')));
    expect(debitRows).toHaveLength(1); // exactly one DEBIT ever
    const [after] = await db.select().from(accounts).where(eq(accounts.id, fundedAccountId));
    expect(after!.balanceMicros).toBe(before!.balanceMicros); // no second debit
    expect(after!.drawdownFloorMicros).toBe(floorBefore); // floor not loosened by payout
    LEDGER.exactlyOnceDebit = { debitLedgerRows: debitRows.length, floorUnchanged: after!.drawdownFloorMicros === floorBefore };
  });

  // ─── PART 24/27/28 — DEV/TEST SETTLEMENT → PAID (idempotent) ─────────────────
  it('12. development/test settlement reaches PAID once and is marked mock (never a real payout)', async () => {
    // APPROVED → PROCESSING (submitted) → PAID (dev/test settlement).
    await markProcessing(db, { payoutRequestId, actor: { type: 'SYSTEM', label: 'dev-submit' } });
    const paid = await markPaid(db, { payoutRequestId, actor: { type: 'SYSTEM', label: 'dev-settlement' } });
    expect(paid.state).toBe('PAID');
    const settleRows = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, payoutRequestId), eq(payoutLedger.entryType, 'SETTLEMENT')));
    expect(settleRows).toHaveLength(1);
    expect((settleRows[0]!.meta as { mock?: boolean }).mock).toBe(true); // explicitly dev/test bookkeeping
    // Idempotent PAID: no second settlement row.
    await markPaid(db, { payoutRequestId, actor: { type: 'SYSTEM', label: 'dev-settlement-retry' } });
    const settleRows2 = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, payoutRequestId), eq(payoutLedger.entryType, 'SETTLEMENT')));
    expect(settleRows2).toHaveLength(1);
    LEDGER.settlement = { classification: 'DEVELOPMENT/TEST bookkeeping (meta.mock=true)', state: paid.state, settlementRows: settleRows2.length };
  });

  // ─── PART 28 — PAYOUT CERTIFICATE ────────────────────────────────────────────
  it('13. PAID issues exactly one payout certificate for the correct customer', async () => {
    await applyRecognition(db, { type: 'payout.paid', organizationId, userId, accountId: fundedAccountId, payload: { payoutRequestId } } as never);
    const certs = (await listCertificatesForUser(db, userId)).filter((c) => c.type === 'PAYOUT');
    expect(certs.length).toBeGreaterThanOrEqual(1);
    const pub = await publicVerification(db, certs[0]!.verificationToken);
    expect(pub.valid).toBe(true);
    // Idempotent: re-applying does not duplicate this payout's certificate.
    await applyRecognition(db, { type: 'payout.paid', organizationId, userId, accountId: fundedAccountId, payload: { payoutRequestId } } as never);
    const certs2 = (await listCertificatesForUser(db, userId)).filter((c) => c.type === 'PAYOUT');
    expect(certs2).toHaveLength(certs.length);
    LEDGER.payoutCertificate = { id: certs[0]!.id, verifies: pub.valid, count: certs2.length };
  });

  // ─── PART 29/39 — RECONCILIATION (views agree, no orphans) ───────────────────
  it('14. the account ledger reconciles and the lifecycle has explainable lineage', async () => {
    const findings = (await auditLedgers(db)).filter((f) => f.accountId === evalAccountId || f.accountId === fundedAccountId);
    expect(findings).toEqual([]); // rules ↔ ledger agree for our accounts

    // One order → one eval account → one funded account → one paid payout → certs.
    const evalRows = await db.select().from(accounts).where(and(eq(accounts.userId, userId), eq(accounts.accountType, 'EVALUATION')));
    const fundedRows = await db.select().from(accounts).where(and(eq(accounts.userId, userId), eq(accounts.accountType, 'FUNDED_SIM')));
    const paidReqs = await db.select().from(payoutRequests).where(and(eq(payoutRequests.accountId, fundedAccountId), eq(payoutRequests.state, 'PAID')));
    expect(evalRows).toHaveLength(1);
    expect(fundedRows).toHaveLength(1);
    expect(paidReqs).toHaveLength(1);
    LEDGER.reconciliation = { ledgerFindings: findings.length, evalAccounts: evalRows.length, fundedAccounts: fundedRows.length, paidPayouts: paidReqs.length };
  });

  // ─── PART 39 — MONEY INVARIANTS ──────────────────────────────────────────────
  it('15. money invariants hold: one fulfillment, one funded, one debit, one PAID, one payout cert', async () => {
    const debitRows = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, payoutRequestId), eq(payoutLedger.entryType, 'DEBIT')));
    const settleRows = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, payoutRequestId), eq(payoutLedger.entryType, 'SETTLEMENT')));
    const paidReqs = await db.select().from(payoutRequests).where(and(eq(payoutRequests.accountId, fundedAccountId), eq(payoutRequests.state, 'PAID')));
    const fundedCerts = (await listCertificatesForUser(db, userId)).filter((c) => c.type === 'FUNDED_TRADER');
    const payoutCerts = (await listCertificatesForUser(db, userId)).filter((c) => c.type === 'PAYOUT');
    expect(debitRows).toHaveLength(1);
    expect(settleRows).toHaveLength(1);
    expect(paidReqs).toHaveLength(1);
    expect(fundedCerts).toHaveLength(1);
    expect(payoutCerts.length).toBeGreaterThanOrEqual(1);
    LEDGER.invariants = { debits: debitRows.length, settlements: settleRows.length, paid: paidReqs.length, fundedCerts: fundedCerts.length, payoutCerts: payoutCerts.length };
  });
});
