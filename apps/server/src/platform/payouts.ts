/**
 * Happy Trader Funding — the production payout engine.
 *
 * Real deterministic trader/account state. Treated like the execution engine:
 * every money mutation runs in one transaction under the account advisory lock
 * with a `SELECT … FOR UPDATE` re-read and a `version` CAS, so a duplicate
 * request, a duplicate approval or two operators acting at once can never move
 * money twice. The balance is debited exactly once — at APPROVED — and the
 * append-only ledger DEBIT (unique per request+entry) is the structural proof.
 *
 * No money leaves the firm in V1: PROCESSING and PAID are operator/mock
 * transitions. All eligibility arithmetic is the pure `payout-core` module,
 * re-run inside the approval lock and never trusted from a stale read.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  accounts,
  dailyAccountStats,
  payoutCycles,
  payoutLedger,
  payoutRequests,
} from '../db/schema.js';
import { accountAdvisoryLockSql } from '../trading/account-lock.js';
import { holdBlocking, resolveAccountOwnerIdentity } from './enforcement-holds.js';
import type { HoldCapability } from './enforcement-core.js';
import type { Actor } from './actor.js';
import { recordAudit } from './audit.js';
import { events, type DomainEventType } from './events.js';
import { enqueueOutbox } from './outbox.js';
import { resolveProfileVersion } from './profiles.js';
import {
  type DayStat,
  type PayoutEligibility,
  type PayoutModel,
  type PayoutPolicy,
  type PayoutReasonCode,
  evaluatePayoutEligibility,
  parsePayoutPolicy,
  resolvePayoutRequest,
  splitAccounting,
} from './payout-core.js';

export class PayoutError extends Error {
  constructor(
    readonly code:
      | 'ACCOUNT_NOT_FOUND'
      | 'NOT_FUNDED'
      | 'NO_PAYOUT_POLICY'
      | 'PAYOUT_NOT_FOUND'
      | 'NOT_ELIGIBLE'
      | 'INVALID_TRANSITION'
      | 'INVALID_AMOUNT',
    message: string,
    readonly reason?: PayoutReasonCode,
  ) {
    super(message);
    this.name = 'PayoutError';
  }
}

export type PayoutState =
  | 'REQUESTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'PROCESSING'
  | 'PAID'
  | 'REJECTED'
  | 'CANCELLED'
  | 'FAILED';

/** The only transitions the machine permits. Anything else throws. */
const ALLOWED: Record<PayoutState, PayoutState[]> = {
  REQUESTED: ['UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['PROCESSING', 'FAILED'],
  PROCESSING: ['PAID', 'FAILED'],
  PAID: [],
  REJECTED: [],
  CANCELLED: [],
  FAILED: [],
};

const NON_TERMINAL: PayoutState[] = ['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING'];

export type AccountRow = typeof accounts.$inferSelect;
export type PayoutRow = typeof payoutRequests.$inferSelect;

// -- policy + inputs ---------------------------------------------------------

/** The payout policy pinned to a funded account's product version. */
export async function payoutPolicyFor(db: Database, account: AccountRow): Promise<PayoutPolicy | null> {
  // A funded account is pinned to its funded product version at provision time.
  const versionId = account.profileVersionId ?? account.fundedProfileVersionId;
  if (!versionId) return null;
  const resolved = await resolveProfileVersion(db, versionId);
  const raw = resolved?.config.payoutRules;
  if (!raw) return null;
  try {
    return parsePayoutPolicy(raw);
  } catch {
    return null;
  }
}

/** Finalized per-day net (ending − starting) for a funded account. */
export async function dayStatsFor(db: Database, accountId: string): Promise<DayStat[]> {
  const rows = await db
    .select({
      tradeDate: dailyAccountStats.tradeDate,
      starting: dailyAccountStats.startingBalanceMicros,
      ending: dailyAccountStats.endingBalanceMicros,
    })
    .from(dailyAccountStats)
    .where(eq(dailyAccountStats.accountId, accountId));
  return rows.map((r) => ({ tradeDate: r.tradeDate, netMicros: r.ending - r.starting }));
}

async function pendingRequestExists(db: Database, accountId: string, excludeId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: payoutRequests.id })
    .from(payoutRequests)
    .where(and(eq(payoutRequests.accountId, accountId), inArray(payoutRequests.state, NON_TERMINAL)));
  return rows.some((r) => r.id !== excludeId);
}

