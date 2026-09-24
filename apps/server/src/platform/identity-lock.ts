/**
 * The customer-identity mutation lock — one identity, serialized across processes.
 *
 * The same argument as `trading/account-lock.ts`: an in-process mutex protects a
 * single Node process, but two processes each handling a provider event for the
 * same identity can both read the same `identity_status` and both decide the
 * transition. This layers a PostgreSQL transaction-scoped advisory lock keyed by
 * identity id under every identity state change.
 *
 * It uses the two-int `pg_advisory_xact_lock(classid, objid)` form with a
 * DISTINCT classid from the account lock (`ACLK`) and from the single-argument
 * form `recordAudit` uses, so an identity lock can never be mistaken for, or
 * collide with, an account lock or the audit chain lock.
 */
import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';

/** A fixed namespace for identity locks (ASCII "IDLK" as a signed int32). */
const CLASSID = 0x49444c4b | 0; // 1229277259, fits int32

/** A stable signed 31-bit objid for an identity id. Deterministic across processes. */
export function identityObjId(identityId: string): number {
  const digest = createHash('sha256').update(identityId).digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}

/** The SQL fragment that takes the transaction-scoped identity lock. Use inside a db.transaction. */
export function identityAdvisoryLockSql(identityId: string): SQL {
  return sql`select pg_advisory_xact_lock(${CLASSID}, ${identityObjId(identityId)})`;
}
