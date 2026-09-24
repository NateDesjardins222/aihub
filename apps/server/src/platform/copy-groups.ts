/**
 * Copy-group domain service — create/read/update copy groups and their
 * followers, all owner-scoped and server-authoritative
 * (docs/copy-trading-v1.md §2–7). This module owns ownership checks, topology
 * (one leader → ≤4 followers, no loops/chains), eligibility, and lifecycle
 * transitions. It never executes trades — that is the orchestrator (CT-E).
 *
 * The platform five-active-account invariant is reused, not re-implemented: a
 * group can only ever reference the trader's own active accounts, of which there
 * can never be more than five.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts, copyFollowers, copyGroups } from '../db/schema.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { defaultOrganizationId } from './provisioning.js';
import { validateFollowerSizing, type SizingMode } from './copy-sizing.js';
import type { Actor } from './actor.js';

export const MAX_FOLLOWERS = 4;

/** Account states that may participate in copy trading (mirror the risk gate). */
const TRADE_CAPABLE_STATUSES = new Set(['ACTIVE', 'GOAL_REACHED']);
const PARTICIPATING_TYPES = new Set(['EVALUATION', 'FUNDED_SIM']);

export class CopyGroupError extends Error {
  constructor(
    readonly code:
      | 'GROUP_NOT_FOUND'
      | 'ACCOUNT_NOT_FOUND'
      | 'NOT_OWNED'
      | 'INELIGIBLE_ACCOUNT'
      | 'ACCOUNT_IN_USE'
      | 'DUPLICATE_FOLLOWER'
      | 'TOO_MANY_FOLLOWERS'
      | 'LEADER_IS_FOLLOWER'
      | 'INVALID_SIZING'
      | 'INVALID_STATE'
      | 'VERSION_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'CopyGroupError';
  }
}

export type AccountEligibility =
  | { eligible: true }
  | { eligible: false; reason: string };

type AccountRow = typeof accounts.$inferSelect;

/** Is this account (already loaded) trade-capable for copy participation? */
export function accountTradeCapable(a: Pick<AccountRow, 'accountType' | 'status' | 'adminHold' | 'archivedAt'>): AccountEligibility {
  if (!PARTICIPATING_TYPES.has(a.accountType)) return { eligible: false, reason: 'Only evaluation and funded accounts can copy.' };
  if (a.archivedAt) return { eligible: false, reason: 'Account is archived.' };
  if (a.adminHold) return { eligible: false, reason: `Account is on hold (${a.adminHold}).` };
  if (!TRADE_CAPABLE_STATUSES.has(a.status)) return { eligible: false, reason: `Account is not tradeable (${a.status}).` };
  return { eligible: true };
}

/** Load an account and assert the caller owns it. Throws NOT_OWNED / ACCOUNT_NOT_FOUND. */
async function ownedAccount(db: Database, userId: string, accountId: string): Promise<AccountRow> {
  const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!a || a.userId !== userId) throw new CopyGroupError('ACCOUNT_NOT_FOUND', 'No such account.');
  return a;
}

/**
 * Assert an account is not already committed to another non-disabled group in
 * either role (loop / chain prevention). `exceptGroupId` allows re-checks within
 * the same group.
 */
async function assertAccountFree(db: Database, accountId: string, exceptGroupId: string | null): Promise<void> {
  const leaderConds = [eq(copyGroups.leaderAccountId, accountId), ne(copyGroups.status, 'DISABLED')];
  if (exceptGroupId) leaderConds.push(ne(copyGroups.id, exceptGroupId));
  const [leadRow] = await db.select({ id: copyGroups.id }).from(copyGroups).where(and(...leaderConds));
  if (leadRow) throw new CopyGroupError('ACCOUNT_IN_USE', 'That account already leads a copy group.');

  const followConds = [
    eq(copyFollowers.accountId, accountId),
    ne(copyGroups.status, 'DISABLED'),
  ];
  if (exceptGroupId) followConds.push(ne(copyGroups.id, exceptGroupId));
  const [folRow] = await db
    .select({ id: copyFollowers.id })
    .from(copyFollowers)
    .innerJoin(copyGroups, eq(copyFollowers.copyGroupId, copyGroups.id))
    .where(and(...followConds));
  if (folRow) throw new CopyGroupError('ACCOUNT_IN_USE', 'That account already follows in a copy group.');
}

export interface EligibleAccount {
  id: string;
  publicId: string;
  name: string;
  nickname: string | null;
  accountType: string;
  status: string;
  eligible: boolean;
  reason: string | null;
}

