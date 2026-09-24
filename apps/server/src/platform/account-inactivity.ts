/**
 * Funded-account calendar-month inactivity closure
 * (docs/account-lifecycle-ux-v1.md §4).
 *
 * A funded account must record qualifying trading activity within each calendar
 * month (exchange timezone, America/Chicago). "Qualifying activity" = at least one
 * `trades` row whose `tradeDate` falls in that month. When a calendar month
 * completes with none, the account transitions to INACTIVE — CLOSED (terminal,
 * never silently deleted, preserved in History). A deterministic warning fires
 * near the end of a month with no activity yet. Idempotent: an already-closed
 * account is skipped, and warnings are deduped per (account, month).
 *
 * Reuses the existing audit, events and notification infrastructure — it invents
 * no new money or trading math.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accountLifecycles, accounts, customerIdentities, trades } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { enqueueNotification } from './notifications.js';
import type { Actor } from './actor.js';

const EXCHANGE_TZ = 'America/Chicago';

/** 'YYYY-MM' for an instant in the exchange timezone. Lexicographically ordered. */
export function exchangeMonthKey(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EXCHANGE_TZ,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at);
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const month = parts.find((p) => p.type === 'month')?.value ?? '00';
  return `${year}-${month}`;
}

/** 'YYYY-MM-DD' for an instant in the exchange timezone. */
function exchangeDateKey(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: EXCHANGE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** The calendar month immediately before the given instant's exchange month. */
export function previousMonthKey(at: Date): string {
  const [y, m] = exchangeMonthKey(at).split('-').map((s) => Number(s));
  const prev = m === 1 ? { y: y! - 1, m: 12 } : { y: y!, m: m! - 1 };
  return `${prev.y}-${String(prev.m).padStart(2, '0')}`;
}

/** Days remaining in the current exchange calendar month (inclusive of today). */
function daysRemainingInMonth(at: Date): number {
  const [y, m] = exchangeMonthKey(at).split('-').map((s) => Number(s));
  const day = Number(exchangeDateKey(at).slice(-2));
  const daysInMonth = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return daysInMonth - day;
}

/** True when the account has ≥1 trade with tradeDate in the given 'YYYY-MM' month. */
async function hasActivityInMonth(db: Database, accountId: string, monthKey: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(trades)
    .where(and(eq(trades.accountId, accountId), sql`to_char(${trades.tradeDate}, 'YYYY-MM') = ${monthKey}`));
  return (row?.n ?? 0) > 0;
}

async function identityIdForUser(db: Database, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: customerIdentities.id })
    .from(customerIdentities)
    .where(eq(customerIdentities.userId, userId));
  return row?.id ?? null;
}

export interface InactivitySweepResult {
  closed: number;
  warned: number;
}

/**
 * Close funded accounts that completed a calendar month with no qualifying
 * activity, and warn those at risk in the current month. `now` is injectable for
 * deterministic testing. `warnDaysBeforeMonthEnd` controls the warning window.
 */
export async function runInactivitySweep(
  db: Database,
  opts: { now?: Date; warnDaysBeforeMonthEnd?: number; actor?: Actor } = {},
): Promise<InactivitySweepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? { type: 'SYSTEM', label: 'inactivity-sweep' };
  const warnDays = opts.warnDaysBeforeMonthEnd ?? 5;
  const currentMonth = exchangeMonthKey(now);
  const checkMonth = previousMonthKey(now);

  const funded = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.accountType, 'FUNDED_SIM'), eq(accounts.status, 'ACTIVE')));

  let closed = 0;
  let warned = 0;
  for (const account of funded) {
    if (!account.activatedAt) continue;
    const activationMonth = exchangeMonthKey(account.activatedAt);

    // Closure: the account must have been active for the entire completed month
    // (activated strictly before it — the activation month is a grace month) and
    // recorded no qualifying activity in it.
    if (activationMonth < checkMonth) {
      const active = await hasActivityInMonth(db, account.id, checkMonth);
      if (!active) {
        const didClose = await closeAccount(db, account, checkMonth, actor);
        if (didClose) closed += 1;
        continue; // closed; no warning needed
      }
    }

    // Warning: near the end of the current month, active before it began, no
    // qualifying activity yet. Deduped per (account, current month).
    if (activationMonth < currentMonth && daysRemainingInMonth(now) <= warnDays) {
      const activeNow = await hasActivityInMonth(db, account.id, currentMonth);
      if (!activeNow) {
        const identityId = await identityIdForUser(db, account.userId);
        const n = await enqueueNotification(db, {
          organizationId: account.organizationId ?? '',
          customerIdentityId: identityId,
          type: 'ACCOUNT_INACTIVITY_WARNING',
          subjectKey: `${account.id}:${currentMonth}`,
          data: { accountId: account.id, publicId: account.publicId, month: currentMonth },
        });
        if (n > 0) {
          warned += 1;
          await events.publish(db, {
            type: 'account.inactivity_warning',
            organizationId: account.organizationId,
            accountId: account.id,
            userId: account.userId,
            payload: { month: currentMonth },
          });
        }
      }
    }
  }
  return { closed, warned };
}

/**
 * Transition one funded account to INACTIVE — CLOSED, ending its current
 * lifecycle. Guarded so a concurrent sweep or a status that has already moved
 * cannot double-close. Returns true only when this call performed the closure.
 */
async function closeAccount(
  db: Database,
  account: typeof accounts.$inferSelect,
  monthKey: string,
  actor: Actor,
): Promise<boolean> {
  const performed = await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    // Re-read under lock and guard on ACTIVE, so exactly one closer wins.
    const [fresh] = await tx.select().from(accounts).where(eq(accounts.id, account.id)).for('update');
    if (!fresh || fresh.status !== 'ACTIVE') return false;

    await tx
      .update(accounts)
      .set({ status: 'INACTIVE', adminHold: 'INACTIVE' })
      .where(and(eq(accounts.id, account.id), eq(accounts.status, 'ACTIVE')));

    if (fresh.currentLifecycleId) {
      await tx
        .update(accountLifecycles)
        .set({ endedAt: new Date(), endReason: 'INACTIVITY', finalStatus: 'INACTIVE' })
        .where(and(eq(accountLifecycles.id, fresh.currentLifecycleId), sql`${accountLifecycles.endedAt} is null`));
    }

    await recordAudit(scoped, {
      organizationId: fresh.organizationId ?? '',
      actor,
      subjectType: 'ACCOUNT',
      subjectId: fresh.id,
      accountId: fresh.id,
      userId: fresh.userId,
      action: 'account.inactivity_closed',
      prevState: { status: 'ACTIVE' },
      newState: { status: 'INACTIVE', month: monthKey },
      reason: null,
    });
    await events.publish(scoped, {
      type: 'account.inactivity_closed',
      organizationId: fresh.organizationId,
      accountId: fresh.id,
      userId: fresh.userId,
      payload: { month: monthKey, publicId: fresh.publicId },
    });
    return true;
  });

  if (performed) {
    // Notify outside the closing transaction (a bystander; a failure here never
    // un-closes the account).
    const identityId = await identityIdForUser(db, account.userId);
    await enqueueNotification(db, {
      organizationId: account.organizationId ?? '',
      customerIdentityId: identityId,
      type: 'ACCOUNT_INACTIVITY_CLOSED',
      subjectKey: `${account.id}:${monthKey}`,
      data: { accountId: account.id, publicId: account.publicId, month: monthKey },
    }).catch(() => 0);
  }
  return performed;
}