/** The account's current open cycle, if any (highest ordinal, not closed). */
async function currentCycle(db: Database, accountId: string) {
  const [row] = await db
    .select()
    .from(payoutCycles)
    .where(eq(payoutCycles.accountId, accountId))
    .orderBy(desc(payoutCycles.ordinal))
    .limit(1);
  return row ?? null;
}

export interface EligibilityContext {
  readonly account: AccountRow;
  readonly policy: PayoutPolicy;
  readonly eligibility: PayoutEligibility;
  /** A firm enforcement hold blocks a payout request (M7); separate from economic eligibility. */
  readonly enforcementHold?: boolean;
  readonly nextOrdinal: number;
  readonly cycleStartDate: string | null;
}

/** The universal maximum number of payout cycles an account may be paid. */
export const MAX_PAYOUT_CYCLES = 5;

/**
 * The qualifying account balance snapshotted at the approval of this account's
 * previous approved Daily payout (Milestone 6). Derived from the immutable
 * per-request snapshot, never a mutable running total. The progression invariant
 * makes these monotonically increasing, so the maximum is the most recent.
 * Excludes the request currently being decided (excludeId).
 */
async function previousDailyQualifyingBalance(
  db: Database,
  accountId: string,
  excludeId?: string,
): Promise<number | null> {
  const rows = await db
    .select({ id: payoutRequests.id, snap: payoutRequests.qualifyingBalanceAtApproval })
    .from(payoutRequests)
    .where(
      and(
        eq(payoutRequests.accountId, accountId),
        inArray(payoutRequests.state, ['APPROVED', 'PROCESSING', 'PAID']),
      ),
    );
  let max: number | null = null;
  for (const r of rows) {
    if (r.id === excludeId) continue;
    if (r.snap != null && (max === null || r.snap > max)) max = r.snap;
  }
  return max;
}

async function buildContext(db: Database, account: AccountRow, forRequest?: PayoutRow | null): Promise<EligibilityContext> {
  const policy = await payoutPolicyFor(db, account);
  if (!policy) throw new PayoutError('NO_PAYOUT_POLICY', 'This account has no payout policy on its product version.');
  const days = await dayStatsFor(db, account.id);
  const cycle = await currentCycle(db, account.id);
  const paidCount = await countApprovedPayouts(db, account.id);
  const nextOrdinal = paidCount + 1;
  const hold = forRequest?.holdKind as 'RISK' | 'FRAUD' | 'MANUAL' | null | undefined;
  const prevDailyQualifying =
    policy.model === 'DAILY' ? await previousDailyQualifyingBalance(db, account.id, forRequest?.id) : null;
  const eligibility = evaluatePayoutEligibility(
    {
      policy,
      balanceMicros: account.balanceMicros,
      startingBalanceMicros: account.startingBalanceMicros,
      days,
      cycleStartDate: cycle?.startedOn ?? null,
      dailyModeUnlocked: cycle?.dailyModeUnlocked ?? false,
      accountStatus: account.status,
      adminHold: account.adminHold,
      hold: hold ?? null,
      // When re-checking to approve THIS request, it must not count itself as a
      // blocking pending request.
      hasPendingRequest: await pendingRequestExists(db, account.id, forRequest?.id),
      previousDailyQualifyingBalanceMicros: prevDailyQualifying,
      // Prior paid/approved cycles. The request being decided is never in an
      // approved state here (approvePayout early-returns for approved requests
      // before this runs), so it is not double-counted.
      paidCycleCount: paidCount,
      maxPayoutCycles: MAX_PAYOUT_CYCLES,
    },
    nextOrdinal,
  );
  return { account, policy, eligibility, nextOrdinal, cycleStartDate: cycle?.startedOn ?? null };
}

async function countApprovedPayouts(db: Database, accountId: string): Promise<number> {
  const rows = await db
    .select({ id: payoutRequests.id })
    .from(payoutRequests)
    .where(and(eq(payoutRequests.accountId, accountId), inArray(payoutRequests.state, ['APPROVED', 'PROCESSING', 'PAID'])));
  return rows.length;
}

async function loadAccount(db: Database, accountId: string): Promise<AccountRow> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!row) throw new PayoutError('ACCOUNT_NOT_FOUND', 'No such account.');
  return row;
}

// -- read-only eligibility ---------------------------------------------------