/** The trader's copy-participatable accounts, each flagged eligible or not. */
export async function listEligibleAccounts(db: Database, userId: string): Promise<EligibleAccount[]> {
  const rows = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), inArray(accounts.accountType, ['EVALUATION', 'FUNDED_SIM'])));
  return rows
    .filter((a) => !a.archivedAt)
    .map((a) => {
      const e = accountTradeCapable(a);
      return {
        id: a.id,
        publicId: a.publicId,
        name: a.name,
        nickname: a.nickname ?? null,
        accountType: a.accountType,
        status: a.status,
        eligible: e.eligible,
        reason: e.eligible ? null : e.reason,
      };
    });
}

async function actorFor(userId: string): Promise<Actor> {
  return { type: 'USER', userId };
}

export interface CreateGroupInput {
  userId: string;
  name: string;
  leaderAccountId: string;
  sizingMode?: SizingMode;
  organizationId?: string;
}

export async function createGroup(db: Database, input: CreateGroupInput): Promise<string> {
  const organizationId = input.organizationId ?? (await defaultOrganizationId(db));
  const leader = await ownedAccount(db, input.userId, input.leaderAccountId);
  const elig = accountTradeCapable(leader);
  if (!elig.eligible) throw new CopyGroupError('INELIGIBLE_ACCOUNT', `Leader ineligible: ${elig.reason}`);
  const identity = await ensureCustomerIdentity(db, { organizationId, userId: input.userId });

  const groupId = await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    await assertAccountFree(scoped, input.leaderAccountId, null);
    const [group] = await tx
      .insert(copyGroups)
      .values({
        organizationId,
        customerIdentityId: identity.id,
        userId: input.userId,
        name: input.name.trim().slice(0, 80) || 'Copy group',
        leaderAccountId: input.leaderAccountId,
        sizingMode: input.sizingMode ?? 'SAME',
        status: 'ACTIVE',
      })
      .returning();
    return group!.id;
  });

  await recordAudit(db, {
    organizationId,
    actor: await actorFor(input.userId),
    subjectType: 'ACCOUNT',
    subjectId: input.leaderAccountId,
    accountId: input.leaderAccountId,
    userId: input.userId,
    action: 'copy.group.created',
    newState: { groupId, leaderAccountId: input.leaderAccountId, sizingMode: input.sizingMode ?? 'SAME' },
    reason: null,
  });
  await events.publish(db, {
    type: 'copy.group.created',
    organizationId,
    userId: input.userId,
    accountId: input.leaderAccountId,
    payload: { groupId },
  });
  return groupId;
}

/** Load a group the caller owns, or throw. */
export async function ownedGroup(db: Database, userId: string, groupId: string) {
  const [g] = await db.select().from(copyGroups).where(eq(copyGroups.id, groupId));
  if (!g || g.userId !== userId) throw new CopyGroupError('GROUP_NOT_FOUND', 'No such copy group.');
  return g;
}

export interface AddFollowerInput {
  userId: string;
  groupId: string;
  accountId: string;
  sizingMultiplierMilli?: number | null;
  sizingFixedQty?: number | null;
}

export async function addFollower(db: Database, input: AddFollowerInput): Promise<string> {
  const group = await ownedGroup(db, input.userId, input.groupId);
  if (group.status === 'DISABLED') throw new CopyGroupError('INVALID_STATE', 'Group is disabled.');
  const account = await ownedAccount(db, input.userId, input.accountId);
  if (account.id === group.leaderAccountId) throw new CopyGroupError('LEADER_IS_FOLLOWER', 'The leader cannot also be a follower.');
  const elig = accountTradeCapable(account);
  if (!elig.eligible) throw new CopyGroupError('INELIGIBLE_ACCOUNT', `Follower ineligible: ${elig.reason}`);
  const sizingErr = validateFollowerSizing({
    mode: group.sizingMode as SizingMode,
    multiplierMilli: input.sizingMultiplierMilli,
    fixedQty: input.sizingFixedQty,
  });
  if (sizingErr) throw new CopyGroupError('INVALID_SIZING', sizingErr);

  const followerId = await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    await assertAccountFree(scoped, input.accountId, input.groupId);
    const [countRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(copyFollowers)
      .where(eq(copyFollowers.copyGroupId, input.groupId));
    if ((countRow?.n ?? 0) >= MAX_FOLLOWERS) throw new CopyGroupError('TOO_MANY_FOLLOWERS', `A group may have at most ${MAX_FOLLOWERS} followers.`);
    const [row] = await tx
      .insert(copyFollowers)
      .values({
        copyGroupId: input.groupId,
        accountId: input.accountId,
        enabled: true,
        sizingMultiplierMilli: input.sizingMultiplierMilli ?? null,
        sizingFixedQty: input.sizingFixedQty ?? null,
      })
      .onConflictDoNothing({ target: [copyFollowers.copyGroupId, copyFollowers.accountId] })
      .returning();
    if (!row) throw new CopyGroupError('DUPLICATE_FOLLOWER', 'That account is already a follower.');
    await tx.update(copyGroups).set({ updatedAt: new Date(), version: group.version + 1 }).where(eq(copyGroups.id, input.groupId));
    return row.id;
  });

  await recordAudit(db, {
    organizationId: group.organizationId,
    actor: await actorFor(input.userId),
    subjectType: 'ACCOUNT',
    subjectId: input.accountId,
    accountId: input.accountId,
    userId: input.userId,
    action: 'copy.follower.added',
    newState: { groupId: input.groupId, accountId: input.accountId },
    reason: null,
  });
  return followerId;
}

