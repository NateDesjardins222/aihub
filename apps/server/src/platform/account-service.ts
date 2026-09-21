/**
 * What can be done to an account, and what it means.
 *
 * Every transition here is authoritative, audited and event-producing. None of
 * it is reachable from a trader's client: a status, a balance and a rule state
 * are not things a browser is allowed to assert.
 *
 * The rule engine still owns ACTIVE, GOAL_REACHED, LOCKED, PASSED and FAILED
 * as *trading* outcomes. This module owns the administrative states -
 * PENDING, DISABLED, ARCHIVED - and the transitions an administrator drives.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accountLifecycles, accounts, orders, positions } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { events, type DomainEventType } from './events.js';
import type { Actor } from './actor.js';
import { resolveProfileVersion } from './profiles.js';
import { accountAdvisoryLockSql } from '../trading/account-lock.js';

export type AccountStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'GOAL_REACHED'
  | 'LOCKED'
  | 'PASSED'
  | 'FAILED'
  | 'DISABLED'
  | 'ARCHIVED';

/** Statuses an order may be submitted under. Everything else is refused. */
export const TRADEABLE_STATUSES: readonly AccountStatus[] = ['ACTIVE', 'GOAL_REACHED'];

export class AccountActionError extends Error {
  constructor(
    readonly code:
      | 'ACCOUNT_NOT_FOUND'
      | 'INVALID_TRANSITION'
      | 'ACCOUNT_NOT_FLAT'
      | 'FLATTEN_FAILED'
      | 'NO_PROFILE',
    message: string,
  ) {
    super(message);
    this.name = 'AccountActionError';
  }
}

/** What the reset needs from the engine. Injected, so this module stays pure-ish. */
export interface ExecutionControl {
  cancelAll(accountId: string, symbol?: string): Promise<unknown>;
  flatten(accountId: string, userId: string, symbol: string): Promise<unknown>;
  openExposure(accountId: string): Promise<boolean>;
}

type AccountRow = typeof accounts.$inferSelect;

async function load(db: Database, accountId: string): Promise<AccountRow> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!row) throw new AccountActionError('ACCOUNT_NOT_FOUND', 'No such account.');
  return row;
}

interface TransitionOptions {
  readonly actor: Actor;
  readonly reason?: string | null;
  readonly action: string;
  readonly event: DomainEventType;
  readonly patch: Partial<AccountRow>;
  readonly allowedFrom?: readonly AccountStatus[];
  /** Lifting a hold: the effective status returns to the rule engine's. */
  readonly restoreRuleStatus?: boolean;
}

