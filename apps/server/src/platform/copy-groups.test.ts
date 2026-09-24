/**
 * Copy-group domain — ownership, topology (loop/chain prevention), follower
 * limits, eligibility and lifecycle, against the real database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { getDb, closeDb } from '../db/client.js';
import { accounts, copyGroups, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from './profiles.js';
import {
  addFollower,
  createGroup,
  disableGroup,
  getGroupView,
  listEligibleAccounts,
  pauseGroup,
  removeFollower,
  resumeGroup,
  setLeader,
  updateFollower,
  CopyGroupError,
  MAX_FOLLOWERS,
} from './copy-groups.js';

const M = 1_000_000;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const users_: string[] = [];
const EVAL_KEY = `copy-eval-${Math.random().toString(36).slice(2, 8)}`;

function cfg() {
  return {
    rules: {
      accountSizeMicros: 50_000 * M, profitTargetMicros: 3_000 * M, maxLossMicros: 2_000 * M,
      drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null,
      dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null,
      minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0,
      minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true,
    },
    execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
    display: { startingBalanceMicros: 50_000 * M }, payoutRules: null, fundedDestinationKey: null,
  };
}

async function makeUser(label: string): Promise<string> {
  const [u] = await db.insert(users).values({ email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('pw'), displayName: label, organizationId }).returning();
  users_.push(u!.id);
  return u!.id;
}
async function acct(userId: string): Promise<string> {
  const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
  const r = await provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true });
  return r.accountId;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: EVAL_KEY, name: 'Copy Eval 50K', accountType: 'EVALUATION', config: cfg() });
});

afterAll(async () => {
  if (users_.length > 0) await db.delete(users).where(inArray(users.id, users_));
  await closeDb();
});

describe('createGroup + ownership', () => {
  it('creates a group with an owned, eligible leader', async () => {
    const userId = await makeUser('owner');
    const leader = await acct(userId);
    const groupId = await createGroup(db, { userId, name: 'My group', leaderAccountId: leader, sizingMode: 'SAME' });
    const view = await getGroupView(db, userId, groupId);
    expect(view.leader?.accountId).toBe(leader);
    expect(view.status).toBe('ACTIVE');
    expect(view.followers).toHaveLength(0);
  });

  it('refuses a leader the caller does not own (no IDOR)', async () => {
    const owner = await makeUser('a');
    const other = await makeUser('b');
    const otherAcct = await acct(other);
    await expect(createGroup(db, { userId: owner, name: 'x', leaderAccountId: otherAcct })).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  it('refuses an ineligible (failed) leader', async () => {
    const userId = await makeUser('inelig');
    const leader = await acct(userId);
    await db.update(accounts).set({ status: 'FAILED' }).where(eq(accounts.id, leader));
    await expect(createGroup(db, { userId, name: 'x', leaderAccountId: leader })).rejects.toMatchObject({ code: 'INELIGIBLE_ACCOUNT' });
  });
});

describe('followers + topology', () => {
  it('adds up to four followers and refuses a fifth', async () => {
    const userId = await makeUser('followers');
    const leader = await acct(userId);
    const groupId = await createGroup(db, { userId, name: 'g', leaderAccountId: leader });
    for (let i = 0; i < MAX_FOLLOWERS; i += 1) await addFollower(db, { userId, groupId, accountId: await acct(userId) });
    const fifth = await acct(userId);
    await expect(addFollower(db, { userId, groupId, accountId: fifth })).rejects.toMatchObject({ code: 'TOO_MANY_FOLLOWERS' });
    const view = await getGroupView(db, userId, groupId);
    expect(view.followers).toHaveLength(MAX_FOLLOWERS);
  });

  it('refuses the leader as its own follower', async () => {
    const userId = await makeUser('selffollow');
    const leader = await acct(userId);
    const groupId = await createGroup(db, { userId, name: 'g', leaderAccountId: leader });
    await expect(addFollower(db, { userId, groupId, accountId: leader })).rejects.toMatchObject({ code: 'LEADER_IS_FOLLOWER' });
  });

  it('prevents loops: an account leading one group cannot follow another', async () => {
    const userId = await makeUser('loop');
    const a = await acct(userId);
    const b = await acct(userId);
    const groupA = await createGroup(db, { userId, name: 'A', leaderAccountId: a });
    const groupB = await createGroup(db, { userId, name: 'B', leaderAccountId: b });
    // a leads groupA → cannot follow groupB
    await expect(addFollower(db, { userId, groupId: groupB, accountId: a })).rejects.toMatchObject({ code: 'ACCOUNT_IN_USE' });
    // b leads groupB → cannot follow groupA
    await expect(addFollower(db, { userId, groupId: groupA, accountId: b })).rejects.toMatchObject({ code: 'ACCOUNT_IN_USE' });
  });

  it('prevents an account following two groups at once', async () => {
    const userId = await makeUser('doublefollow');
    const l1 = await acct(userId); const l2 = await acct(userId);
    const f = await acct(userId);
    const g1 = await createGroup(db, { userId, name: 'g1', leaderAccountId: l1 });
    const g2 = await createGroup(db, { userId, name: 'g2', leaderAccountId: l2 });
    await addFollower(db, { userId, groupId: g1, accountId: f });
    await expect(addFollower(db, { userId, groupId: g2, accountId: f })).rejects.toMatchObject({ code: 'ACCOUNT_IN_USE' });
  });

  it('a disabled group frees its accounts for reuse', async () => {
    const userId = await makeUser('reuse');
    const a = await acct(userId);
    const g1 = await createGroup(db, { userId, name: 'g1', leaderAccountId: a });
    await disableGroup(db, userId, g1);
    // now `a` can lead a new group
    const g2 = await createGroup(db, { userId, name: 'g2', leaderAccountId: a });
    expect(g2).toBeTruthy();
  });
});

describe('follower updates + lifecycle', () => {
  it('enables/disables and reconfigures a follower, and removes one', async () => {
    const userId = await makeUser('update');
    const leader = await acct(userId);
    const f = await acct(userId);
    const groupId = await createGroup(db, { userId, name: 'g', leaderAccountId: leader, sizingMode: 'MULTIPLIER' });
    await addFollower(db, { userId, groupId, accountId: f, sizingMultiplierMilli: 1000 });
    await updateFollower(db, { userId, groupId, accountId: f, enabled: false, sizingMultiplierMilli: 500 });
    let view = await getGroupView(db, userId, groupId);
    expect(view.followers[0]!.enabled).toBe(false);
    expect(view.followers[0]!.sizingMultiplierMilli).toBe(500);
    await removeFollower(db, userId, groupId, f);
    view = await getGroupView(db, userId, groupId);
    expect(view.followers).toHaveLength(0);
  });

  it('pause → resume re-validates the leader; resume with an ineligible leader fails', async () => {
    const userId = await makeUser('lifecycle');
    const leader = await acct(userId);
    const groupId = await createGroup(db, { userId, name: 'g', leaderAccountId: leader });
    await pauseGroup(db, userId, groupId);
    expect((await getGroupView(db, userId, groupId)).status).toBe('PAUSED');
    await resumeGroup(db, userId, groupId);
    expect((await getGroupView(db, userId, groupId)).status).toBe('ACTIVE');
    // Leader breaches → resume refused.
    await pauseGroup(db, userId, groupId);
    await db.update(accounts).set({ status: 'FAILED' }).where(eq(accounts.id, leader));
    await expect(resumeGroup(db, userId, groupId)).rejects.toMatchObject({ code: 'INELIGIBLE_ACCOUNT' });
  });

  it('setLeader swaps to another eligible owned account', async () => {
    const userId = await makeUser('setleader');
    const l1 = await acct(userId); const l2 = await acct(userId);
    const groupId = await createGroup(db, { userId, name: 'g', leaderAccountId: l1 });
    await setLeader(db, userId, groupId, l2);
    expect((await getGroupView(db, userId, groupId)).leader?.accountId).toBe(l2);
  });

  it('lists eligible accounts, flagging ineligible ones', async () => {
    const userId = await makeUser('eligible');
    const ok = await acct(userId);
    const bad = await acct(userId);
    await db.update(accounts).set({ status: 'FAILED' }).where(eq(accounts.id, bad));
    const list = await listEligibleAccounts(db, userId);
    expect(list.find((a) => a.id === ok)?.eligible).toBe(true);
    expect(list.find((a) => a.id === bad)?.eligible).toBe(false);
  });
});
