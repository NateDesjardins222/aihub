/**
 * State-machine and rules inspectors (M10-C).
 *
 * These EXPLAIN "why" by consuming server-authoritative evaluation results and
 * the real domain state machines — never by re-implementing business rules.
 * The payout inspector surfaces `evaluatePayoutEligibility`'s reason codes; the
 * account inspector surfaces the projection's drawdown/consistency bands and the
 * real lifecycle history; both expose valid next transitions from the actual
 * domain machine, not an invented one.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accountLifecycles, accountProjections, accounts, payoutRequests } from '../db/schema.js';
import { getPayoutEligibility, MAX_PAYOUT_CYCLES, PAYOUT_TRANSITIONS, type PayoutState } from './payouts.js';
import { drawdownStatus } from './rule-status.js';
import { tradingHoldForAccount } from './enforcement-holds.js';
import { ApiError } from '../http/errors.js';

export interface StateMachineView {
  readonly kind: string;
  readonly current: string;
  readonly terminal: boolean;
  readonly validNext: readonly string[];
  readonly blocked: { reason: string } | null;
}

/** The payout state machine as it actually is (transitions from payouts.ts). */
export function payoutStateMachine(current: string): StateMachineView {
  const state = current as PayoutState;
  const next = PAYOUT_TRANSITIONS[state] ?? [];
  return { kind: 'payout', current, terminal: next.length === 0, validNext: next, blocked: null };
}

export interface PayoutInspection {
  readonly payoutId: string;
  readonly accountId: string;
  readonly stateMachine: StateMachineView;
  readonly eligibility: {
    state: string;
    reasonCodes: string[];
    grossWithdrawableMicros: number;
    qualifyingWinningDays: number;
    consistencyRatio: number | null;
    minRequestMicros: number;
    maxRequestMicros: number;
    dailyModeUnlocked: boolean;
    previousDailyQualifyingBalanceMicros: number | null;
    currentQualifyingBalanceMicros: number | null;
    requiredNextQualifyingBalanceMicros: number | null;
    enforcementHold: boolean;
  };
  readonly cyclesUsed: number;
  readonly maxCycles: number;
}

/** The rules inspector for a payout: real state machine + real eligibility reasons. */
export async function inspectPayout(db: Database, payoutId: string): Promise<PayoutInspection> {
  const [req] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, payoutId));
  if (!req) throw ApiError.notFound('PAYOUT_NOT_FOUND', 'Payout not found.');
  const ctx = await getPayoutEligibility(db, req.accountId);
  const e = ctx.eligibility;
  const paidCount = (
    await db
      .select({ id: payoutRequests.id })
      .from(payoutRequests)
      .where(and(eq(payoutRequests.accountId, req.accountId), eq(payoutRequests.state, 'PAID')))
  ).length;
  return {
    payoutId,
    accountId: req.accountId,
    stateMachine: payoutStateMachine(req.state),
    eligibility: {
      state: e.state,
      reasonCodes: e.reasonCodes,
      grossWithdrawableMicros: e.grossWithdrawableMicros,
      qualifyingWinningDays: e.qualifyingWinningDays,
      consistencyRatio: e.consistencyRatio,
      minRequestMicros: e.minRequestMicros,
      maxRequestMicros: e.maxRequestMicros,
      dailyModeUnlocked: e.dailyModeUnlocked,
      previousDailyQualifyingBalanceMicros: e.previousDailyQualifyingBalanceMicros,
      currentQualifyingBalanceMicros: e.currentQualifyingBalanceMicros,
      requiredNextQualifyingBalanceMicros: e.requiredNextQualifyingBalanceMicros,
      enforcementHold: ctx.enforcementHold ?? false,
    },
    cyclesUsed: paidCount,
    maxCycles: MAX_PAYOUT_CYCLES,
  };
}

export interface AccountInspection {
  readonly accountId: string;
  readonly publicId: string | null;
  readonly status: string;
  readonly ruleStatus: string | null;
  readonly adminHold: string | null;
  readonly balanceMicros: number;
  readonly startingBalanceMicros: number;
  readonly drawdown: ReturnType<typeof drawdownStatus>;
  readonly tradingHold: boolean;
  readonly lifecycles: Array<{ seq: number; endReason: string | null; startingBalanceMicros: number; finalBalanceMicros: number | null; finalStatus: string | null; createdAt: string }>;
}

/** The state inspector for an account: effective status, drawdown band, holds, lives. */
export async function inspectAccount(db: Database, accountId: string): Promise<AccountInspection> {
  const [acct] = await db
    .select({ id: accounts.id, publicId: accounts.publicId, status: accounts.status, ruleStatus: accounts.ruleStatus, adminHold: accounts.adminHold, startingBalanceMicros: accounts.startingBalanceMicros, balanceMicros: accounts.balanceMicros })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!acct) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'Account not found.');
  const [proj] = await db
    .select({ balanceMicros: accountProjections.balanceMicros, drawdownFloorMicros: accountProjections.drawdownFloorMicros })
    .from(accountProjections)
    .where(eq(accountProjections.accountId, accountId));
  const balance = proj?.balanceMicros ?? acct.balanceMicros ?? acct.startingBalanceMicros ?? 0;
  const floor = proj?.drawdownFloorMicros ?? 0;
  const starting = acct.startingBalanceMicros ?? 0;
  const lives = await db
    .select({ seq: accountLifecycles.seq, endReason: accountLifecycles.endReason, startingBalanceMicros: accountLifecycles.startingBalanceMicros, finalBalanceMicros: accountLifecycles.finalBalanceMicros, finalStatus: accountLifecycles.finalStatus, createdAt: accountLifecycles.createdAt })
    .from(accountLifecycles)
    .where(eq(accountLifecycles.accountId, accountId))
    .orderBy(asc(accountLifecycles.seq));
  const hold = await tradingHoldForAccount(db, accountId);
  return {
    accountId,
    publicId: acct.publicId,
    status: acct.status,
    ruleStatus: acct.ruleStatus,
    adminHold: acct.adminHold,
    balanceMicros: balance,
    startingBalanceMicros: starting,
    drawdown: drawdownStatus(balance, floor, starting),
    tradingHold: hold != null,
    lifecycles: lives.map((l) => ({ seq: l.seq, endReason: l.endReason, startingBalanceMicros: l.startingBalanceMicros, finalBalanceMicros: l.finalBalanceMicros, finalStatus: l.finalStatus, createdAt: l.createdAt.toISOString() })),
  };
}

/** Recent audit history for an account (reuses the hash-chained audit_log). */
export { accountAudit } from './audit.js';
