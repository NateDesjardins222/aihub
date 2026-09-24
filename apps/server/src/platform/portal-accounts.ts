/**
 * Customer-portal account service.
 *
 * The trader-facing view of a trader's own accounts, beside Atlas (the terminal
 * has its own /api/v1/accounts read). This surface adds the portal vocabulary
 * (docs/account-lifecycle-ux-v1.md §1), presentation-only nicknames, and archive
 * (hide) — none of which are authoritative. It NEVER creates account state and
 * NEVER frees an active slot: an ACTIVE evaluation or funded account cannot be
 * archived (that would be a back door around the five-active invariant); only a
 * terminal account can be hidden. Ownership is enforced on every call.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accountLifecycles, accountProfileVersions, accountProfiles, accounts } from '../db/schema.js';
import { recordAudit } from './audit.js';
import type { Actor } from './actor.js';

export const MAX_NICKNAME_LENGTH = 60;

/** The account statuses that consume an active slot (mirrors account-limit.ts). */
const ACTIVE_STATUSES = new Set(['ACTIVE', 'PENDING']);

export class PortalAccountError extends Error {
  constructor(
    readonly code: 'ACCOUNT_NOT_FOUND' | 'NICKNAME_TOO_LONG' | 'CANNOT_ARCHIVE_ACTIVE' | 'NOT_ARCHIVED',
    message: string,
  ) {
    super(message);
    this.name = 'PortalAccountError';
  }
}

/** The portal's lifecycle vocabulary. Derived from authoritative columns only. */
export type PortalState =
  | 'PENDING'
  | 'EVALUATION_ACTIVE'
  | 'EVALUATION_PASSED'
  | 'FUNDED_ACTIVE'
  | 'FAILED'
  | 'COMPLETED_MAX_PAYOUTS'
  | 'INACTIVE_CLOSED'
  | 'ARCHIVED';

type AccountRow = typeof accounts.$inferSelect;

/**
 * Map an account's authoritative (type, status, archivedAt) to the portal state.
 * Archived is a presentation overlay shown last so a hidden terminal account
 * still reads as ARCHIVED rather than its underlying terminal status.
 */
export function portalState(account: Pick<AccountRow, 'accountType' | 'status' | 'archivedAt'>): PortalState {
  if (account.archivedAt) return 'ARCHIVED';
  switch (account.status) {
    case 'PENDING':
      return 'PENDING';
    case 'PASSED':
      return 'EVALUATION_PASSED';
    case 'FAILED':
      return 'FAILED';
    case 'COMPLETED':
      return 'COMPLETED_MAX_PAYOUTS';
    case 'INACTIVE':
      return 'INACTIVE_CLOSED';
    case 'ACTIVE':
    default:
      return account.accountType === 'FUNDED_SIM' ? 'FUNDED_ACTIVE' : 'EVALUATION_ACTIVE';
  }
}

/** True when this account currently consumes one of the five active slots. */
export function consumesSlot(account: Pick<AccountRow, 'accountType' | 'status' | 'archivedAt'>): boolean {
  if (account.archivedAt) return false;
  if (account.accountType !== 'EVALUATION' && account.accountType !== 'FUNDED_SIM') return false;
  return ACTIVE_STATUSES.has(account.status);
}

async function ownedAccount(db: Database, userId: string, accountId: string): Promise<AccountRow> {
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));
  if (!row) throw new PortalAccountError('ACCOUNT_NOT_FOUND', 'No such account.');
  return row;
}

/**
 * Set (or clear, with null/empty) an account's nickname. Presentation-only: it
 * never touches the authoritative name, status or terms. Trimmed; bounded.
 */
export async function setAccountNickname(
  db: Database,
  userId: string,
  accountId: string,
  nickname: string | null,
): Promise<{ nickname: string | null }> {
  const trimmed = nickname?.trim() ?? '';
  if (trimmed.length > MAX_NICKNAME_LENGTH) {
    throw new PortalAccountError('NICKNAME_TOO_LONG', `A nickname is at most ${MAX_NICKNAME_LENGTH} characters.`);
  }
  await ownedAccount(db, userId, accountId);
  const value = trimmed.length === 0 ? null : trimmed;
  await db.update(accounts).set({ nickname: value }).where(eq(accounts.id, accountId));
  return { nickname: value };
}

/**
 * Hide a terminal account from the default portal view. Refuses an account that
 * still consumes a slot — archiving must never be a way to create a sixth active
 * account. Idempotent-ish: archiving an already-archived account just re-stamps.
 */
export async function archiveAccount(
  db: Database,
  userId: string,
  accountId: string,
  opts: { actor?: Actor } = {},
): Promise<void> {
  const account = await ownedAccount(db, userId, accountId);
  if (consumesSlot(account)) {
    throw new PortalAccountError(
      'CANNOT_ARCHIVE_ACTIVE',
      'An active account cannot be archived. Only a completed, failed or closed account can be hidden.',
    );
  }
  await db.update(accounts).set({ archivedAt: new Date() }).where(eq(accounts.id, accountId));
  await recordAudit(db, {
    organizationId: account.organizationId ?? '',
    actor: opts.actor ?? { type: 'USER', userId },
    subjectType: 'ACCOUNT',
    subjectId: accountId,
    accountId,
    userId,
    action: 'account.archived',
    newState: { archivedAt: new Date().toISOString() },
    reason: null,
  });
}

/** Un-hide an archived account. Only a terminal account was archivable, so this
 * never resurrects an active slot. */