/** Compute the account's current payout eligibility (trader UI + admin case). */
/**
 * Is a firm enforcement hold (M7) blocking this payout capability? Checks the
 * account-scoped and customer-scoped holds. SEPARATE from economic eligibility —
 * a held payout is "temporarily under review", not "ineligible".
 */
async function payoutHoldActive(db: Database, account: AccountRow, capability: HoldCapability, payoutRequestId?: string): Promise<boolean> {
  const owner = await resolveAccountOwnerIdentity(db, account.id);
  const subject = { accountId: account.id, customerIdentityId: owner?.customerIdentityId ?? null, payoutRequestId: payoutRequestId ?? null };
  return (await holdBlocking(db, subject, capability)) != null;
}

export async function getPayoutEligibility(db: Database, accountId: string): Promise<EligibilityContext> {
  const account = await loadAccount(db, accountId);
  const ctx = await buildContext(db, account);
  const enforcementHold = await payoutHoldActive(db, account, 'PAYOUT_REQUEST');
  return { ...ctx, enforcementHold };
}

// -- request -----------------------------------------------------------------

export interface RequestPayoutInput {
  readonly accountId: string;
  readonly userId: string;
  readonly requestedGrossMicros: number;
  readonly idempotencyKey?: string | null;
  readonly actor: Actor;
}

/**
 * A trader (or operator on their behalf) requests a payout. Idempotent on the
 * key; a duplicate returns the existing row. Refuses an ineligible account or an
 * out-of-bounds amount with a machine reason, moving no money.
 */
export async function requestPayout(db: Database, input: RequestPayoutInput): Promise<PayoutRow> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    await tx.execute(accountAdvisoryLockSql(input.accountId));

    // Idempotency: a duplicate request key returns the first row untouched.
    if (input.idempotencyKey) {
      const [existing] = await tx
        .select()
        .from(payoutRequests)
        .where(
          and(
            eq(payoutRequests.idempotencyKey, input.idempotencyKey),
            eq(payoutRequests.accountId, input.accountId),
          ),
        );
      if (existing) return existing;
    }

    const [account] = await tx.select().from(accounts).where(eq(accounts.id, input.accountId)).for('update');
    if (!account) throw new PayoutError('ACCOUNT_NOT_FOUND', 'No such account.');
    const ctx = await buildContext(scoped, account);

    // Firm enforcement hold (M7): a payout REQUEST is blocked while under review.
    // This is separate from economic eligibility and moves no money.
    if (await payoutHoldActive(scoped, account, 'PAYOUT_REQUEST')) {
      throw new PayoutError('NOT_ELIGIBLE', 'Your payout is temporarily under review.', 'ENFORCEMENT_HOLD');
    }

    const resolution = resolvePayoutRequest(
      ctx.eligibility,
      ctx.policy,
      input.requestedGrossMicros,
      account.balanceMicros,
    );
    if (!resolution.ok) {
      throw new PayoutError('NOT_ELIGIBLE', `Payout not permitted: ${resolution.reason}.`, resolution.reason);
    }

    const cycle = await ensureCycle(tx, account, ctx.policy, ctx.eligibility);

    const [created] = await tx
      .insert(payoutRequests)
      .values({
        organizationId: account.organizationId!,
        accountId: account.id,
        userId: account.userId,
        productVersionId: account.profileVersionId ?? account.fundedProfileVersionId ?? null,
        cycleId: cycle.id,
        state: 'REQUESTED',
        requestedGrossMicros: input.requestedGrossMicros,
        protectedBufferMicros: ctx.policy.fundedBufferMicros,
        withdrawableBeforeMicros: ctx.eligibility.grossWithdrawableMicros,
        eligibilitySnapshot: eligibilitySnapshot(ctx.eligibility),
        payoutOrdinal: ctx.nextOrdinal,
        idempotencyKey: input.idempotencyKey ?? null,
        requestedByUserId: input.userId,
      })
      .returning();

    await audit(scoped, account, created!, 'payout.requested', input.actor, null, {
      requestedGrossMicros: input.requestedGrossMicros,
    });
    await publish(scoped, account, 'payout.requested', created!.id);
    return created!;
  });
}

