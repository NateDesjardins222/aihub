/**
 * Personal goals + progress read model — ownership, forge-protection, tracked
 * auto-completion idempotency, and club boundary truth (cumulative PAID
 * trader-share). Runs against the real database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { certificates, customerIdentities, payoutRequests, personalGoals, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from './profiles.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import {
  archivePersonalGoal,
  completePersonalGoal,
  createPersonalGoal,
  listPersonalGoals,
  reconcilePersonalGoals,
  updatePersonalGoal,
  GoalError,
  MAX_PINNED_GOALS,
} from './personal-goals.js';
import { progressForUser } from './progress.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const users_: string[] = [];

const FUNDED_KEY = `goals-fund-${Math.random().toString(36).slice(2, 8)}`;

async function makeUser(label: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('pw'), displayName: label, organizationId })
    .returning();
  users_.push(u!.id);
  await ensureCustomerIdentity(db, { organizationId, userId: u!.id });
  return u!.id;
}

async function fundedAccount(userId: string): Promise<string> {
  const product = await resolveProfileByKey(db, organizationId, FUNDED_KEY);
  const r = await provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true });
  return r.accountId;
}

async function seedPayout(userId: string, accountId: string, traderShareMicros: number, state = 'PAID'): Promise<void> {
  await db
    .insert(payoutRequests)
    .values({ organizationId, accountId, userId, requestedGrossMicros: traderShareMicros, traderShareMicros, state } as never);
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['HTF_AUTO_FUNDING'] = 'false';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, {
    organizationId, key: FUNDED_KEY, name: 'Goals Funded 50K', accountType: 'FUNDED_SIM',
    config: {
      rules: {
        accountSizeMicros: 50_000 * M, profitTargetMicros: 0, maxLossMicros: 2_000 * M,
        drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null,
        dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null,
        minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0,
        minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true,
      },
      execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
      display: { startingBalanceMicros: 50_000 * M }, payoutRules: null, fundedDestinationKey: null,
    },
  });
});

afterAll(async () => {
  if (users_.length > 0) {
    const idents = await db.select({ id: customerIdentities.id }).from(customerIdentities).where(inArray(customerIdentities.userId, users_));
    const identIds = idents.map((i) => i.id);
    if (identIds.length > 0) {
      await db.delete(personalGoals).where(inArray(personalGoals.customerIdentityId, identIds));
      await db.delete(certificates).where(inArray(certificates.customerIdentityId, identIds));
    }
    await db.delete(users).where(inArray(users.id, users_));
  }
  await app.close();
});

describe('personal goals — manual', () => {
  it('creates, and the owner can complete a MANUAL goal', async () => {
    const u = await makeUser('goal-manual');
    const g = await createPersonalGoal(db, { organizationId, userId: u, title: 'Withdraw my first payout', kind: 'MANUAL' });
    expect(g.status).toBe('ACTIVE');
    expect(g.kind).toBe('MANUAL');
    const done = await completePersonalGoal(db, u, g.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).not.toBeNull();
  });

  it('rejects a blank title', async () => {
    const u = await makeUser('goal-blank');
    await expect(createPersonalGoal(db, { organizationId, userId: u, title: '   ', kind: 'MANUAL' })).rejects.toBeInstanceOf(GoalError);
  });
});

describe('personal goals — tracked auto-completion cannot be forged', () => {
  it('refuses to manually complete a TRACKED goal', async () => {
    const u = await makeUser('goal-forge');
    const g = await createPersonalGoal(db, {
      organizationId, userId: u, title: 'Be paid $5,000 lifetime', kind: 'TRACKED',
      metric: 'CUMULATIVE_PAYOUT_MICROS', targetValue: 5_000 * M,
    });
    expect(g.status).toBe('ACTIVE');
    await expect(completePersonalGoal(db, u, g.id)).rejects.toMatchObject({ code: 'TRACKED_AUTO_ONLY' });
    // Still active after the forge attempt.
    const after = (await listPersonalGoals(db, u)).find((x) => x.id === g.id)!;
    expect(after.status).toBe('ACTIVE');
  });

  it('completes a tracked goal only when the authoritative PAID figure crosses the target, and is idempotent', async () => {
    const u = await makeUser('goal-track');
    const acct = await fundedAccount(u);
    const g = await createPersonalGoal(db, {
      organizationId, userId: u, title: 'Reach $5,000 paid', kind: 'TRACKED',
      metric: 'CUMULATIVE_PAYOUT_MICROS', targetValue: 5_000 * M,
    });
    // Under target → stays active.
    await seedPayout(u, acct, 4_999 * M + 990_000 /* $4,999.99 */, 'PAID');
    expect(await reconcilePersonalGoals(db, u)).toEqual([]);
    expect((await listPersonalGoals(db, u)).find((x) => x.id === g.id)!.status).toBe('ACTIVE');
    // One more cent crosses exactly $5,000.00.
    await seedPayout(u, acct, 10_000 /* $0.01 */, 'PAID');
    const newlyDone = await reconcilePersonalGoals(db, u);
    expect(newlyDone).toContain(g.id);
    expect((await listPersonalGoals(db, u)).find((x) => x.id === g.id)!.status).toBe('COMPLETED');
    // Idempotent: running again completes nothing more.
    expect(await reconcilePersonalGoals(db, u)).toEqual([]);
  });

  it('does NOT count unpaid payout requests toward a tracked goal', async () => {
    const u = await makeUser('goal-unpaid');
    const acct = await fundedAccount(u);
    const g = await createPersonalGoal(db, {
      organizationId, userId: u, title: 'Reach $5,000 paid', kind: 'TRACKED',
      metric: 'CUMULATIVE_PAYOUT_MICROS', targetValue: 5_000 * M,
    });
    await seedPayout(u, acct, 50_000 * M, 'APPROVED'); // large but NOT paid
    await seedPayout(u, acct, 50_000 * M, 'PROCESSING');
    expect(await reconcilePersonalGoals(db, u)).toEqual([]);
    expect((await listPersonalGoals(db, u)).find((x) => x.id === g.id)!.status).toBe('ACTIVE');
  });
});

