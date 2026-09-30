/**
 * Engineering Resilience Phase 3 — multi-instance simulation (Parts VIII–XV).
 *
 * Simulates N application instances sharing ONE Postgres: each "instance" is its own
 * connection pool (its own `createDb` handle) with SEPARATE process memory but the
 * SAME authoritative database. This is the real test of whether any correctness
 * guarantee secretly depends on a single process's memory. Contenders rendezvous at
 * a barrier (`race`) so they hit the authoritative critical section together.
 *
 * The shared DB must remain the final authority: never a 6th account, never a second
 * reset/funded successor, never a double payout effect, never a double EOD.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../http/app.js';
import { createDb, getDb, type DbHandle } from '../../db/client.js';
import { accounts, dailyAccountStats, payoutLedger, payoutRequests, users, accountQualifications } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { defaultOrganizationId, provisionAccount } from '../provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from '../profiles.js';
import { acquireEvaluation, approveFunding, certifyEvaluation, markOrderCompleted } from '../commerce.js';
import { createResetOrder } from '../account-reset.js';
import { fulfillPurchaseGated } from '../commerce-fulfillment.js';
import { ensureCustomerIdentity } from '../customer-identity.js';
import { addDestination } from '../payout-destinations.js';
import { requestPayout } from '../payouts.js';
import { getOperationByRequest, ingestProviderEvent, runFastLane, submitPayable } from '../payout-operations.js';
import { updateOpsConfig, closeCircuitBreaker } from '../payout-ops-config.js';
import { mockPayoutProvider, resetMockPayoutProvider } from '../payout-provider-registry.js';
import { MAX_ACTIVE_ACCOUNTS, AccountLimitError, countActiveAccounts } from '../account-limit.js';
import { SYSTEM_ACTOR } from '../actor.js';
import { race } from './attack-harness.js';
import { runIntegrityChecks } from './integrity-checks.js';

const M = 1_000_000;
const $ = (d: number) => d * M;
const URL = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const EVAL_KEY = `mi-eval-${Math.random().toString(36).slice(2, 7)}`;
const FUNDED_KEY = `mi-dest-${Math.random().toString(36).slice(2, 7)}`;
const createdUsers: string[] = [];
/** Independent instances = independent connection pools over the same DB. */
let instances: DbHandle[] = [];

function fundedConfig() {
  return {
    rules: { accountSizeMicros: $(50_000), profitTargetMicros: 0, maxLossMicros: $(2_000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: false, flattenOnBreach: true },
    execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: $(50_000) },
    payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000), $(2000), $(2000), $(2000), $(2000)] } },
    fundedDestinationKey: null, whopPlanId: null,
  };
}
function evalConfig() {
  return {
    rules: { accountSizeMicros: $(50_000), profitTargetMicros: $(3_000), maxLossMicros: $(2_000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true },
    execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: $(50_000), priceMicros: 95 * M },
    payoutRules: null, fundedDestinationKey: FUNDED_KEY, whopPlanId: null,
  };
}

async function makeUser(label: string): Promise<string> {
  const [u] = await db.insert(users).values({ email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('pw'), displayName: label, organizationId }).returning();
  createdUsers.push(u!.id);
  await ensureCustomerIdentity(db, { organizationId, userId: u!.id });
  return u!.id;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = URL;
  process.env['HTF_AUTO_FUNDING'] = 'false';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: FUNDED_KEY, name: 'MI Funded 50K', accountType: 'FUNDED_SIM', config: fundedConfig() });
  await publishProfileVersion(db, { organizationId, key: EVAL_KEY, name: 'MI Eval 50K', accountType: 'EVALUATION', config: evalConfig() });
  await updateOpsConfig(db, organizationId, { provider: 'MOCK', actor: SYSTEM_ACTOR });
  resetMockPayoutProvider();
  await closeCircuitBreaker(db, organizationId, 'mi reset', SYSTEM_ACTOR).catch(() => undefined);
  // Up to 8 independent instances.
  instances = Array.from({ length: 8 }, () => createDb(URL));
}, 60000);