export async function unarchiveAccount(
  db: Database,
  userId: string,
  accountId: string,
  opts: { actor?: Actor } = {},
): Promise<void> {
  const account = await ownedAccount(db, userId, accountId);
  if (!account.archivedAt) throw new PortalAccountError('NOT_ARCHIVED', 'That account is not archived.');
  await db.update(accounts).set({ archivedAt: null }).where(eq(accounts.id, accountId));
  await recordAudit(db, {
    organizationId: account.organizationId ?? '',
    actor: opts.actor ?? { type: 'USER', userId },
    subjectType: 'ACCOUNT',
    subjectId: accountId,
    accountId,
    userId,
    action: 'account.unarchived',
    newState: null,
    reason: null,
  });
}

export interface PortalAccountSummary {
  id: string;
  publicId: string;
  /** The authoritative product name (never overridden). */
  name: string;
  /** Presentation-only trader label, or null. */
  nickname: string | null;
  accountType: string;
  status: string;
  portalState: PortalState;
  consumesSlot: boolean;
  product: { key: string; name: string; version: number } | null;
  startingBalanceMicros: number;
  balanceMicros: number;
  highWaterMarkMicros: number;
  drawdownFloorMicros: number;
  /** The account this one replaced (a reset), if any. */
  resetOfAccountId: string | null;
  archivedAt: number | null;
  activatedAt: number | null;
  createdAt: number;
}

function toSummary(
  a: AccountRow,
  product: { key: string; name: string; version: number } | null,
): PortalAccountSummary {
  return {
    id: a.id,
    publicId: a.publicId,
    name: a.name,
    nickname: a.nickname ?? null,
    accountType: a.accountType,
    status: a.status,
    portalState: portalState(a),
    consumesSlot: consumesSlot(a),
    product,
    startingBalanceMicros: a.startingBalanceMicros,
    balanceMicros: a.balanceMicros,
    highWaterMarkMicros: a.highWaterMarkMicros,
    drawdownFloorMicros: a.drawdownFloorMicros,
    resetOfAccountId: a.resetOfAccountId ?? null,
    archivedAt: a.archivedAt?.getTime() ?? null,
    activatedAt: a.activatedAt?.getTime() ?? null,
    createdAt: a.createdAt.getTime(),
  };
}

export interface PortalAccountsView {
  accounts: PortalAccountSummary[];
  activeSlotsUsed: number;
  maxActiveSlots: number;
}

/**
 * A trader's accounts for the portal. Includes terminal accounts (History);
 * excludes archived unless asked. Practice accounts are excluded — the portal is
 * the funded-programme surface, not the terminal's practice sandbox.
 */
export async function listPortalAccounts(
  db: Database,
  userId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<PortalAccountsView> {
  const rows = await db
    .select({ account: accounts, profile: accountProfiles, version: accountProfileVersions })
    .from(accounts)
    .leftJoin(accountProfileVersions, eq(accounts.profileVersionId, accountProfileVersions.id))
    .leftJoin(accountProfiles, eq(accountProfileVersions.profileId, accountProfiles.id))
    .where(eq(accounts.userId, userId))
    .orderBy(desc(accounts.createdAt));

  const MAX_ACTIVE = 5;
  const summaries: PortalAccountSummary[] = [];
  let used = 0;
  for (const row of rows) {
    const a = row.account;
    if (a.accountType === 'PRACTICE') continue;
    if (consumesSlot(a)) used += 1;
    if (a.archivedAt && !opts.includeArchived) continue;
    summaries.push(
      toSummary(a, row.profile && row.version ? { key: row.profile.key, name: row.profile.name, version: row.version.version } : null),
    );
  }
  return { accounts: summaries, activeSlotsUsed: used, maxActiveSlots: MAX_ACTIVE };
}

export interface LifecycleHistoryEntry {
  seq: number;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  finalStatus: string | null;
  startingBalanceMicros: number;
}

export interface PortalAccountDetail extends PortalAccountSummary {
  realizedPnlMicros: number;
  feesMicros: number;
  priceMicros: number | null;
  lifecycles: LifecycleHistoryEntry[];
}

/** One account with its full lifecycle history (resets, breaches). Owner-scoped. */
export async function portalAccountDetail(
  db: Database,
  userId: string,
  accountId: string,
): Promise<PortalAccountDetail> {
  const [row] = await db
    .select({ account: accounts, profile: accountProfiles, version: accountProfileVersions })
    .from(accounts)
    .leftJoin(accountProfileVersions, eq(accounts.profileVersionId, accountProfileVersions.id))
    .leftJoin(accountProfiles, eq(accountProfileVersions.profileId, accountProfiles.id))
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));
  if (!row) throw new PortalAccountError('ACCOUNT_NOT_FOUND', 'No such account.');
  const a = row.account;

  const lifecycles = await db
    .select()
    .from(accountLifecycles)
    .where(eq(accountLifecycles.accountId, accountId))
    .orderBy(asc(accountLifecycles.seq));

  let priceMicros: number | null = null;
  if (row.version) {
    const cfg = row.version.config as { display?: { priceMicros?: number } } | null;
    priceMicros = cfg?.display?.priceMicros ?? null;
  }

  const summary = toSummary(
    a,
    row.profile && row.version ? { key: row.profile.key, name: row.profile.name, version: row.version.version } : null,
  );
  return {
    ...summary,
    realizedPnlMicros: a.realizedPnlMicros,
    feesMicros: a.feesMicros,
    priceMicros,
    lifecycles: lifecycles.map((l) => ({
      seq: l.seq,
      startedAt: l.startedAt.getTime(),
      endedAt: l.endedAt?.getTime() ?? null,
      endReason: l.endReason,
      finalStatus: l.finalStatus,
      startingBalanceMicros: l.startingBalanceMicros,
    })),
  };
}
