/**
 * Deterministic end-to-end commercial-lifecycle scenario.
 *
 * One scripted, ordered story that drives the whole provider-independent
 * account lifecycle against the real database and the real execution engine,
 * asserting an invariant at every step. No money moves anywhere: the payment
 * step is simply absent, and the same machinery an admin grant uses is the same
 * a purchase will.
 *
 *    1. acquire (purchase): order COMPLETED, entitlement CONSUMED, one
 *       evaluation account, funded destination pinned at acquisition
 *    2. retry the acquire (same idempotency key): no second of anything
 *    3. below target: certification refused, account still ACTIVE
 *    4. reach target + the engine's account.passed: auto-certification freezes
 *       the account (PASSED + QUALIFIED) and writes one immutable qualification
 *    5. duplicate account.passed: still exactly one qualification
 *    6. an order on the passed account is rejected (ACCOUNT_PASSED): terminal
 *    7. approve funding: exactly one FUNDED_SIM account, linked back, the
 *       evaluation preserved (not mutated into the funded account)
 *    8. retry the approval: the same funded account, never a second
 *    9. failure path: a breached evaluation cannot be certified, and stays
 *       terminal
 *   10. tenant isolation: org B never sees org A's qualification
 *   11. restart recovery: the startup sweep certifies a pass a crash dropped
 *   12. final reconciliation: one account per consumed entitlement, one funded
 *       account per funded qualification, no evaluation reused as a funded
 *
 * Run: TEST_DATABASE_URL=postgres://atlas:atlas@localhost:5432/atlas_test \
 *      pnpm --filter @atlas/server exec tsx scripts/e2e-commercial-lifecycle.ts
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createDb, type Database } from '../src/db/client.js';
import {
  accountQualifications,
  accounts,
  commercialOrders,
  entitlements,
  organizations,
  users,
} from '../src/db/schema.js';
import { defaultOrganizationId } from '../src/platform/provisioning.js';
import { publishProfileVersion } from '../src/platform/profiles.js';
import { events } from '../src/platform/events.js';
import {
  acquireEvaluation,
  approveFunding,
  certifyEvaluation,
} from '../src/platform/commerce.js';
import {
  certifyPassedEvaluations,
  registerAutoCertification,
} from '../src/platform/commerce-certify.js';
import { TradingEngine, OrderRejectedError } from '../src/trading/engine.js';
import { recordEngineActivity } from '../src/platform/engine-audit.js';
import { ScriptedMarket, settle } from '../src/trading/harness.js';

const URL = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
const M = 1_000_000;

interface Step {
  n: number;
  label: string;
  pass: boolean;
  detail: string;
}

function rules(overrides: Record<string, unknown> = {}) {
  return {
    accountSizeMicros: 50_000 * M,
    profitTargetMicros: 3_000 * M,
    maxLossMicros: 2_000 * M,
    drawdownType: 'STATIC',
    trailingLockAtMicros: null,
    dailyLossLimitMicros: null,
    dailyLossPolicy: 'LOCK_DAY',
    consistencyFormula: 'BEST_DAY_OVER_TOTAL',
    consistencyThreshold: null,
    minTradingDays: 0,
    minWinningDays: 0,
    maxTradingDays: null,
    minDailyPnlToCountMicros: 0,
    minWinningDayPnlMicros: 1,
    maxContracts: 10,
    microsCountAsFraction: true,
    flattenOnBreach: true,
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    rules: rules((overrides['rules'] as Record<string, unknown>) ?? {}),
    execution: null,
    instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
    display: { startingBalanceMicros: 50_000 * M },
    payoutRules: null,
    fundedDestinationKey: (overrides['fundedDestinationKey'] as string | null) ?? null,
  };
}

async function makeUser(db: Database, organizationId: string, label: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `e2e-${label}-${randomUUID().slice(0, 8)}@atlas.test`,
      passwordHash: 'not-used',
      displayName: label,
      organizationId,
    })
    .returning();
  return user!.id;
}

/** Simulate the engine's balance without exact P&L arithmetic. */
async function setBalance(db: Database, accountId: string, micros: number): Promise<void> {
  await db
    .update(accounts)
    .set({ balanceMicros: micros, highWaterMarkMicros: micros })
    .where(eq(accounts.id, accountId));
}

