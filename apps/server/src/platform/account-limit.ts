/**
 * The five-active-account invariant — a server-side transactional guard.
 *
 * A verified trader may have at most FIVE ACTIVE accounts total (evaluation +
 * funded combined). "Active" = an EVALUATION or FUNDED_SIM account that is still
 * trade-capable (status ACTIVE or PENDING, not archived). Terminal states
 * (PASSED-frozen, FAILED, COMPLETED, INACTIVE-CLOSED, ARCHIVED) do not consume a
 * slot — which is exactly why a pass→funded transition preserves the slot: the
 * evaluation is frozen PASSED before the funded account is created.
 *
 * Enforced inside the account-creation transaction under a per-user advisory
 * lock, so simultaneous purchases at 4 (and simultaneous pass/provisioning)
 * cannot produce a sixth.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts } from '../db/schema.js';

export const MAX_ACTIVE_ACCOUNTS = 5;

const ACTIVE_TYPES = ['EVALUATION', 'FUNDED_SIM'];
const ACTIVE_STATUSES = ['ACTIVE', 'PENDING'];

export class AccountLimitError extends Error {
  constructor(readonly current: number) {
    super(`Active account limit reached (${current}/${MAX_ACTIVE_ACCOUNTS}).`);
    this.name = 'AccountLimitError';
  }
}

/** A per-user advisory lock (ASCII "USLK"), distinct from account/identity locks. */
const USER_CLASSID = 0x55534c4b | 0;
function userObjId(userId: string): number {
  return createHash('sha256').update(userId).digest().readUInt32BE(0) & 0x7fffffff;
}
export function userAdvisoryLockSql(userId: string) {
  return sql`select pg_advisory_xact_lock(${USER_CLASSID}, ${userObjId(userId)})`;
}

/** Count a user's active (slot-consuming) accounts. Read-only. */
export async function countActiveAccounts(db: Database, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        inArray(accounts.accountType, ACTIVE_TYPES),
        inArray(accounts.status, ACTIVE_STATUSES),
        sql`${accounts.archivedAt} is null`,
      ),
    );
  return row?.n ?? 0;
}

/**
 * Inside a transaction that is about to create an account: take the user lock and
 * refuse if the trader is already at the limit. `tx` must be the active
 * transaction (so the lock is held until commit and the count is consistent).
 */
export async function assertActiveSlotAvailable(
  tx: Database,
  userId: string,
): Promise<void> {
  await tx.execute(userAdvisoryLockSql(userId));
  const current = await countActiveAccounts(tx, userId);
  if (current >= MAX_ACTIVE_ACCOUNTS) throw new AccountLimitError(current);
}