export async function updateFollower(
  db: Database,
  input: { userId: string; groupId: string; accountId: string; enabled?: boolean; sizingMultiplierMilli?: number | null; sizingFixedQty?: number | null },
): Promise<void> {
  const group = await ownedGroup(db, input.userId, input.groupId);
  if (input.sizingMultiplierMilli !== undefined || input.sizingFixedQty !== undefined) {
    const err = validateFollowerSizing({ mode: group.sizingMode as SizingMode, multiplierMilli: input.sizingMultiplierMilli, fixedQty: input.sizingFixedQty });
    if (err) throw new CopyGroupError('INVALID_SIZING', err);
  }
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.enabled !== undefined) patch['enabled'] = input.enabled;
  if (input.sizingMultiplierMilli !== undefined) patch['sizingMultiplierMilli'] = input.sizingMultiplierMilli;
  if (input.sizingFixedQty !== undefined) patch['sizingFixedQty'] = input.sizingFixedQty;
  const res = await db
    .update(copyFollowers)
    .set(patch as never)
    .where(and(eq(copyFollowers.copyGroupId, input.groupId), eq(copyFollowers.accountId, input.accountId)))
    .returning({ id: copyFollowers.id });
  if (res.length === 0) throw new CopyGroupError('ACCOUNT_NOT_FOUND', 'That account is not a follower of this group.');
}

export async function removeFollower(db: Database, userId: string, groupId: string, accountId: string): Promise<void> {
  await ownedGroup(db, userId, groupId);
  await db.delete(copyFollowers).where(and(eq(copyFollowers.copyGroupId, groupId), eq(copyFollowers.accountId, accountId)));
}

/** Change the leader. The new leader must be owned, eligible, and free. */
export async function setLeader(db: Database, userId: string, groupId: string, leaderAccountId: string): Promise<void> {
  const group = await ownedGroup(db, userId, groupId);
  const account = await ownedAccount(db, userId, leaderAccountId);
  const elig = accountTradeCapable(account);
  if (!elig.eligible) throw new CopyGroupError('INELIGIBLE_ACCOUNT', `Leader ineligible: ${elig.reason}`);
  await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    // The new leader may currently be a follower of THIS group; block that.
    const [fol] = await tx.select({ id: copyFollowers.id }).from(copyFollowers).where(and(eq(copyFollowers.copyGroupId, groupId), eq(copyFollowers.accountId, leaderAccountId)));
    if (fol) throw new CopyGroupError('LEADER_IS_FOLLOWER', 'That account is a follower of this group; remove it first.');
    await assertAccountFree(scoped, leaderAccountId, groupId);
    await tx.update(copyGroups).set({ leaderAccountId, status: group.status === 'PAUSED' ? 'PAUSED' : group.status, updatedAt: new Date(), version: group.version + 1 }).where(eq(copyGroups.id, groupId));
  });
  await recordAudit(db, {
    organizationId: group.organizationId,
    actor: await actorFor(userId),
    subjectType: 'ACCOUNT',
    subjectId: leaderAccountId,
    accountId: leaderAccountId,
    userId,
    action: 'copy.group.leader_changed',
    newState: { groupId, leaderAccountId },
    reason: null,
  });
}

export async function setSizingMode(db: Database, userId: string, groupId: string, sizingMode: SizingMode): Promise<void> {
  const group = await ownedGroup(db, userId, groupId);
  await db.update(copyGroups).set({ sizingMode, updatedAt: new Date(), version: group.version + 1 }).where(eq(copyGroups.id, groupId));
}

export async function renameGroup(db: Database, userId: string, groupId: string, name: string): Promise<void> {
  const group = await ownedGroup(db, userId, groupId);
  await db.update(copyGroups).set({ name: name.trim().slice(0, 80) || group.name, updatedAt: new Date() }).where(eq(copyGroups.id, groupId));
}