/** Find the open cycle or open a new one at ordinal 1. */
async function ensureCycle(
  tx: Database,
  account: AccountRow,
  policy: PayoutPolicy,
  eligibility: PayoutEligibility,
) {
  const existing = await currentCycle(tx, account.id);
  if (existing && !existing.closedAt) {
    // Daily: once unlocked, persist the flag on the cycle.
    if (policy.model === 'DAILY' && eligibility.dailyModeUnlocked && !existing.dailyModeUnlocked) {
      const [updated] = await tx
        .update(payoutCycles)
        .set({ dailyModeUnlocked: true })
        .where(eq(payoutCycles.id, existing.id))
        .returning();
      return updated!;
    }
    return existing;
  }
  const nextOrdinal = (existing?.ordinal ?? 0) + 1;
  const [created] = await tx
    .insert(payoutCycles)
    .values({
      organizationId: account.organizationId!,
      accountId: account.id,
      model: policy.model as PayoutModel,
      ordinal: nextOrdinal,
      startedOn: account.activatedAt ? isoDate(account.activatedAt) : null,
      dailyModeUnlocked: policy.model === 'DAILY' ? eligibility.dailyModeUnlocked : false,
    })
    .returning();
  return created!;
}

// -- approve (the one balance debit) -----------------------------------------

export interface DecideInput {
  readonly payoutRequestId: string;
  readonly actor: Actor;
  readonly reason?: string | null;
  readonly expectedVersion?: number;
}

/**
 * Approve a payout: the single point money leaves the account. Re-verifies
 * eligibility under the lock, computes the exact split, debits the balance once,
 * writes the append-only ledger DEBIT, and advances the state — all in one
 * commit. Idempotent: a second approval of an already-approved request returns
 * it unchanged.
 */