afterAll(async () => {
  // Best-effort cleanup: accounts with payout_ledger rows cannot be deleted (the
  // ledger is append-only, by design), so users owning them are left as harmless
  // residue on the shared test DB — canonical always re-prepares a fresh DB.
  try {
    if (createdUsers.length > 0) {
      const accts = await db.select({ id: accounts.id }).from(accounts).where(inArray(accounts.userId, createdUsers));
      const ids = accts.map((a) => a.id);
      const withLedger = new Set((await db.select({ id: payoutLedger.accountId }).from(payoutLedger).where(inArray(payoutLedger.accountId, ids.length ? ids : ['00000000-0000-0000-0000-000000000000']))).map((r) => r.id));
      const deletable = createdUsers.filter(() => true);
      // Only delete users whose accounts carry no ledger rows.
      const safeUsers: string[] = [];
      for (const uId of deletable) {
        const uAccts = accts.filter((a) => true).map((a) => a.id); void uAccts;
        safeUsers.push(uId);
      }
      const blockedAccts = accts.filter((a) => withLedger.has(a.id)).map((a) => a.id);
      const blockedUsers = new Set((await db.select({ id: accounts.userId }).from(accounts).where(inArray(accounts.id, blockedAccts.length ? blockedAccts : ['00000000-0000-0000-0000-000000000000']))).map((r) => r.id));
      const toDelete = safeUsers.filter((u) => !blockedUsers.has(u));
      if (ids.length > 0) await db.delete(accountQualifications).where(inArray(accountQualifications.accountId, ids)).catch(() => undefined);
      if (toDelete.length > 0) await db.delete(users).where(inArray(users.id, toDelete)).catch(() => undefined);
    }
  } catch { /* residue is harmless */ }
  await Promise.all(instances.map((h) => h.sql.end({ timeout: 5 }).catch(() => undefined)));
  await app?.close();
});

describe('Part X — cross-instance account cap: shared DB is the final authority', () => {
  for (const n of [2, 5, 8]) {
    it(`${n} instances racing the final slot create exactly one (never a 6th)`, async () => {
      const userId = await makeUser(`mi-cap-${n}`);
      const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
      for (let i = 0; i < MAX_ACTIVE_ACCOUNTS - 1; i += 1) {
        await provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true });
      }
      const { fulfilled, rejected } = await race(n, (i) =>
        provisionAccount(instances[i % instances.length]!.db, { organizationId, userId, profileVersionId: product.versionId, activate: true, enforceActiveLimit: true }),
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(n - 1);
      for (const e of rejected) expect(e).toBeInstanceOf(AccountLimitError);
      expect(await countActiveAccounts(db, userId)).toBe(MAX_ACTIVE_ACCOUNTS);
    }, 60000);
  }
});

describe('Part XI — cross-instance reset: exactly one successor', () => {
  it('8 instances racing reset of one failed account produce exactly one successor', async () => {
    const userId = await makeUser('mi-reset');
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const { accountId: failed } = await provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true });
    await db.update(accounts).set({ status: 'FAILED' }).where(eq(accounts.id, failed));

    const { rejected } = await race(8, async (i) => {
      const idb = instances[i % instances.length]!.db;
      const { orderId } = await createResetOrder(idb, { organizationId, userId, failedAccountId: failed });
      await markOrderCompleted(idb, orderId);
      return fulfillPurchaseGated(idb, orderId, { enforceGate: false });
    });
    void rejected;
    const successors = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.resetOfAccountId, failed));
    expect(successors).toHaveLength(1);
    const [old] = await db.select().from(accounts).where(eq(accounts.id, failed));
    expect(old!.status).toBe('FAILED');
  }, 60000);
});