async function transition(db: Database, userId: string, groupId: string, status: 'ACTIVE' | 'PAUSED' | 'DISABLED', action: string, reason: string | null): Promise<void> {
  const group = await ownedGroup(db, userId, groupId);
  await db.update(copyGroups).set({ status, updatedAt: new Date(), version: group.version + 1 }).where(eq(copyGroups.id, groupId));
  await recordAudit(db, {
    organizationId: group.organizationId,
    actor: await actorFor(userId),
    subjectType: 'ACCOUNT',
    subjectId: group.leaderAccountId ?? groupId,
    accountId: group.leaderAccountId,
    userId,
    action,
    prevState: { status: group.status },
    newState: { status },
    reason,
  });
  await events.publish(db, {
    type: status === 'ACTIVE' ? 'copy.group.resumed' : status === 'PAUSED' ? 'copy.group.paused' : 'copy.group.disabled',
    organizationId: group.organizationId,
    userId,
    accountId: group.leaderAccountId,
    payload: { groupId, reason },
  });
}

/** Pause: stop new copy intents. Never flattens or cancels. */
export async function pauseGroup(db: Database, userId: string, groupId: string, reason: string | null = null): Promise<void> {
  return transition(db, userId, groupId, 'PAUSED', 'copy.group.paused', reason);
}

/** Resume: re-validate leader + followers before re-activating. */
export async function resumeGroup(db: Database, userId: string, groupId: string): Promise<void> {
  const group = await ownedGroup(db, userId, groupId);
  if (!group.leaderAccountId) throw new CopyGroupError('INVALID_STATE', 'The group has no eligible leader; choose one first.');
  const leader = await ownedAccount(db, userId, group.leaderAccountId);
  const elig = accountTradeCapable(leader);
  if (!elig.eligible) throw new CopyGroupError('INELIGIBLE_ACCOUNT', `Leader ineligible: ${elig.reason}`);
  return transition(db, userId, groupId, 'ACTIVE', 'copy.group.resumed', null);
}

export async function disableGroup(db: Database, userId: string, groupId: string): Promise<void> {
  return transition(db, userId, groupId, 'DISABLED', 'copy.group.disabled', null);
}

export interface GroupFollowerView {
  accountId: string;
  publicId: string;
  name: string;
  nickname: string | null;
  accountType: string;
  status: string;
  enabled: boolean;
  eligible: boolean;
  reason: string | null;
  sizingMultiplierMilli: number | null;
  sizingFixedQty: number | null;
}

export interface GroupView {
  id: string;
  name: string;
  status: string;
  sizingMode: string;
  version: number;
  leader: { accountId: string; publicId: string; name: string; nickname: string | null; accountType: string; status: string; eligible: boolean } | null;
  followers: GroupFollowerView[];
  createdAt: number;
  updatedAt: number;
}

async function buildGroupView(db: Database, group: typeof copyGroups.$inferSelect): Promise<GroupView> {
  let leader: GroupView['leader'] = null;
  if (group.leaderAccountId) {
    const [a] = await db.select().from(accounts).where(eq(accounts.id, group.leaderAccountId));
    if (a) leader = { accountId: a.id, publicId: a.publicId, name: a.name, nickname: a.nickname ?? null, accountType: a.accountType, status: a.status, eligible: accountTradeCapable(a).eligible };
  }
  const folRows = await db
    .select({ f: copyFollowers, a: accounts })
    .from(copyFollowers)
    .innerJoin(accounts, eq(copyFollowers.accountId, accounts.id))
    .where(eq(copyFollowers.copyGroupId, group.id));
  const followers: GroupFollowerView[] = folRows.map(({ f, a }) => {
    const e = accountTradeCapable(a);
    return {
      accountId: a.id, publicId: a.publicId, name: a.name, nickname: a.nickname ?? null,
      accountType: a.accountType, status: a.status, enabled: f.enabled,
      eligible: e.eligible, reason: e.eligible ? null : e.reason,
      sizingMultiplierMilli: f.sizingMultiplierMilli ?? null, sizingFixedQty: f.sizingFixedQty ?? null,
    };
  });
  return {
    id: group.id, name: group.name, status: group.status, sizingMode: group.sizingMode, version: group.version,
    leader, followers, createdAt: group.createdAt.getTime(), updatedAt: group.updatedAt.getTime(),
  };
}

export async function getGroupView(db: Database, userId: string, groupId: string): Promise<GroupView> {
  const group = await ownedGroup(db, userId, groupId);
  return buildGroupView(db, group);
}

export async function listGroupViews(db: Database, userId: string): Promise<GroupView[]> {
  const groups = await db
    .select()
    .from(copyGroups)
    .where(and(eq(copyGroups.userId, userId), ne(copyGroups.status, 'DISABLED')));
  const views: GroupView[] = [];
  for (const g of groups) views.push(await buildGroupView(db, g));
  return views;
}
