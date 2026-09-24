/**
 * Customer portal lifecycle — account service, reset re-purchase, and funded
 * inactivity closure, against the real database. One app instance covers all
 * three to keep startup-sweep contention low. Auto-funding is disabled; these
 * tests never exercise the funding subscriber.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { accounts, customerIdentities, trades, users, verifiedContacts } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from './profiles.js';
import { markOrderCompleted } from './commerce.js';
import { fulfillPurchaseGated } from './commerce-fulfillment.js';
import {
  archiveAccount,
  listPortalAccounts,
  portalAccountDetail,
  portalState,
  setAccountNickname,
  unarchiveAccount,
  PortalAccountError,
} from './portal-accounts.js';
import { createResetOrder, resetQuote } from './account-reset.js';
import { exchangeMonthKey, previousMonthKey, runInactivitySweep } from './account-inactivity.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const users_: string[] = [];
const EVAL_KEY = `portal-eval-${Math.random().toString(36).slice(2, 8)}`;
const FUNDED_KEY = `portal-fund-${Math.random().toString(36).slice(2, 8)}`;

function config(priceMicros: number, accountType: string) {
  return {
    rules: {
      accountSizeMicros: 25_000 * M, profitTargetMicros: 1_500 * M, maxLossMicros: 1_000 * M,
      drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null,
      dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null,
      minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0,
      minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true,
    },
    execution: null,
    instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
    display: { startingBalanceMicros: 25_000 * M, priceMicros },
    payoutRules: null,
    fundedDestinationKey: null,
  };
}

async function makeUser(label: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('pw'), displayName: label, organizationId })
    .returning();
  users_.push(u!.id);
  return u!.id;
}

async function activeEval(userId: string): Promise<string> {
  const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
  const r = await provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true });
  return r.accountId;
}
async function activeFunded(userId: string): Promise<string> {
  const product = await resolveProfileByKey(db, organizationId, FUNDED_KEY);
  const r = await provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true });
  return r.accountId;
}

async function insertTrade(accountId: string, tradeDate: string): Promise<void> {
  const t = new Date(`${tradeDate}T15:00:00Z`);
  await db.insert(trades).values({
    accountId, symbol: 'NQ', side: 'LONG', qty: 1,
    entryTicksScaled: 0, exitTicksScaled: 0, entryTime: t, exitTime: t,
    grossPnlMicros: 10 * M, feesMicros: 0, netPnlMicros: 10 * M, tradeDate,
  });
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['HTF_AUTO_FUNDING'] = 'false';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: EVAL_KEY, name: 'Portal Eval 25K', accountType: 'EVALUATION', config: config(65 * M, 'EVALUATION') });
  await publishProfileVersion(db, { organizationId, key: FUNDED_KEY, name: 'Portal Funded 25K', accountType: 'FUNDED_SIM', config: config(0, 'FUNDED_SIM') });
});

afterAll(async () => {
  if (users_.length > 0) await db.delete(users).where(inArray(users.id, users_));
  await app.close();
});

describe('portal account service', () => {
  it('sets, clears and bounds a nickname (presentation-only)', async () => {
    const userId = await makeUser('nick');
    const id = await activeEval(userId);
    expect((await setAccountNickname(db, userId, id, '  My Runner  ')).nickname).toBe('My Runner');
    const [a1] = await db.select().from(accounts).where(eq(accounts.id, id));
    expect(a1!.nickname).toBe('My Runner');
    expect(a1!.name).not.toBe('My Runner'); // authoritative name untouched
    expect((await setAccountNickname(db, userId, id, '')).nickname).toBeNull();
    await expect(setAccountNickname(db, userId, id, 'x'.repeat(61))).rejects.toBeInstanceOf(PortalAccountError);
  });

  it('rejects nickname/detail on another user’s account', async () => {
    const owner = await makeUser('owner');
    const other = await makeUser('other');
    const id = await activeEval(owner);
    await expect(setAccountNickname(db, other, id, 'nope')).rejects.toBeInstanceOf(PortalAccountError);
    await expect(portalAccountDetail(db, other, id)).rejects.toBeInstanceOf(PortalAccountError);
  });

  it('lists non-practice accounts, counts active slots, hides archived by default', async () => {
    const userId = await makeUser('list');
    const a = await activeEval(userId);
    const b = await activeEval(userId);
    await db.update(accounts).set({ status: 'FAILED' }).where(eq(accounts.id, b));

    const view = await listPortalAccounts(db, userId);
    expect(view.accounts.map((x) => x.id).sort()).toEqual([a, b].sort());
    expect(view.activeSlotsUsed).toBe(1); // only `a` is active; `b` failed
    expect(view.maxActiveSlots).toBe(5);

    await archiveAccount(db, userId, b);
    const hidden = await listPortalAccounts(db, userId);
    expect(hidden.accounts.map((x) => x.id)).toEqual([a]);
    const shown = await listPortalAccounts(db, userId, { includeArchived: true });
    expect(shown.accounts.map((x) => x.id).sort()).toEqual([a, b].sort());
    expect(shown.accounts.find((x) => x.id === b)?.portalState).toBe('ARCHIVED');
  });

  it('refuses to archive an active account (no back door around the five-account limit)', async () => {
    const userId = await makeUser('arch');
    const id = await activeEval(userId);
    await expect(archiveAccount(db, userId, id)).rejects.toMatchObject({ code: 'CANNOT_ARCHIVE_ACTIVE' });
    // unarchive requires it to be archived
    await expect(unarchiveAccount(db, userId, id)).rejects.toMatchObject({ code: 'NOT_ARCHIVED' });
  });

  it('maps portal states from authoritative columns', () => {
    expect(portalState({ accountType: 'EVALUATION', status: 'ACTIVE', archivedAt: null })).toBe('EVALUATION_ACTIVE');
    expect(portalState({ accountType: 'FUNDED_SIM', status: 'ACTIVE', archivedAt: null })).toBe('FUNDED_ACTIVE');
    expect(portalState({ accountType: 'EVALUATION', status: 'PASSED', archivedAt: null })).toBe('EVALUATION_PASSED');
    expect(portalState({ accountType: 'EVALUATION', status: 'FAILED', archivedAt: null })).toBe('FAILED');
    expect(portalState({ accountType: 'FUNDED_SIM', status: 'COMPLETED', archivedAt: null })).toBe('COMPLETED_MAX_PAYOUTS');
    expect(portalState({ accountType: 'FUNDED_SIM', status: 'INACTIVE', archivedAt: null })).toBe('INACTIVE_CLOSED');
    expect(portalState({ accountType: 'FUNDED_SIM', status: 'ACTIVE', archivedAt: new Date() })).toBe('ARCHIVED');
  });

  it('detail carries the original price and lifecycle history', async () => {
    const userId = await makeUser('detail');
    const id = await activeEval(userId);
    const d = await portalAccountDetail(db, userId, id);
    expect(d.priceMicros).toBe(65 * M);
    expect(d.lifecycles.length).toBeGreaterThanOrEqual(1);
    expect(d.lifecycles[0]!.seq).toBe(1);
  });
});

describe('account reset', () => {
  it('quotes the original price and re-purchases into a new account, preserving the failed one', async () => {
    const userId = await makeUser('reset');
    const failed = await activeEval(userId);
    await db.update(accounts).set({ status: 'FAILED' }).where(eq(accounts.id, failed));

    const quote = await resetQuote(db, userId, failed);
    expect(quote.priceMicros).toBe(65 * M);

    const { orderId } = await createResetOrder(db, { organizationId, userId, failedAccountId: failed });
    await markOrderCompleted(db, orderId);
    const done = await fulfillPurchaseGated(db, orderId, { enforceGate: false });
    expect(done.status).toBe('PROVISIONED');
    const newId = (done as { accountId: string }).accountId;
    expect(newId).not.toBe(failed);

    const [fresh] = await db.select().from(accounts).where(eq(accounts.id, newId));
    expect(fresh!.resetOfAccountId).toBe(failed);
    expect(fresh!.status).toBe('ACTIVE');
    expect(fresh!.accountType).toBe('EVALUATION');
    // The failed account is never erased.
    const [old] = await db.select().from(accounts).where(eq(accounts.id, failed));
    expect(old!.status).toBe('FAILED');

    // Idempotent: re-driving the same order returns the same account, no second reset.
    const again = await fulfillPurchaseGated(db, orderId, { enforceGate: false });
    expect((again as { accountId: string }).accountId).toBe(newId);
    const resets = await db.select().from(accounts).where(eq(accounts.resetOfAccountId, failed));
    expect(resets).toHaveLength(1);
  }, 30000);

  it('refuses a reset for an account that is not a failed evaluation', async () => {
    const userId = await makeUser('noreset');
    const active = await activeEval(userId);
    await expect(resetQuote(db, userId, active)).rejects.toMatchObject({ code: 'NOT_RESETTABLE' });
  });
});

describe('funded inactivity closure', () => {
  it('month-key helpers are deterministic and ordered', () => {
    expect(exchangeMonthKey(new Date('2026-06-15T12:00:00Z'))).toBe('2026-06');
    expect(previousMonthKey(new Date('2026-01-10T12:00:00Z'))).toBe('2025-12');
    expect(previousMonthKey(new Date('2026-06-15T12:00:00Z'))).toBe('2026-05');
  });

  it('closes a funded account after a completed month with no activity; idempotent', async () => {
    const userId = await makeUser('inactive');
    const id = await activeFunded(userId);
    await db.update(accounts).set({ activatedAt: new Date('2026-03-01T12:00:00Z') }).where(eq(accounts.id, id));

    const now = new Date('2026-06-15T12:00:00Z'); // checks 2026-05, no trades
    const first = await runInactivitySweep(db, { now });
    const [closed] = await db.select().from(accounts).where(eq(accounts.id, id));
    expect(closed!.status).toBe('INACTIVE');
    expect(first.closed).toBeGreaterThanOrEqual(1);

    const second = await runInactivitySweep(db, { now });
    // Already INACTIVE — not re-closed by this account.
    const [still] = await db.select().from(accounts).where(eq(accounts.id, id));
    expect(still!.status).toBe('INACTIVE');
    expect(second).toBeDefined();
  }, 30000);

  it('does NOT close a funded account that traded in the checked month', async () => {
    const userId = await makeUser('active-funded');
    const id = await activeFunded(userId);
    await db.update(accounts).set({ activatedAt: new Date('2026-03-01T12:00:00Z') }).where(eq(accounts.id, id));
    await insertTrade(id, '2026-05-20'); // activity in the checked month

    await runInactivitySweep(db, { now: new Date('2026-06-15T12:00:00Z') });
    const [a] = await db.select().from(accounts).where(eq(accounts.id, id));
    expect(a!.status).toBe('ACTIVE');
  }, 30000);

  it('warns an at-risk funded account near month end (traded last month, not this month)', async () => {
    const userId = await makeUser('warn');
    const id = await activeFunded(userId);
    await db.update(accounts).set({ activatedAt: new Date('2026-03-01T12:00:00Z') }).where(eq(accounts.id, id));
    await insertTrade(id, '2026-05-20'); // keeps it from being closed for 2026-05

    // Seed a verified primary email so the warning notification can address a channel.
    const [ident] = await db.insert(customerIdentities).values({ organizationId, userId }).returning();
    await db.insert(verifiedContacts).values({
      organizationId, customerIdentityId: ident!.id, channel: 'EMAIL', value: `warn-${userId}@atlas.test`,
      status: 'VERIFIED', isPrimary: true, verifiedAt: new Date(),
    });

    const res = await runInactivitySweep(db, { now: new Date('2026-06-25T12:00:00Z'), warnDaysBeforeMonthEnd: 31 });
    expect(res.warned).toBeGreaterThanOrEqual(1);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, id));
    expect(a!.status).toBe('ACTIVE'); // warned, not closed
  }, 30000);
});
