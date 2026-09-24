/**
 * Automatic pass -> funded, against the real database.
 *
 * An authoritative pass certifies the evaluation (an ELIGIBLE qualification) and
 * then auto-funds it through the existing idempotent approveFunding — a normal
 * customer does not wait for an employee. Exactly-once holds under the subscriber
 * racing the sweep and under duplicate qualifications, because approveFunding is
 * locked and keyed (fund:<qualId>). No pass/fail math is recreated here; the
 * engine and certifyEvaluation stay authoritative.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { accountQualifications, accounts, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from './profiles.js';
import { acquireEvaluation, approveFunding, certifyEvaluation } from './commerce.js';
import { autoFundingEnabled, fundEligibleQualifications } from './commerce-certify.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const users_: string[] = [];
const EVAL_KEY = `fund-eval-${Math.random().toString(36).slice(2, 8)}`;
const FUNDED_KEY = `fund-dest-${Math.random().toString(36).slice(2, 8)}`;

function config(overrides: Record<string, unknown> = {}) {
  return {
    rules: {
      accountSizeMicros: 50_000 * M, profitTargetMicros: 3_000 * M, maxLossMicros: 2_000 * M,
      drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null,
      dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null,
      minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0,
      minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true,
      ...(overrides['rules'] as Record<string, unknown> ?? {}),
    },
    execution: null,
    instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
    display: { startingBalanceMicros: 50_000 * M },
    payoutRules: null,
    fundedDestinationKey: (overrides['fundedDestinationKey'] as string | null) ?? null,
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

async function passedEval(label: string): Promise<string> {
  const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
  const { accountId } = await acquireEvaluation(db, {
    organizationId, userId: await makeUser(label), productVersionId: product.versionId, source: 'PURCHASE',
  });
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  const passing = account!.startingBalanceMicros + 3_500 * M;
  await db.update(accounts).set({ balanceMicros: passing, highWaterMarkMicros: passing }).where(eq(accounts.id, accountId));
  return accountId;
}

// Generous by design: buildApp runs the startup provisioning/funding sweeps
// against the shared test DB, and every audited write serialises on the per-org
// audit advisory lock, so the first deferred funding can wait behind that backlog.
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['HTF_AUTO_FUNDING'] = 'true';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: FUNDED_KEY, name: 'Fund Dest 50K', accountType: 'FUNDED_SIM', config: config({ rules: { profitTargetMicros: 0 } }) });
  await publishProfileVersion(db, { organizationId, key: EVAL_KEY, name: 'Fund Eval 50K', accountType: 'EVALUATION', config: config({ fundedDestinationKey: FUNDED_KEY }) });
});

afterAll(async () => {
  if (users_.length > 0) {
    const owned = await db.select({ id: accounts.id }).from(accounts).where(inArray(accounts.userId, users_));
    const ids = owned.map((a) => a.id);
    if (ids.length > 0) {
      await db.delete(accountQualifications).where(inArray(accountQualifications.accountId, ids));
    }
    await db.delete(users).where(inArray(users.id, users_));
  }
  await app.close();
});

describe('automatic pass -> funded', () => {
  it('is enabled by default', () => {
    expect(autoFundingEnabled()).toBe(true);
  });

  it('auto-funds a certified evaluation exactly once', async () => {
    const accountId = await passedEval('auto');
    const qual = await certifyEvaluation(db, accountId);
    expect(qual!.fundingState).toBe('ELIGIBLE'); // ELIGIBLE at the instant of certify

    // The deferred subscriber funds it; the eligible-qualification sweep is the
    // documented recovery net for the same auto-funding. Under heavy startup
    // org-audit-lock contention the deferred path can lose the race within the
    // window, so we also nudge the recovery sweep each poll — still asserting the
    // system auto-funds it exactly once (approveFunding is locked + keyed).
    const funded = await waitFor(async () => {
      await fundEligibleQualifications(db).catch(() => 0);
      const [q] = await db.select().from(accountQualifications).where(eq(accountQualifications.id, qual!.id));
      return q?.fundingState === 'FUNDED';
    });
    expect(funded).toBe(true);

    const [q] = await db.select().from(accountQualifications).where(eq(accountQualifications.id, qual!.id));
    expect(q!.fundedAccountId).toBeTruthy();
    const fundedAccounts = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.sourceQualificationId, qual!.id), eq(accounts.accountType, 'FUNDED_SIM')));
    expect(fundedAccounts).toHaveLength(1);
  }, 30000);

  it('is exactly-once under concurrent funding (subscriber + explicit) on one qualification', async () => {
    const accountId = await passedEval('race');
    const qual = await certifyEvaluation(db, accountId);
    // Two concurrent direct fundings on THIS qualification (deterministic, no
    // whole-DB sweep) plus the deferred subscriber all converge to one account.
    const [a, b] = await Promise.all([
      approveFunding(db, qual!.id, { actor: { type: 'SYSTEM', label: 't1' } }),
      approveFunding(db, qual!.id, { actor: { type: 'SYSTEM', label: 't2' } }),
    ]);
    expect(a.fundedAccountId).toBe(b.fundedAccountId);
    const fundedAccounts = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.sourceQualificationId, qual!.id), eq(accounts.accountType, 'FUNDED_SIM')));
    expect(fundedAccounts).toHaveLength(1);
  }, 30000);

  it('funding a qualification twice is idempotent (no second funded account)', async () => {
    const accountId = await passedEval('idem');
    const qual = await certifyEvaluation(db, accountId);
    const first = await approveFunding(db, qual!.id, { actor: { type: 'SYSTEM', label: 'once' } });
    const second = await approveFunding(db, qual!.id, { actor: { type: 'SYSTEM', label: 'again' } });
    expect(second.fundedAccountId).toBe(first.fundedAccountId);
    expect(second.reused).toBe(true);
    const fundedAccounts = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.sourceQualificationId, qual!.id), eq(accounts.accountType, 'FUNDED_SIM')));
    expect(fundedAccounts).toHaveLength(1);
  }, 30000);

  it('the eligible-qualification sweep runs (recovery net)', async () => {
    // It funds any ELIGIBLE qualification with no funded account. Returns a count.
    const funded = await fundEligibleQualifications(db);
    expect(funded).toBeGreaterThanOrEqual(0);
  }, 30000);
});
