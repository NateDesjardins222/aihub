/**
 * The five-active-account invariant, against the real database.
 *
 * A verified trader may hold at most five ACTIVE accounts (EVALUATION or
 * FUNDED_SIM, status ACTIVE/PENDING, un-archived). The count excludes practice
 * accounts, frozen PASSED evaluations, FAILED accounts and archived ones — which
 * is why a pass -> funded transition preserves the slot. The guard is
 * transactional (a per-user advisory lock), so simultaneous provisions for one
 * trader can never produce a sixth active account. The purchase path parks a
 * refused order recoverably (PROVISION_BLOCKED / ACTIVE_LIMIT_REACHED) rather
 * than losing the payment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { accounts, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from './profiles.js';
import { completeCommercialOrder } from './commerce.js';
import {
  ACTIVE_LIMIT_REASON,
  fulfillPurchaseGated,
} from './commerce-fulfillment.js';
import {
  AccountLimitError,
  MAX_ACTIVE_ACCOUNTS,
  assertActiveSlotAvailable,
  countActiveAccounts,
} from './account-limit.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const users_: string[] = [];
const EVAL_KEY = `limit-eval-${Math.random().toString(36).slice(2, 8)}`;
const PRAC_KEY = `limit-prac-${Math.random().toString(36).slice(2, 8)}`;

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
    display: { startingBalanceMicros: 50_000 * M },
    payoutRules: null,
    fundedDestinationKey: null,
  };
}

async function makeUser(label: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('pw'), displayName: label, organizationId })
    .returning();
  users_.push(user!.id);
  return user!.id;
}

/** Provision one ACTIVE evaluation account (a slot-consuming account). */
async function activeEval(userId: string): Promise<string> {
  const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
  const r = await provisionAccount(db, {
    organizationId, userId, profileVersionId: product.versionId, activate: true,
  });
  return r.accountId;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  // Keep the funding subscriber out of this suite; we test the limit alone.
  process.env['HTF_AUTO_FUNDING'] = 'false';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: EVAL_KEY, name: 'Limit Eval 50K', accountType: 'EVALUATION', config: config() });
  await publishProfileVersion(db, { organizationId, key: PRAC_KEY, name: 'Limit Practice', accountType: 'PRACTICE', config: config() });
});

afterAll(async () => {
  if (users_.length > 0) {
    await db.delete(users).where(inArray(users.id, users_));
  }
  await app.close();
});

describe('countActiveAccounts', () => {
  it('counts only slot-consuming accounts (eval/funded, active/pending, un-archived)', async () => {
    const userId = await makeUser('count');
    expect(await countActiveAccounts(db, userId)).toBe(0);

    const a1 = await activeEval(userId);
    const a2 = await activeEval(userId);
    expect(await countActiveAccounts(db, userId)).toBe(2);

    // A practice account never consumes a slot.
    const prac = await resolveProfileByKey(db, organizationId, PRAC_KEY);
    await provisionAccount(db, { organizationId, userId, profileVersionId: prac.versionId, activate: true });
    expect(await countActiveAccounts(db, userId)).toBe(2);

    // A frozen PASSED evaluation does not consume a slot (this is why funding
    // preserves the slot).
    await db.update(accounts).set({ status: 'PASSED' }).where(eq(accounts.id, a1));
    expect(await countActiveAccounts(db, userId)).toBe(1);

    // Archiving frees the slot.
    await db.update(accounts).set({ archivedAt: new Date() }).where(eq(accounts.id, a2));
    expect(await countActiveAccounts(db, userId)).toBe(0);
  });
});