describe('progress clubs — cumulative PAID trader-share boundaries', () => {
  it('10K club: not achieved at $9,999.99, achieved at exactly $10,000.00', async () => {
    const u = await makeUser('club-10k');
    const acct = await fundedAccount(u);
    await seedPayout(u, acct, 9_999 * M + 990_000 /* $9,999.99 */, 'PAID');
    let p = await progressForUser(db, u);
    expect(p.clubs.find((c) => c.key === 'TENK_CLUB')!.achieved).toBe(false);
    expect(p.hero.currentClub).toBeNull();
    await seedPayout(u, acct, 10_000 /* $0.01 */, 'PAID');
    p = await progressForUser(db, u);
    expect(p.clubs.find((c) => c.key === 'TENK_CLUB')!.achieved).toBe(true);
    expect(p.hero.currentClub).toBe('TENK_CLUB');
    expect(p.hero.lifetimePaidTraderShareMicros).toBe(10_000 * M);
  });

  it('50K/100K thresholds and the next-club remaining figure are exact', async () => {
    const u = await makeUser('club-50k');
    const acct = await fundedAccount(u);
    await seedPayout(u, acct, 50_000 * M, 'PAID');
    const p = await progressForUser(db, u);
    expect(p.clubs.find((c) => c.key === 'TENK_CLUB')!.achieved).toBe(true);
    expect(p.clubs.find((c) => c.key === 'FIFTYK_CLUB')!.achieved).toBe(true);
    expect(p.clubs.find((c) => c.key === 'HUNDREDK_CLUB')!.achieved).toBe(false);
    expect(p.hero.currentClub).toBe('FIFTYK_CLUB');
    expect(p.hero.nextClub).toMatchObject({ key: 'HUNDREDK_CLUB', remainingMicros: 50_000 * M });
  });
});

describe('progress zero-state', () => {
  it('shows truthful zeros for a brand-new customer', async () => {
    const u = await makeUser('club-zero');
    const p = await progressForUser(db, u);
    expect(p.hero.lifetimePaidTraderShareMicros).toBe(0);
    expect(p.hero.fundedAccounts).toBe(0);
    expect(p.hero.evaluationsPassed).toBe(0);
    expect(p.hero.currentClub).toBeNull();
    expect(p.clubs.every((c) => !c.achieved)).toBe(true);
    expect(p.goals).toEqual([]);
    expect(p.milestones).toEqual([]);
  });
});

describe('personal goals — cross-customer isolation', () => {
  it('a second customer cannot read, edit, complete or archive the first customer’s goal', async () => {
    const a = await makeUser('goal-owner-a');
    const b = await makeUser('goal-owner-b');
    const g = await createPersonalGoal(db, { organizationId, userId: a, title: 'My private goal', kind: 'MANUAL' });
    // B's list never contains A's goal.
    expect((await listPersonalGoals(db, b)).some((x) => x.id === g.id)).toBe(false);
    // Every mutation by B is a NOT_FOUND (ownership enforced server-side).
    await expect(updatePersonalGoal(db, b, g.id, { title: 'hijacked' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(completePersonalGoal(db, b, g.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(archivePersonalGoal(db, b, g.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // A's goal is untouched.
    expect((await listPersonalGoals(db, a)).find((x) => x.id === g.id)!.title).toBe('My private goal');
  });
});

describe('personal goals — current focus pin ceiling', () => {
  it(`allows at most ${MAX_PINNED_GOALS} pinned goals`, async () => {
    const u = await makeUser('goal-pins');
    const made = [] as string[];
    for (let i = 0; i < MAX_PINNED_GOALS + 1; i += 1) {
      const g = await createPersonalGoal(db, { organizationId, userId: u, title: `Focus ${i}`, kind: 'MANUAL' });
      made.push(g.id);
    }
    for (let i = 0; i < MAX_PINNED_GOALS; i += 1) {
      await updatePersonalGoal(db, u, made[i]!, { pinned: true });
    }
    await expect(updatePersonalGoal(db, u, made[MAX_PINNED_GOALS]!, { pinned: true })).rejects.toMatchObject({ code: 'TOO_MANY_PINS' });
  });
});
