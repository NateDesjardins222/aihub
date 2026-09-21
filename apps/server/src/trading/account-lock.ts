/**
 * The account mutation lock — the same account, serialized across processes.
 *
 * Atlas serialized every account mutation through an in-process `KeyedMutex`.
 * That protects one Node process: two market events microseconds apart cannot
 * both read the same position and both decide the stop fills. It does NOT
 * protect Server A from Server B. The moment Atlas runs more than one process,
 * the in-memory lock guards nothing shared, and two processes can double-fill
 * one account.
 *
 * This layers a PostgreSQL advisory lock under the in-process mutex, keyed by
 * account. The advisory lock is held by a database SESSION, so two independent
 * processes (two independent connections) contend on it correctly. The
 * in-process mutex stays as the fast path: same-process, same-account contention
 * never pays a database round trip.
 *
 * Two forms of the same lock key are used so that the trading engine and the
 * account-service lifecycle both serialize against each other:
 *   - the engine holds it SESSION-level (its critical section spans several
 *     statements that are not one transaction), via `withAccountAdvisoryLock`;
 *   - account-service holds it TRANSACTION-level inside its own transaction, via
 *     `accountAdvisoryLockSql`.
 * Both use the two-int `pg_advisory_lock(classid, objid)` form with the same
 * key, so they block each other. That form is a distinct lock space from the
 * single-argument form `recordAudit` uses for the audit chain, so the two never
 * collide.
 */
import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type postgres from 'postgres';
import { KeyedMutex } from './mutex.js';

/**
 * A fixed namespace for account locks (ASCII "ACLK" as a signed int32), so an
 * account's objid can never be mistaken for another subsystem's advisory lock.
 */
const CLASSID = 0x41434c4b | 0; // 1094929483, fits int32

/** A stable signed 31-bit objid for an account id. Deterministic across processes. */
export function advisoryObjId(accountId: string): number {
  const digest = createHash('sha256').update(accountId).digest();
  // Top 31 bits keep it non-negative and well inside int32.
  return digest.readUInt32BE(0) & 0x7fffffff;
}

/** The SQL fragment that takes the transaction-scoped account lock. For use inside a db.transaction. */
export function accountAdvisoryLockSql(accountId: string): SQL {
  return sql`select pg_advisory_xact_lock(${CLASSID}, ${advisoryObjId(accountId)})`;
}

/**
 * Run `fn` while holding the SESSION-level advisory lock for `accountId` on a
 * reserved connection. Always releases the lock and the connection, even when
 * `fn` throws, so one failed order can never wedge an account across processes.
 */
export async function withAccountAdvisoryLock<T>(
  pg: postgres.Sql,
  accountId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const objid = advisoryObjId(accountId);
  const conn = await pg.reserve();
  try {
    await conn`select pg_advisory_lock(${CLASSID}, ${objid})`;
    try {
      return await fn();
    } finally {
      // Best-effort release; the session ending would release it anyway, but a
      // reserved connection returns to the pool, so we must not leave it held.
      await conn`select pg_advisory_unlock(${CLASSID}, ${objid})`.catch(() => undefined);
    }
  } finally {
    conn.release();
  }
}

/**
 * A drop-in superset of `KeyedMutex` that also takes the cross-process account
 * lock when a postgres connection is supplied. With no connection it is exactly
 * the in-process mutex (used by unit tests, which are single-process by nature).
 */
export class AccountLock {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly pg?: postgres.Sql) {}

  get activeKeys(): number {
    return this.mutex.activeKeys;
  }

  depthOf(key: string): number {
    return this.mutex.depthOf(key);
  }

  run<T>(accountId: string, task: () => Promise<T>): Promise<T> {
    if (!this.pg) return this.mutex.run(accountId, task);
    // In-process first (cheap, coalesces same-process contention), then the
    // durable cross-process lock around the actual work.
    return this.mutex.run(accountId, () => withAccountAdvisoryLock(this.pg!, accountId, task));
  }
}
