/**
 * Engineering Resilience Phase 1 — adversarial concurrency + integrity, real Postgres.
 *
 * Attacks the account-cap invariant at 2/5/20-way concurrency (Part IV), the reset
 * successor invariant under concurrent double-fire (Part VI), and exercises the
 * read-only integrity detectors against both a clean database and deliberately
 * corrupted fixtures (Part XXXVI). Uses the deterministic `race()` harness.
 *
 * These prove FAIL-CLOSED-OR-RECOVER-SAFELY: exactly the permitted number of
 * operations succeed; the rest fail deterministically; the database never ends in a
 * state the integrity checks would flag.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../http/app.js';
import { getDb } from '../../db/client.js';
import { accounts, users } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { defaultOrganizationId, provisionAccount } from '../provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from '../profiles.js';
import { markOrderCompleted } from '../commerce.js';
import { createResetOrder } from '../account-reset.js';
import { fulfillPurchaseGated } from '../commerce-fulfillment.js';
import { MAX_ACTIVE_ACCOUNTS, AccountLimitError, countActiveAccounts } from '../account-limit.js';
import { race } from './attack-harness.js';
import { runIntegrityChecks, integrityCheckKeys } from './integrity-checks.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const users_: string[] = [];
const EVAL_KEY = `res-eval-${Math.random().toString(36).slice(2, 8)}`;

function config() {
  return {
    rules: {
      accountSizeMicros: 50_000 * M, profitTargetMicros: 3_000 * M, maxLossMicros: 2_000 * M,
      drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null,
      dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null,
      minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0,
      minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true,
    },
    execution: null,
    instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
    display: { startingBalanceMicros: 50_000 * M, priceMicros: 95 * M },
    payoutRules: null,
    fundedDestinationKey: null,
  };
}

async function makeUser(label: string): Promise<string> {
  const [u] = await db.insert(users).values({
    email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('pw'), displayName: label, organizationId,
  }).returning();
  users_.push(u!.id);
  return u!.id;
}

async function activeEval(userId: string): Promise<string> {
  const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
  const r = await provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true });
  return r.accountId;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['HTF_AUTO_FUNDING'] = 'false';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: EVAL_KEY, name: 'Resilience Eval 50K', accountType: 'EVALUATION', config: config() });
});

afterAll(async () => {
  if (users_.length > 0) await db.delete(users).where(inArray(users.id, users_));
  await app.close();
});

describe('Part IV — account-cap race at 2 / 5 / 20 concurrency', () => {
  for (const n of [2, 5, 20]) {
    it(`${n} concurrent enforced provisions at one slot below the cap create exactly one (never a 6th)`, async () => {
      const userId = await makeUser(`cap-${n}`);
      for (let i = 0; i < MAX_ACTIVE_ACCOUNTS - 1; i += 1) await activeEval(userId); // 4 active
      expect(await countActiveAccounts(db, userId)).toBe(MAX_ACTIVE_ACCOUNTS - 1);

      const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
      const { fulfilled, rejected } = await race(n, () =>
        provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true, enforceActiveLimit: true }),
      );

      expect(fulfilled).toHaveLength(1); // exactly one filled the final slot
      expect(rejected).toHaveLength(n - 1);
      for (const e of rejected) expect(e).toBeInstanceOf(AccountLimitError);
      expect(await countActiveAccounts(db, userId)).toBe(MAX_ACTIVE_ACCOUNTS); // 5, never 6

      // Restart/retry must not add another: re-drive one enforced provision, still refused.
      await expect(
        provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true, enforceActiveLimit: true }),
      ).rejects.toBeInstanceOf(AccountLimitError);
      expect(await countActiveAccounts(db, userId)).toBe(MAX_ACTIVE_ACCOUNTS);
    }, 60000);
  }
});

describe('Part VI — reset cannot create duplicate successors under concurrency', () => {
  it('N concurrent resets of one failed account produce exactly one successor', async () => {
    const userId = await makeUser('reset-race');
    const failed = await activeEval(userId);
    await db.update(accounts).set({ status: 'FAILED' }).where(eq(accounts.id, failed));

    // Fire several concurrent reset drives. createResetOrder is idempotent on the
    // fixed key `reset:<failedAccountId>`, so every racer resolves to the same order;
    // fulfilling it concurrently must still yield ONE successor account.
    const { fulfilled } = await race(8, async () => {
      const { orderId } = await createResetOrder(db, { organizationId, userId, failedAccountId: failed });
      await markOrderCompleted(db, orderId);
      return fulfillPurchaseGated(db, orderId, { enforceGate: false });
    });

    // Every racer that completed points at the same single successor account.
    const successorIds = new Set(
      fulfilled
        .filter((o) => o.status === 'PROVISIONED')
        .map((o) => (o as { accountId: string }).accountId),
    );
    expect(successorIds.size).toBe(1);

    // The database agrees: exactly one account has this failed one as its reset source.
    const successors = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.resetOfAccountId, failed));
    expect(successors).toHaveLength(1);

    // The failed account is preserved (historical provenance intact).
    const [old] = await db.select().from(accounts).where(eq(accounts.id, failed));
    expect(old!.status).toBe('FAILED');
  }, 60000);
});

describe('Part XXXVI — integrity checks', () => {
  it('a clean, correctly-operated database yields no findings for the owned fixtures', async () => {
    // Operate a normal user through provisioning; then confirm none of our fixtures
    // trip a detector. (Global checks may see unrelated seed data, so we assert our
    // own account is not implicated rather than global emptiness.)
    const userId = await makeUser('clean');
    await activeEval(userId);
    const findings = await runIntegrityChecks(db);
    const mine = findings.flatMap((f) => f.sample).filter((s) => s === userId);
    expect(mine).toHaveLength(0);
  });

  it('the DB rejects a second reset successor (RES-4 partial unique index, fail-closed)', async () => {
    const userId = await makeUser('corrupt-reset');
    const failed = await activeEval(userId);
    await db.update(accounts).set({ status: 'FAILED' }).where(eq(accounts.id, failed));
    const a = await activeEval(userId);
    const b = await activeEval(userId);
    // First successor is fine.
    await db.update(accounts).set({ resetOfAccountId: failed }).where(eq(accounts.id, a));
    // A SECOND successor for the same failed account is now impossible at the DB
    // level (Resilience Phase 2 RES-4): the partial unique index fails closed, so
    // the "duplicate reset successor" corruption can no longer be created even if the
    // application guard were bypassed. The DUPLICATE_RESET_SUCCESSOR integrity check
    // remains as defense-in-depth (it detects a violation should the index ever be dropped).
    await expect(
      db.update(accounts).set({ resetOfAccountId: failed }).where(eq(accounts.id, b)),
    ).rejects.toThrow();
    // Exactly one successor exists; the integrity check is clean for this failed account.
    const successors = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.resetOfAccountId, failed));
    expect(successors).toHaveLength(1);
    const findings = await runIntegrityChecks(db);
    expect(findings.find((f) => f.check === 'DUPLICATE_RESET_SUCCESSOR' && f.sample.includes(failed))).toBeUndefined();
  });

  it('detects an over-cap identity and a corrupted drawdown floor', async () => {
    const userId = await makeUser('corrupt-cap');
    for (let i = 0; i < MAX_ACTIVE_ACCOUNTS + 1; i += 1) await activeEval(userId); // 6 active (unenforced path)
    // Corrupt one account's floor above its high-water mark.
    const [one] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId)).limit(1);
    await db.update(accounts).set({ drawdownFloorMicros: 999_999_999 * M }).where(eq(accounts.id, one!.id));

    const findings = await runIntegrityChecks(db);
    const overCap = findings.find((f) => f.check === 'ACTIVE_ACCOUNTS_OVER_CAP');
    expect(overCap).toBeDefined();
    expect(overCap!.sample).toContain(userId);
    const floor = findings.find((f) => f.check === 'DRAWDOWN_FLOOR_ABOVE_HWM');
    expect(floor).toBeDefined();
    expect(floor!.sample).toContain(one!.id);
  });

  it('exposes a stable set of documented check keys', () => {
    expect(integrityCheckKeys()).toEqual(
      expect.arrayContaining([
        'ACTIVE_ACCOUNTS_OVER_CAP', 'PAID_PAYOUT_CYCLES_OVER_MAX', 'DUPLICATE_FUNDED_SUCCESSOR',
        'DUPLICATE_RESET_SUCCESSOR', 'DRAWDOWN_FLOOR_ABOVE_HWM', 'PHANTOM_POSITION',
        'PAYOUT_LEDGER_ARITHMETIC', 'APPROVED_PAYOUT_WITHOUT_DEBIT',
      ]),
    );
  });
});