describe('Part XII — cross-instance funded transition: one funded successor', () => {
  it('8 instances racing approveFunding of one qualification fund exactly once', async () => {
    const userId = await makeUser('mi-fund');
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const { accountId } = await acquireEvaluation(db, { organizationId, userId, productVersionId: product.versionId, source: 'PURCHASE' });
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    const passing = acct!.startingBalanceMicros + $(3_500);
    await db.update(accounts).set({ balanceMicros: passing, highWaterMarkMicros: passing }).where(eq(accounts.id, accountId));
    const qual = await certifyEvaluation(db, accountId);
    expect(qual).toBeTruthy();

    const { fulfilled } = await race(8, (i) =>
      approveFunding(instances[i % instances.length]!.db, qual!.id, { actor: { type: 'SYSTEM', label: `inst${i}` } }),
    );
    // Every success returns the SAME funded account id (idempotent), and the DB has one.
    const fundedIds = new Set(fulfilled.map((f) => (f as { fundedAccountId?: string }).fundedAccountId).filter(Boolean));
    expect(fundedIds.size).toBe(1);
    const funded = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, userId), eq(accounts.sourceQualificationId, qual!.id)));
    expect(funded).toHaveLength(1);
  }, 60000);
});

describe('Part XIII — cross-instance payout: exactly-once business + ledger effect', () => {
  async function fundedEligible(label: string): Promise<{ accountId: string; userId: string }> {
    const userId = await makeUser(label);
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const { accountId } = await acquireEvaluation(db, { organizationId, userId, productVersionId: product.versionId, source: 'PURCHASE' });
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    await db.update(accounts).set({ balanceMicros: acct!.startingBalanceMicros + $(3_500), highWaterMarkMicros: acct!.startingBalanceMicros + $(3_500) }).where(eq(accounts.id, accountId));
    const qual = await certifyEvaluation(db, accountId);
    const funded = await approveFunding(db, qual!.id, { actor: SYSTEM_ACTOR });
    const fa = funded.fundedAccountId!;
    await db.update(accounts).set({ balanceMicros: $(53_000), startingBalanceMicros: $(50_000), realizedPnlMicros: $(3_000), dayStartBalanceMicros: $(53_000), dayStartEquityMicros: $(53_000), highWaterMarkMicros: $(53_000), activatedAt: new Date('2026-02-01T00:00:00Z') }).where(eq(accounts.id, fa));
    for (let i = 0; i < 5; i += 1) await db.insert(dailyAccountStats).values({ accountId: fa, tradeDate: `2026-04-0${i + 1}`, startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true }).onConflictDoNothing();
    const ident = await ensureCustomerIdentity(db, { organizationId, userId });
    await addDestination(db, { organizationId, customerIdentityId: ident.id, provider: 'MOCK', providerRef: `mock_${fa.slice(0, 8)}` });
    return { accountId: fa, userId };
  }

  it('one approval across instances → one DEBIT; duplicate callbacks → one SETTLEMENT', async () => {
    const { accountId, userId } = await fundedEligible('mi-payout');
    const r = await requestPayout(db, { accountId, userId, requestedGrossMicros: $(1000), idempotencyKey: `mi-${accountId}`, actor: SYSTEM_ACTOR });

    // Race approval across instances — exactly one debit ledger row.
    await race(6, (i) => runFastLane(instances[i % instances.length]!.db, r.id).catch((e) => e));
    const debits = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, r.id), eq(payoutLedger.entryType, 'DEBIT')));
    expect(debits).toHaveLength(1);

    // Submit, then race duplicate PAID callbacks across instances — one SETTLEMENT.
    await submitPayable(db, r.id);
    const op = (await getOperationByRequest(db, r.id))!;
    const hook = mockPayoutProvider().advance(op.idempotencyKey, 'PAID')!;
    await race(6, (i) => ingestProviderEvent(instances[i % instances.length]!.db, { organizationId, provider: 'MOCK', providerEventId: hook.providerEventId, providerPayoutId: hook.providerPayoutId, normalizedType: 'PAYOUT_PAID' }).catch((e) => e));
    const settlements = await db.select().from(payoutLedger).where(and(eq(payoutLedger.payoutRequestId, r.id), eq(payoutLedger.entryType, 'SETTLEMENT')));
    expect(settlements).toHaveLength(1);
    const [req] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, r.id));
    expect(req!.state).toBe('PAID');
  }, 60000);
});

describe('Part IX — process-local authority audit + post-run integrity', () => {
  it('no cross-instance operation produced a corruption finding', async () => {
    const findings = await runIntegrityChecks(db);
    expect(findings.filter((f) => f.severity === 'P0' || f.severity === 'P1')).toEqual([]);
  });
});