export async function approvePayout(db: Database, input: DecideInput): Promise<PayoutRow> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const [request] = await tx.select().from(payoutRequests).where(eq(payoutRequests.id, input.payoutRequestId)).for('update');
    if (!request) throw new PayoutError('PAYOUT_NOT_FOUND', 'No such payout request.');
    if (request.state === 'APPROVED' || request.state === 'PROCESSING' || request.state === 'PAID') {
      return request; // idempotent: already approved by a prior/concurrent call.
    }
    assertTransition(request.state as PayoutState, 'APPROVED');
    if (input.expectedVersion !== undefined && input.expectedVersion !== request.version) {
      throw new PayoutError('INVALID_TRANSITION', 'The payout changed while you were deciding it.');
    }

    await tx.execute(accountAdvisoryLockSql(request.accountId));
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, request.accountId)).for('update');
    if (!account) throw new PayoutError('ACCOUNT_NOT_FOUND', 'No such account.');

    // Firm enforcement hold (M7): a hold placed AFTER the request still blocks the
    // approval/debit. Checks PAYOUT_APPROVAL and PAYOUT_REQUEST holds, incl. a hold
    // scoped to this specific payout request. No balance is debited while held.
    const owner = await resolveAccountOwnerIdentity(scoped, account.id);
    const subject = { accountId: account.id, customerIdentityId: owner?.customerIdentityId ?? null, payoutRequestId: request.id };
    if ((await holdBlocking(scoped, subject, 'PAYOUT_APPROVAL')) || (await holdBlocking(scoped, subject, 'PAYOUT_REQUEST'))) {
      throw new PayoutError('NOT_ELIGIBLE', 'This payout is temporarily under review and cannot be approved yet.', 'ENFORCEMENT_HOLD');
    }

    // Re-verify against the CURRENT state, never the request-time snapshot.
    const ctx = await buildContext(scoped, account, request);
    const resolution = resolvePayoutRequest(ctx.eligibility, ctx.policy, request.requestedGrossMicros, account.balanceMicros);
    if (!resolution.ok) {
      throw new PayoutError('NOT_ELIGIBLE', `No longer eligible: ${resolution.reason}.`, resolution.reason);
    }
    const acc = resolution.accounting;
    const balanceBefore = account.balanceMicros;
    const balanceAfter = balanceBefore - acc.balanceAdjustmentMicros;

    // Debit the balance ONCE. Adjust the day-start anchors by the same amount so
    // a withdrawal is never mistaken for a losing trading day or a drawdown
    // breach; starting balance / realized P&L / high-water mark are untouched.
    await tx
      .update(accounts)
      .set({
        balanceMicros: balanceAfter,
        dayStartBalanceMicros: account.dayStartBalanceMicros - acc.balanceAdjustmentMicros,
        dayStartEquityMicros: account.dayStartEquityMicros - acc.balanceAdjustmentMicros,
        seq: sql`${accounts.seq} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, account.id));

    // The append-only DEBIT; the unique (request, entry_type) index makes a
    // duplicate approval structurally impossible to double-debit.
    await tx.insert(payoutLedger).values({
      organizationId: account.organizationId!,
      payoutRequestId: request.id,
      accountId: account.id,
      entryType: 'DEBIT',
      amountMicros: acc.balanceAdjustmentMicros,
      balanceBeforeMicros: balanceBefore,
      balanceAfterMicros: balanceAfter,
      grossEligibleMicros: acc.grossEligibleMicros,
      traderShareMicros: acc.traderShareMicros,
      firmShareMicros: acc.firmShareMicros,
      protectedBufferMicros: ctx.policy.fundedBufferMicros,
      productVersionId: request.productVersionId,
      meta: { payoutOrdinal: request.payoutOrdinal },
    });

    const [updated] = await tx
      .update(payoutRequests)
      .set({
        state: 'APPROVED',
        grossEligibleMicros: acc.grossEligibleMicros,
        traderShareMicros: acc.traderShareMicros,
        firmShareMicros: acc.firmShareMicros,
        balanceAdjustmentMicros: acc.balanceAdjustmentMicros,
        // Milestone 6: snapshot the authoritative qualifying balance used for
        // this payout — the pre-debit balance — at the exactly-once approval
        // boundary. Drives the DAILY progression rule for the next payout.
        qualifyingBalanceAtApproval: balanceBefore,
        decidedByUserId: input.actor.type === 'USER' || input.actor.type === 'ADMIN' ? input.actor.userId ?? null : null,
        decidedAt: new Date(),
        reason: input.reason ?? null,
        version: request.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(payoutRequests.id, request.id))
      .returning();

    // Close the current cycle and, for Core/Select, open the next one so the
    // winning-day count resets. Daily keeps its single unlocked cycle.
    await advanceCycleAfterPayout(tx, account, ctx.policy, request.cycleId);

    await audit(scoped, account, updated!, 'payout.approved', input.actor, request, {
      grossEligibleMicros: acc.grossEligibleMicros,
      traderShareMicros: acc.traderShareMicros,
      firmShareMicros: acc.firmShareMicros,
      balanceBeforeMicros: balanceBefore,
      balanceAfterMicros: balanceAfter,
    }, input.reason ?? null);
    await audit(scoped, account, updated!, 'payout.balance_adjusted', input.actor, null, {
      amountMicros: acc.balanceAdjustmentMicros,
      balanceBeforeMicros: balanceBefore,
      balanceAfterMicros: balanceAfter,
    });
    await publish(scoped, account, 'payout.approved', request.id);
    return updated!;
  });
}

/** Core/Select: close the paid cycle, open the next with today's window start. */
async function advanceCycleAfterPayout(
  tx: Database,
  account: AccountRow,
  policy: PayoutPolicy,
  cycleId: string | null,
): Promise<void> {
  if (policy.model === 'DAILY') return; // Daily does not reset between payouts.
  if (!cycleId) return;
  const [cycle] = await tx.select().from(payoutCycles).where(eq(payoutCycles.id, cycleId));
  if (!cycle || cycle.closedAt) return;
  await tx.update(payoutCycles).set({ closedAt: new Date() }).where(eq(payoutCycles.id, cycle.id));
  await tx.insert(payoutCycles).values({
    organizationId: account.organizationId!,
    accountId: account.id,
    model: policy.model as PayoutModel,
    ordinal: cycle.ordinal + 1,
    // The next cycle counts winning days strictly AFTER today.
    startedOn: isoDate(new Date()),
    dailyModeUnlocked: false,
  });
}

// -- reject / cancel / hold / process / pay ----------------------------------

export async function rejectPayout(db: Database, input: DecideInput): Promise<PayoutRow> {
  return simpleTransition(db, input.payoutRequestId, 'REJECTED', 'payout.rejected', input.actor, input.reason ?? null);
}

export async function cancelPayout(db: Database, input: DecideInput): Promise<PayoutRow> {
  return simpleTransition(db, input.payoutRequestId, 'CANCELLED', 'payout.cancelled', input.actor, input.reason ?? null);
}

export async function markProcessing(db: Database, input: DecideInput): Promise<PayoutRow> {
  return simpleTransition(db, input.payoutRequestId, 'PROCESSING', 'payout.processing', input.actor, input.reason ?? null);
}

/** Mock settlement (no real money in V1). Writes the SETTLEMENT ledger marker. */
export async function markPaid(db: Database, input: DecideInput): Promise<PayoutRow> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const [request] = await tx.select().from(payoutRequests).where(eq(payoutRequests.id, input.payoutRequestId)).for('update');
    if (!request) throw new PayoutError('PAYOUT_NOT_FOUND', 'No such payout request.');
    if (request.state === 'PAID') return request; // idempotent
    assertTransition(request.state as PayoutState, 'PAID');
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, request.accountId));
    // A settlement moves no balance (the debit already happened at APPROVED); the
    // unique index makes a duplicate provider webhook a no-op.
    await tx.insert(payoutLedger).values({
      organizationId: request.organizationId,
      payoutRequestId: request.id,
      accountId: request.accountId,
      entryType: 'SETTLEMENT',
      amountMicros: request.traderShareMicros ?? 0,
      balanceBeforeMicros: account!.balanceMicros,
      balanceAfterMicros: account!.balanceMicros,
      traderShareMicros: request.traderShareMicros,
      firmShareMicros: request.firmShareMicros,
      grossEligibleMicros: request.grossEligibleMicros,
      productVersionId: request.productVersionId,
      meta: { mock: true },
    });
    const [updated] = await tx
      .update(payoutRequests)
      .set({ state: 'PAID', paidAt: new Date(), version: request.version + 1, updatedAt: new Date() })
      .where(eq(payoutRequests.id, request.id))
      .returning();
    await audit(scoped, account!, updated!, 'payout.paid', input.actor, request, { paid: true });
    await publish(scoped, account!, 'payout.paid', request.id);

    // Account completion (Milestone 6): the previously-missing producer for
    // COMPLETED — MAX PAYOUT CYCLES REACHED. When the account's Nth (max) payout
    // reaches PAID, mark the account COMPLETED once and publish account.completed
    // with the total trader-share paid from THIS account, which the recognition
    // subscriber turns into the ACCOUNT_COMPLETED certificate. Idempotent: the
    // status guard makes a duplicate settlement a no-op.
    const paidRows = await tx
      .select({ trader: payoutRequests.traderShareMicros })
      .from(payoutRequests)
      .where(and(eq(payoutRequests.accountId, request.accountId), eq(payoutRequests.state, 'PAID')));
    if (paidRows.length >= MAX_PAYOUT_CYCLES && account!.status !== 'COMPLETED') {
      const totalTraderShareMicros = paidRows.reduce((sum, r) => sum + (r.trader ?? 0), 0);
      await tx
        .update(accounts)
        .set({ status: 'COMPLETED', seq: sql`${accounts.seq} + 1`, updatedAt: new Date() })
        .where(eq(accounts.id, request.accountId));
      await recordAudit(scoped, {
        organizationId: account!.organizationId,
        actor: input.actor,
        subjectType: 'ACCOUNT',
        subjectId: account!.id,
        accountId: account!.id,
        userId: account!.userId,
        action: 'account.completed',
        prevState: { status: account!.status },
        newState: { status: 'COMPLETED', totalTraderShareMicros },
      });
      await events.publish(scoped, {
        type: 'account.completed',
        organizationId: account!.organizationId,
        accountId: account!.id,
        userId: account!.userId,
        payload: { accountId: account!.id, totalTraderShareMicros },
      });
      await enqueueOutbox(scoped, {
        aggregateId: account!.id,
        aggregateType: 'ACCOUNT',
        type: 'account.completed',
        payload: { accountId: account!.id, totalTraderShareMicros },
      });
    }
    return updated!;
  });
}

export async function placeHold(
  db: Database,
  input: DecideInput & { holdKind: 'RISK' | 'FRAUD' | 'MANUAL' },
): Promise<PayoutRow> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const [request] = await tx.select().from(payoutRequests).where(eq(payoutRequests.id, input.payoutRequestId)).for('update');
    if (!request) throw new PayoutError('PAYOUT_NOT_FOUND', 'No such payout request.');
    if (!NON_TERMINAL.includes(request.state as PayoutState) || request.state === 'APPROVED' || request.state === 'PROCESSING') {
      throw new PayoutError('INVALID_TRANSITION', 'Only a pending or in-review payout can be held.');
    }
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, request.accountId));
    const [updated] = await tx
      .update(payoutRequests)
      .set({ state: 'UNDER_REVIEW', holdKind: input.holdKind, reason: input.reason ?? null, version: request.version + 1, updatedAt: new Date() })
      .where(eq(payoutRequests.id, request.id))
      .returning();
    await audit(scoped, account!, updated!, 'payout.hold_placed', input.actor, request, { holdKind: input.holdKind }, input.reason ?? null);
    await publish(scoped, account!, 'payout.hold_placed', request.id);
    return updated!;
  });
}

export async function removeHold(db: Database, input: DecideInput): Promise<PayoutRow> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const [request] = await tx.select().from(payoutRequests).where(eq(payoutRequests.id, input.payoutRequestId)).for('update');
    if (!request) throw new PayoutError('PAYOUT_NOT_FOUND', 'No such payout request.');
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, request.accountId));
    const [updated] = await tx
      .update(payoutRequests)
      .set({ holdKind: null, reason: input.reason ?? null, version: request.version + 1, updatedAt: new Date() })
      .where(eq(payoutRequests.id, request.id))
      .returning();
    await audit(scoped, account!, updated!, 'payout.hold_removed', input.actor, request, {}, input.reason ?? null);
    await publish(scoped, account!, 'payout.hold_removed', request.id);
    return updated!;
  });
}

async function simpleTransition(
  db: Database,
  payoutRequestId: string,
  to: PayoutState,
  action: string,
  actor: Actor,
  reason: string | null,
): Promise<PayoutRow> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const [request] = await tx.select().from(payoutRequests).where(eq(payoutRequests.id, payoutRequestId)).for('update');
    if (!request) throw new PayoutError('PAYOUT_NOT_FOUND', 'No such payout request.');
    if (request.state === to) return request; // idempotent
    assertTransition(request.state as PayoutState, to);
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, request.accountId));
    const [updated] = await tx
      .update(payoutRequests)
      .set({
        state: to,
        reason,
        decidedByUserId: actor.type === 'USER' || actor.type === 'ADMIN' ? actor.userId ?? null : null,
        decidedAt: new Date(),
        version: request.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(payoutRequests.id, request.id))
      .returning();
    await audit(scoped, account!, updated!, action as DomainEventType, actor, request, {}, reason);
    await publish(scoped, account!, action as DomainEventType, request.id);
    return updated!;
  });
}

// -- helpers -----------------------------------------------------------------

function assertTransition(from: PayoutState, to: PayoutState): void {
  if (!ALLOWED[from].includes(to)) {
    throw new PayoutError('INVALID_TRANSITION', `A ${from.toLowerCase()} payout cannot become ${to.toLowerCase()}.`);
  }
}

function eligibilitySnapshot(e: PayoutEligibility) {
  return {
    reasonCodes: e.reasonCodes,
    grossWithdrawableMicros: e.grossWithdrawableMicros,
    qualifyingWinningDays: e.qualifyingWinningDays,
    bestDayMicros: e.bestDayMicros,
    consistencyRatio: e.consistencyRatio,
    dailyModeUnlocked: e.dailyModeUnlocked,
    minRequestMicros: e.minRequestMicros,
    maxRequestMicros: e.maxRequestMicros,
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function audit(
  db: Database,
  account: AccountRow,
  request: PayoutRow,
  action: string,
  actor: Actor,
  prev: PayoutRow | null,
  newState: Record<string, unknown>,
  reason: string | null = null,
): Promise<void> {
  await recordAudit(db, {
    organizationId: account.organizationId,
    actor,
    subjectType: 'PAYOUT',
    subjectId: request.id,
    accountId: account.id,
    userId: account.userId,
    action,
    prevState: prev ? { state: prev.state } : null,
    newState: { state: request.state, ...newState },
    reason,
  });
}

async function publish(db: Database, account: AccountRow, type: DomainEventType, payoutRequestId: string): Promise<void> {
  await events.publish(db, {
    type,
    organizationId: account.organizationId,
    accountId: account.id,
    userId: account.userId,
    payload: { payoutRequestId },
  });
  await enqueueOutbox(db, {
    aggregateId: account.id,
    aggregateType: 'ACCOUNT',
    type,
    payload: { payoutRequestId },
  });
}

// The split helper is re-exported so the simulator shares the exact accounting.
export { splitAccounting };