describe('assertActiveSlotAvailable', () => {
  it('refuses the sixth active account (sequential)', async () => {
    const userId = await makeUser('seq');
    for (let i = 0; i < MAX_ACTIVE_ACCOUNTS; i += 1) await activeEval(userId);
    expect(await countActiveAccounts(db, userId)).toBe(MAX_ACTIVE_ACCOUNTS);

    await expect(
      db.transaction(async (tx) => assertActiveSlotAvailable(tx as never, userId)),
    ).rejects.toBeInstanceOf(AccountLimitError);

    // provisionAccount with the limit enforced refuses too, and no account is left.
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    await expect(
      provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true, enforceActiveLimit: true }),
    ).rejects.toBeInstanceOf(AccountLimitError);
    expect(await countActiveAccounts(db, userId)).toBe(MAX_ACTIVE_ACCOUNTS);
  }, 30000);

  it('does not enforce when the flag is off (legacy/admin-direct path)', async () => {
    const userId = await makeUser('unenforced');
    for (let i = 0; i < MAX_ACTIVE_ACCOUNTS; i += 1) await activeEval(userId);
    // Without the flag, a direct provision is allowed past the limit — the guard
    // is opt-in, so this proves it is genuinely the flag that enforces.
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const r = await provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true });
    expect(r.accountId).toBeTruthy();
    expect(await countActiveAccounts(db, userId)).toBe(MAX_ACTIVE_ACCOUNTS + 1);
  }, 30000);
});

describe('concurrency — the invariant holds under simultaneous provisioning', () => {
  it('two concurrent enforced provisions at 4 active create exactly one (never a 6th)', async () => {
    const userId = await makeUser('race-prov');
    for (let i = 0; i < 4; i += 1) await activeEval(userId);
    expect(await countActiveAccounts(db, userId)).toBe(4);

    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const attempts = Array.from({ length: 4 }, () =>
      provisionAccount(db, {
        organizationId, userId, profileVersionId: product.versionId, activate: true, enforceActiveLimit: true,
      }).then(
        (r) => ({ ok: true as const, r }),
        (e) => ({ ok: false as const, e }),
      ),
    );
    const results = await Promise.all(attempts);
    const ok = results.filter((x) => x.ok);
    const refused = results.filter((x) => !x.ok);

    expect(ok).toHaveLength(1); // exactly one filled the last slot
    expect(refused).toHaveLength(3);
    for (const f of refused) expect((f as { e: unknown }).e).toBeInstanceOf(AccountLimitError);
    expect(await countActiveAccounts(db, userId)).toBe(MAX_ACTIVE_ACCOUNTS); // 5, never 6
  }, 45000);

  it('two concurrent purchases at 4 active provision one and park one (ACTIVE_LIMIT_REACHED)', async () => {
    const userId = await makeUser('race-buy');
    for (let i = 0; i < 4; i += 1) await activeEval(userId);
    expect(await countActiveAccounts(db, userId)).toBe(4);

    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    // Two distinct COMPLETED purchase orders (money already settled server-side).
    const orders = await Promise.all([0, 1].map((i) =>
      completeCommercialOrder(db, {
        organizationId, userId, productVersionId: product.versionId, source: 'PURCHASE',
        idempotencyKey: `limit-buy-${userId}-${i}`,
      }),
    ));

    // Fulfil both concurrently. enforceGate:false skips the identity gate so we
    // isolate the active-limit behaviour; the limit pre-check + transactional
    // guard still run.
    const outcomes = await Promise.all(orders.map((o) =>
      fulfillPurchaseGated(db, o.id, { enforceGate: false }),
    ));

    const provisioned = outcomes.filter((o) => o.status === 'PROVISIONED');
    const blocked = outcomes.filter((o) => o.status === 'PROVISION_BLOCKED');
    expect(provisioned).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect((blocked[0] as { blockedReasons: string[] }).blockedReasons).toContain(ACTIVE_LIMIT_REASON);
    expect(await countActiveAccounts(db, userId)).toBe(MAX_ACTIVE_ACCOUNTS); // 5, never 6

    // The blocked purchase is recoverable: its entitlement is granted and its
    // order re-drives to PROVISIONED once a slot frees. Free one and re-drive.
    const active = await db.select({ id: accounts.id }).from(accounts)
      .where(eq(accounts.userId, userId));
    // Archive one active account to open a slot.
    const activeIds = active.map((a) => a.id);
    await db.update(accounts).set({ archivedAt: new Date(), status: 'PASSED' }).where(eq(accounts.id, activeIds[0]!));
    const blockedOrder = orders.find((o) => (blocked[0] as { orderId: string }).orderId === o.id)!;
    const redriven = await fulfillPurchaseGated(db, blockedOrder.id, { enforceGate: false });
    expect(redriven.status).toBe('PROVISIONED');
    expect(await countActiveAccounts(db, userId)).toBe(MAX_ACTIVE_ACCOUNTS); // back to 5
  }, 45000);
});