async function transition(
  db: Database,
  accountId: string,
  options: TransitionOptions,
): Promise<AccountRow> {
  /*
   * One transaction, one lock. The account advisory lock serializes this
   * transition against the trading engine (which holds the same lock while it
   * matches) and against any other transition, across processes - so an owner
   * hold cannot interleave with a trader fill, and two transitions cannot both
   * read ACTIVE and both act on it. The status is re-read FOR UPDATE inside the
   * lock, so the allowedFrom guard sees the committed truth, not a stale read.
   * The state change, its audit row and its outbox event now commit together or
   * not at all.
   */
  return db.transaction(async (tx) => {
    await tx.execute(accountAdvisoryLockSql(accountId));

    const [before] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .for('update');
    if (!before) throw new AccountActionError('ACCOUNT_NOT_FOUND', 'No such account.');
    if (options.allowedFrom && !options.allowedFrom.includes(before.status as AccountStatus)) {
      throw new AccountActionError(
        'INVALID_TRANSITION',
        `An account that is ${before.status.toLowerCase()} cannot be ${options.action
          .split('.')
          .pop()}.`,
      );
    }

    const [after] = await tx
      .update(accounts)
      .set({
        ...options.patch,
        ...(options.restoreRuleStatus ? { status: before.ruleStatus ?? 'ACTIVE' } : {}),
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    const scoped = tx as unknown as Database;
    await recordAudit(scoped, {
      organizationId: before.organizationId,
      actor: options.actor,
      subjectType: 'ACCOUNT',
      subjectId: accountId,
      accountId,
      userId: before.userId,
      action: options.action,
      prevState: { status: before.status },
      newState: { status: after!.status },
      reason: options.reason ?? null,
    });

    await events.publish(scoped, {
      type: options.event,
      organizationId: before.organizationId,
      accountId,
      userId: before.userId,
      payload: { publicId: before.publicId, from: before.status, to: after!.status },
    });

    return after!;
  });
}

/** PENDING to ACTIVE: the account becomes tradeable for the first time. */
export async function activateAccount(
  db: Database,
  accountId: string,
  actor: Actor,
  reason?: string,
): Promise<AccountRow> {
  return transition(db, accountId, {
    actor,
    reason,
    action: 'account.activated',
    event: 'account.activated',
    allowedFrom: ['PENDING', 'DISABLED'],
    patch: { status: 'ACTIVE', adminHold: null, activatedAt: new Date(), failedReason: null },
  });
}

/**
 * Stop the account trading without ending it.
 *
 * Working orders are cancelled, because leaving them live on an account that
 * may not trade is a way to be surprised later. An open POSITION is left
 * alone: closing it is a trading decision with a P&L consequence, and an
 * administrator locking an account has not made that decision. The admin UI
 * says so, and the position can be flattened explicitly.
 */
export async function lockAccount(
  db: Database,
  accountId: string,
  actor: Actor,
  reason: string,
  execution?: ExecutionControl,
): Promise<AccountRow> {
  if (execution) await execution.cancelAll(accountId).catch(() => undefined);
  return transition(db, accountId, {
    actor,
    reason,
    action: 'admin.account.locked',
    event: 'account.locked',
    allowedFrom: ['ACTIVE', 'GOAL_REACHED', 'PENDING'],
    // The hold is what makes this stick: without it the next market event
    // would re-evaluate the rules and put the account straight back.
    patch: { status: 'LOCKED', adminHold: 'LOCKED' },
  });
}

export async function unlockAccount(
  db: Database,
  accountId: string,
  actor: Actor,
  reason?: string,
): Promise<AccountRow> {
  return transition(db, accountId, {
    actor,
    reason,
    action: 'admin.account.unlocked',
    event: 'account.unlocked',
    allowedFrom: ['LOCKED'],
    // Back to wherever the RULES say the account is, which is not necessarily
    // active: an account that failed while an operator held it stays failed.
    patch: { adminHold: null, lockedUntilDate: null },
    restoreRuleStatus: true,
  });
}

export async function disableAccount(
  db: Database,
  accountId: string,
  actor: Actor,
  reason: string,
  execution?: ExecutionControl,
): Promise<AccountRow> {
  if (execution) await execution.cancelAll(accountId).catch(() => undefined);
  return transition(db, accountId, {
    actor,
    reason,
    action: 'admin.account.disabled',
    event: 'account.disabled',
    allowedFrom: ['PENDING', 'ACTIVE', 'GOAL_REACHED', 'LOCKED', 'PASSED', 'FAILED'],
    patch: { status: 'DISABLED', adminHold: 'DISABLED' },
  });
}

export async function enableAccount(
  db: Database,
  accountId: string,
  actor: Actor,
  reason?: string,
): Promise<AccountRow> {
  return transition(db, accountId, {
    actor,
    reason,
    action: 'admin.account.enabled',
    event: 'account.enabled',
    allowedFrom: ['DISABLED'],
    patch: { adminHold: null },
    restoreRuleStatus: true,
  });
}

/**
 * Archive: the account is finished with.
 *
 * Its records stay exactly where they are. Archiving hides it from the
 * trader's selector and refuses new orders; it deletes nothing, because an
 * archived account's history is the reason the archive exists.
 */
export async function archiveAccount(
  db: Database,
  accountId: string,
  actor: Actor,
  reason: string,
  execution?: ExecutionControl,
): Promise<AccountRow> {
  if (execution) await execution.cancelAll(accountId).catch(() => undefined);
  const account = await load(db, accountId);
  await closeLifecycle(db, account, 'ARCHIVED');
  return transition(db, accountId, {
    actor,
    reason,
    action: 'admin.account.archived',
    event: 'account.archived',
    patch: { status: 'ARCHIVED', adminHold: 'ARCHIVED' },
  });
}

async function closeLifecycle(
  db: Database,
  account: AccountRow,
  endReason: 'RESET' | 'PASSED' | 'FAILED' | 'ARCHIVED',
): Promise<void> {
  if (!account.currentLifecycleId) return;
  await db
    .update(accountLifecycles)
    .set({
      endedAt: new Date(),
      endReason,
      finalBalanceMicros: account.balanceMicros,
      finalStatus: account.status,
    })
    .where(
      and(
        eq(accountLifecycles.id, account.currentLifecycleId),
        sql`${accountLifecycles.endedAt} is null`,
      ),
    );
}

export interface ResetOptions {
  readonly actor: Actor;
  readonly reason: string;
  /** Start the new life on a different product version. */
  readonly profileVersionId?: string | null;
  readonly startingBalanceMicros?: number;
  readonly execution?: ExecutionControl;
}

export interface ResetResult {
  readonly account: AccountRow;
  readonly previousLifecycleId: string | null;
  readonly lifecycleId: string;
  readonly lifecycleSeq: number;
}

/**
 * Reset an account.
 *
 * What a reset is NOT: a delete. The previous life is closed with its final
 * balance and status, and every order, fill, trade and daily statistic stays
 * exactly where it is, attributable to that life by its time window. An
 * administrator can still read what the trader did before the reset, which is
 * the whole point of keeping the record.
 *
 * What it is: working orders cancelled, positions closed through the ordinary
 * execution path, rule state returned to its starting point, and a new
 * lifecycle opened.
 *
 * If a position cannot be closed - the market is shut, the feed has no price -
 * the reset is REFUSED rather than completed by inventing a closing fill. A
 * fabricated exit price would corrupt the record the reset is meant to
 * preserve.
 */
export async function resetAccount(
  db: Database,
  accountId: string,
  options: ResetOptions,
): Promise<ResetResult> {
  const before = await load(db, accountId);

  if (options.execution) {
    await options.execution.cancelAll(accountId);

    const open = await db
      .select({ symbol: positions.symbol })
      .from(positions)
      .where(and(eq(positions.accountId, accountId), ne(positions.qty, 0)));

    for (const row of open) {
      try {
        await options.execution.flatten(accountId, before.userId, row.symbol);
      } catch (err) {
        throw new AccountActionError(
          'FLATTEN_FAILED',
          `${row.symbol} could not be closed, so the account was not reset: ${
            (err as Error).message
          }`,
        );
      }
    }

    if (await options.execution.openExposure(accountId)) {
      throw new AccountActionError(
        'ACCOUNT_NOT_FLAT',
        'The account still has exposure and cannot be reset. Try again when the market is open.',
      );
    }
  }

  const versionId = options.profileVersionId ?? before.profileVersionId;
  const profile = versionId ? await resolveProfileVersion(db, versionId) : null;
  const maxLossMicros = profile?.config.rules.maxLossMicros ?? 0;
  const startingBalance =
    options.startingBalanceMicros ??
    profile?.config.display.startingBalanceMicros ??
    profile?.config.rules.accountSizeMicros ??
    before.startingBalanceMicros;

  const result = await db.transaction(async (tx) => {
    // Serialize the reset's account rewrite against the engine and any other
    // operator action on this account, across processes.
    await tx.execute(accountAdvisoryLockSql(accountId));
    const [current] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).for('update');

    if (current!.currentLifecycleId) {
      await tx
        .update(accountLifecycles)
        .set({
          endedAt: new Date(),
          endReason: 'RESET',
          finalBalanceMicros: current!.balanceMicros,
          finalStatus: current!.status,
        })
        .where(
          and(
            eq(accountLifecycles.id, current!.currentLifecycleId),
            sql`${accountLifecycles.endedAt} is null`,
          ),
        );
    }

    const [highest] = await tx
      .select({ seq: sql<number>`coalesce(max(${accountLifecycles.seq}), 0)::int` })
      .from(accountLifecycles)
      .where(eq(accountLifecycles.accountId, accountId));
    const seq = highest?.seq ?? 0;

    const [lifecycle] = await tx
      .insert(accountLifecycles)
      .values({
        accountId,
        seq: seq + 1,
        profileVersionId: versionId ?? null,
        startingBalanceMicros: startingBalance,
      })
      .returning();

    const [account] = await tx
      .update(accounts)
      .set({
        status: 'ACTIVE',
        ruleStatus: 'ACTIVE',
        adminHold: null,
        profileVersionId: versionId ?? current!.profileVersionId,
        startingBalanceMicros: startingBalance,
        balanceMicros: startingBalance,
        realizedPnlMicros: 0,
        feesMicros: 0,
        highWaterMarkMicros: startingBalance,
        drawdownFloorMicros: startingBalance - maxLossMicros,
        dayStartBalanceMicros: startingBalance,
        dayStartEquityMicros: startingBalance,
        tradingDaysCount: 0,
        winningDaysCount: 0,
        bestDayProfitMicros: 0,
        lockedUntilDate: null,
        currentTradeDate: null,
        failedReason: null,
        currentLifecycleId: lifecycle!.id,
        activatedAt: current!.activatedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    return { account: account!, lifecycle: lifecycle!, previous: current!.currentLifecycleId };
  });

  await recordAudit(db, {
    organizationId: before.organizationId,
    actor: options.actor,
    subjectType: 'ACCOUNT',
    subjectId: accountId,
    accountId,
    userId: before.userId,
    action: 'account.reset',
    prevState: {
      status: before.status,
      balanceMicros: before.balanceMicros,
      tradingDaysCount: before.tradingDaysCount,
      lifecycleId: result.previous,
    },
    newState: {
      status: result.account.status,
      balanceMicros: result.account.balanceMicros,
      lifecycleId: result.lifecycle.id,
      lifecycleSeq: result.lifecycle.seq,
    },
    reason: options.reason,
  });

  await events.publish(db, {
    type: 'account.reset',
    organizationId: before.organizationId,
    accountId,
    userId: before.userId,
    payload: {
      publicId: before.publicId,
      previousLifecycleId: result.previous,
      lifecycleId: result.lifecycle.id,
      lifecycleSeq: result.lifecycle.seq,
      startingBalanceMicros: startingBalance,
    },
  });

  return {
    account: result.account,
    previousLifecycleId: result.previous,
    lifecycleId: result.lifecycle.id,
    lifecycleSeq: result.lifecycle.seq,
  };
}

/**
 * Record a terminal rule outcome the engine reached.
 *
 * The engine decides pass and fail; this closes the lifecycle and produces the
 * audit record and the event that everything downstream will hang off.
 */
export async function recordRuleOutcome(
  db: Database,
  accountId: string,
  outcome: 'PASSED' | 'FAILED',
  detail: { reason?: string | null } = {},
): Promise<void> {
  const account = await load(db, accountId);
  await closeLifecycle(db, account, outcome);
  await recordAudit(db, {
    organizationId: account.organizationId,
    actor: { type: 'SYSTEM', label: 'rule-engine' },
    subjectType: 'ACCOUNT',
    subjectId: accountId,
    accountId,
    userId: account.userId,
    action: outcome === 'PASSED' ? 'account.passed' : 'account.failed',
    newState: { status: outcome, balanceMicros: account.balanceMicros },
    reason: detail.reason ?? account.failedReason ?? null,
  });
  await events.publish(db, {
    type: outcome === 'PASSED' ? 'account.passed' : 'account.failed',
    organizationId: account.organizationId,
    accountId,
    userId: account.userId,
    payload: {
      publicId: account.publicId,
      balanceMicros: account.balanceMicros,
      reason: detail.reason ?? account.failedReason ?? null,
    },
  });
}

/** Working orders for an account, for the admin live view. */
export async function workingOrders(db: Database, accountId: string) {
  return db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.accountId, accountId),
        sql`${orders.status} in ('WORKING','ACCEPTED','PARTIALLY_FILLED','PENDING')`,
      ),
    );
}