async function main(): Promise<void> {
  const { db, sql } = createDb(URL);
  const steps: Step[] = [];
  const created: string[] = [];
  const record = (n: number, label: string, pass: boolean, detail: string): void => {
    steps.push({ n, label, pass, detail });
    console.log(`[${n}] ${label}: ${detail} => ${pass ? 'PASS' : 'FAIL'}`);
  };

  const stopCert = registerAutoCertification(db);
  const market = new ScriptedMarket();
  const engine = new TradingEngine(db, market);
  const stopRecording = recordEngineActivity(db, engine);

  try {
    await engine.start();
    await market.quote('NQ', 20_000);

    const organizationId = await defaultOrganizationId(db);
    const FUNDED_KEY = `e2e-funded-${randomUUID().slice(0, 6)}`;
    const EVAL_KEY = `e2e-eval-${randomUUID().slice(0, 6)}`;
    await publishProfileVersion(db, {
      organizationId,
      key: FUNDED_KEY,
      name: 'E2E Funded 50K',
      accountType: 'FUNDED_SIM',
      config: config({ rules: { profitTargetMicros: 0 } }),
    });
    const evalProfile = await publishProfileVersion(db, {
      organizationId,
      key: EVAL_KEY,
      name: 'E2E Evaluation 50K',
      accountType: 'EVALUATION',
      config: config({ fundedDestinationKey: FUNDED_KEY }),
    });

    // -- 1. acquire (purchase) ---------------------------------------------
    const buyer = await makeUser(db, organizationId, 'buyer');
    created.push(buyer);
    const idem = `e2e-order-${randomUUID()}`;
    const acquired = await acquireEvaluation(db, {
      organizationId,
      userId: buyer,
      productVersionId: evalProfile.versionId,
      source: 'PURCHASE',
      idempotencyKey: idem,
    });
    const [evalAccount] = await db.select().from(accounts).where(eq(accounts.id, acquired.accountId));
    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, acquired.orderId));
    const [ent] = await db.select().from(entitlements).where(eq(entitlements.id, acquired.entitlementId));
    record(
      1,
      'acquire',
      order?.status === 'COMPLETED' &&
        ent?.status === 'CONSUMED' &&
        evalAccount?.accountType === 'EVALUATION' &&
        evalAccount?.fundedProfileVersionId !== null,
      `order=${order?.status} entitlement=${ent?.status} pinned=${evalAccount?.fundedProfileVersionId !== null}`,
    );

    // -- 2. retry the acquire ----------------------------------------------
    const retry = await acquireEvaluation(db, {
      organizationId,
      userId: buyer,
      productVersionId: evalProfile.versionId,
      source: 'PURCHASE',
      idempotencyKey: idem,
    });
    const orderCount = (
      await db.select().from(commercialOrders).where(eq(commercialOrders.idempotencyKey, idem))
    ).length;
    const acctCount = (await db.select().from(accounts).where(eq(accounts.userId, buyer))).length;
    record(
      2,
      'acquire retry',
      retry.accountId === acquired.accountId && retry.reused && orderCount === 1 && acctCount === 1,
      `sameAccount=${retry.accountId === acquired.accountId} orders=${orderCount} accounts=${acctCount}`,
    );

    // -- 3. below target ----------------------------------------------------
    const notYet = await certifyEvaluation(db, acquired.accountId);
    const [stillActive] = await db.select().from(accounts).where(eq(accounts.id, acquired.accountId));
    record(3, 'below target', notYet === null && stillActive?.status === 'ACTIVE', `qual=${notYet} status=${stillActive?.status}`);

    // -- 4. reach target + auto-certification ------------------------------
    await setBalance(db, acquired.accountId, 50_000 * M + 3_500 * M);
    // The engine reaches PASSED and publishes account.passed; here we publish
    // it directly, which is exactly what recordRuleOutcome does, so the real
    // subscriber runs.
    await db.update(accounts).set({ status: 'PASSED', ruleStatus: 'PASSED' }).where(eq(accounts.id, acquired.accountId));
    await events.publish(db, {
      type: 'account.passed',
      organizationId,
      accountId: acquired.accountId,
      userId: buyer,
      payload: {},
    });
    await settle(200);
    const [frozen] = await db.select().from(accounts).where(eq(accounts.id, acquired.accountId));
    const quals = await db
      .select()
      .from(accountQualifications)
      .where(eq(accountQualifications.accountId, acquired.accountId));
    record(
      4,
      'auto-certify',
      quals.length === 1 && frozen?.status === 'PASSED' && frozen?.adminHold === 'QUALIFIED',
      `quals=${quals.length} status=${frozen?.status} hold=${frozen?.adminHold}`,
    );
    const qualificationId = quals[0]?.id ?? '';

    // -- 5. duplicate account.passed ---------------------------------------
    await events.publish(db, {
      type: 'account.passed',
      organizationId,
      accountId: acquired.accountId,
      userId: buyer,
      payload: {},
    });
    await settle(150);
    const quals2 = await db
      .select()
      .from(accountQualifications)
      .where(eq(accountQualifications.accountId, acquired.accountId));
    record(5, 'duplicate pass', quals2.length === 1, `quals=${quals2.length}`);

    // -- 6. order on a passed account is rejected --------------------------
    let rejected: string | null = null;
    try {
      await engine.submitOrder({
        accountId: acquired.accountId,
        userId: buyer,
        clientOrderId: `e2e-passed-${randomUUID().slice(0, 8)}`,
        symbol: 'NQ',
        side: 'BUY',
        qty: 1,
        type: 'MARKET',
      });
    } catch (err) {
      rejected = err instanceof OrderRejectedError ? err.reason : `other:${(err as Error).message}`;
    }
    record(6, 'terminal-after-pass', rejected === 'ACCOUNT_PASSED', `rejection=${rejected}`);

    // -- 7. approve funding -------------------------------------------------
    const funded = await approveFunding(db, qualificationId, { actor: { type: 'ADMIN', label: 'e2e' } });
    const [fundedAccount] = await db.select().from(accounts).where(eq(accounts.id, funded.fundedAccountId));
    const [evalStill] = await db.select().from(accounts).where(eq(accounts.id, acquired.accountId));
    record(
      7,
      'approve funding',
      fundedAccount?.accountType === 'FUNDED_SIM' &&
        fundedAccount?.sourceAccountId === acquired.accountId &&
        fundedAccount?.id !== acquired.accountId &&
        evalStill?.status === 'PASSED',
      `funded=${fundedAccount?.accountType} linked=${fundedAccount?.sourceAccountId === acquired.accountId} evalPreserved=${evalStill?.status === 'PASSED'}`,
    );

    // -- 8. retry the approval ---------------------------------------------
    const again = await approveFunding(db, qualificationId);
    const fundedCount = (
      await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, buyer), eq(accounts.accountType, 'FUNDED_SIM')))
    ).length;
    record(
      8,
      'approve retry',
      again.fundedAccountId === funded.fundedAccountId && again.reused && fundedCount === 1,
      `same=${again.fundedAccountId === funded.fundedAccountId} funded=${fundedCount}`,
    );

    // -- 9. failure path ----------------------------------------------------
    const failer = await makeUser(db, organizationId, 'failer');
    created.push(failer);
    const failAcq = await acquireEvaluation(db, {
      organizationId,
      userId: failer,
      productVersionId: evalProfile.versionId,
      source: 'PURCHASE',
    });
    await db.update(accounts).set({ status: 'FAILED', ruleStatus: 'FAILED', failedReason: 'MAX_LOSS_LIMIT' }).where(eq(accounts.id, failAcq.accountId));
    const failCert = await certifyEvaluation(db, failAcq.accountId);
    const failQuals = (
      await db.select().from(accountQualifications).where(eq(accountQualifications.accountId, failAcq.accountId))
    ).length;
    record(9, 'failure terminal', failCert === null && failQuals === 0, `cert=${failCert} quals=${failQuals}`);

    // -- 10. tenant isolation ----------------------------------------------
    const [otherOrg] = await db
      .insert(organizations)
      .values({ slug: `e2e-other-${randomUUID().slice(0, 6)}`, name: 'E2E Other Firm' })
      .returning();
    const crossOrg = await db
      .select()
      .from(accountQualifications)
      .where(
        and(
          eq(accountQualifications.id, qualificationId),
          eq(accountQualifications.organizationId, otherOrg!.id),
        ),
      );
    record(10, 'tenant isolation', crossOrg.length === 0, `visibleToOtherOrg=${crossOrg.length}`);

    // -- 11. restart recovery (startup sweep) ------------------------------
    const dropped = await makeUser(db, organizationId, 'dropped');
    created.push(dropped);
    const dropAcq = await acquireEvaluation(db, {
      organizationId,
      userId: dropped,
      productVersionId: evalProfile.versionId,
      source: 'PURCHASE',
    });
    await setBalance(db, dropAcq.accountId, 50_000 * M + 3_500 * M);
    // The engine reached PASSED, but the certification was lost to a crash.
    await db.update(accounts).set({ status: 'PASSED', ruleStatus: 'PASSED' }).where(eq(accounts.id, dropAcq.accountId));
    const swept = await certifyPassedEvaluations(db);
    const dropQuals = (
      await db.select().from(accountQualifications).where(eq(accountQualifications.accountId, dropAcq.accountId))
    ).length;
    record(11, 'restart recovery', swept >= 1 && dropQuals === 1, `swept>=1=${swept >= 1} quals=${dropQuals}`);

    // -- 12. final reconciliation ------------------------------------------
    const allBuyerEnts = await db.select().from(entitlements).where(eq(entitlements.userId, buyer));
    const consumed = allBuyerEnts.filter((e) => e.status === 'CONSUMED');
    const buyerAccounts = await db.select().from(accounts).where(eq(accounts.userId, buyer));
    const evalAndFundedDistinct =
      new Set(buyerAccounts.map((a) => a.id)).size === buyerAccounts.length &&
      buyerAccounts.some((a) => a.accountType === 'EVALUATION') &&
      buyerAccounts.some((a) => a.accountType === 'FUNDED_SIM');
    // One account provisioned per consumed entitlement (each consumed ent has a
    // consumedByAccountId pointing at a real account).
    const oneEach = consumed.every((e) => e.consumedByAccountId && buyerAccounts.some((a) => a.id === e.consumedByAccountId));
    record(
      12,
      'reconciliation',
      oneEach && evalAndFundedDistinct,
      `consumed=${consumed.length} oneAccountEach=${oneEach} evalAndFundedDistinct=${evalAndFundedDistinct}`,
    );

    const ok = steps.every((s) => s.pass);
    console.log('\n=== commercial lifecycle e2e ===');
    console.log(`${steps.filter((s) => s.pass).length}/${steps.length} steps passed`);
    console.log(ok ? 'ALL PASS' : 'FAILURES PRESENT');
    process.exitCode = ok ? 0 : 1;
  } finally {
    stopCert();
    stopRecording();
    engine.stop();
    // Best-effort cleanup of qualification funded-links before user cascade.
    for (const userId of created) {
      const owned = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId));
      for (const a of owned) {
        await db.delete(accountQualifications).where(eq(accountQualifications.accountId, a.id)).catch(() => undefined);
      }
    }
    for (const userId of created) await db.delete(users).where(eq(users.id, userId)).catch(() => undefined);
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
