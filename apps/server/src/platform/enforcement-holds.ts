/**
 * Enforcement hold reads (Milestone 7). The narrow, side-effect-free query layer
 * that the hot paths (execution engine, payout engine, commerce checkout) consult
 * to decide whether a capability is currently held. Kept separate from the
 * mutating `enforcement.ts` service so the trading engine can import it without a
 * dependency cycle and without pulling in audit/notification machinery.
 *
 * A hold is effective when ACTIVE and not past its expiry (see enforcement-core).
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts, customerIdentities, enforcementHolds } from '../db/schema.js';
import { holdIsEffective, type HoldCapability } from './enforcement-core.js';

export type HoldRow = typeof enforcementHolds.$inferSelect;

export interface HoldSubject {
  readonly customerIdentityId?: string | null;
  readonly accountId?: string | null;
  readonly payoutRequestId?: string | null;
}

/** Resolve an account's owning customer identity (accounts → users → identity). */
export async function resolveAccountOwnerIdentity(
  db: Database,
  accountId: string,
): Promise<{ userId: string; customerIdentityId: string | null } | null> {
  const [acct] = await db.select({ userId: accounts.userId }).from(accounts).where(eq(accounts.id, accountId));
  if (!acct) return null;
  const [ident] = await db
    .select({ id: customerIdentities.id })
    .from(customerIdentities)
    .where(eq(customerIdentities.userId, acct.userId));
  return { userId: acct.userId, customerIdentityId: ident?.id ?? null };
}

/**
 * The effective holds for a subject, optionally filtered to one capability. Reads
 * ACTIVE holds whose scope/scopeId match any provided subject id, then applies the
 * expiry predicate in code (so an expired-but-not-swept hold never blocks).
 */
export async function activeHolds(
  db: Database,
  subject: HoldSubject,
  capability?: HoldCapability,
  nowMs: number = Date.now(),
): Promise<HoldRow[]> {
  const ids: string[] = [];
  if (subject.customerIdentityId) ids.push(subject.customerIdentityId);
  if (subject.accountId) ids.push(subject.accountId);
  if (subject.payoutRequestId) ids.push(subject.payoutRequestId);
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(enforcementHolds)
    .where(and(eq(enforcementHolds.status, 'ACTIVE'), inArray(enforcementHolds.scopeId, ids)));
  return rows.filter((h) => {
    if (!holdIsEffective(h, nowMs)) return false;
    if (capability && h.capability !== capability) return false;
    // Guard the scope/scopeId pairing so an accountId can't match a CUSTOMER hold, etc.
    if (h.scope === 'ACCOUNT') return subject.accountId != null && h.scopeId === subject.accountId;
    if (h.scope === 'CUSTOMER' || h.scope === 'COMMERCE') return subject.customerIdentityId != null && h.scopeId === subject.customerIdentityId;
    if (h.scope === 'PAYOUT') return subject.payoutRequestId != null && h.scopeId === subject.payoutRequestId;
    return false;
  });
}

/** The first effective hold blocking `capability` for the subject, or null. */
export async function holdBlocking(
  db: Database,
  subject: HoldSubject,
  capability: HoldCapability,
  nowMs: number = Date.now(),
): Promise<HoldRow | null> {
  const rows = await activeHolds(db, subject, capability, nowMs);
  return rows[0] ?? null;
}

/**
 * Trading-hold check for an account. Resolves the account's owner so a CUSTOMER
 * hold and an ACCOUNT hold both apply. Returns the blocking hold or null. The
 * CALLER is responsible for the reduce-only carve-out (only call this for the
 * exposure-increasing portion) — mirrors the personal-risk gate.
 */
export async function tradingHoldForAccount(
  db: Database,
  accountId: string,
  nowMs: number = Date.now(),
): Promise<HoldRow | null> {
  const owner = await resolveAccountOwnerIdentity(db, accountId);
  return holdBlocking(db, { accountId, customerIdentityId: owner?.customerIdentityId ?? null }, 'TRADING', nowMs);
}
