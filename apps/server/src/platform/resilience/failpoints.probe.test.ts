/**
 * Probe: confirm the FaultInjector forces a REAL Postgres rollback of a real
 * workflow transaction (not a mock). This validates the whole Phase 2 crash
 * technique. If this passes, an injected mid-transaction fault is proven to leave
 * no partial write. (Kept as a permanent guard on the harness itself.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../http/app.js';
import { getDb } from '../../db/client.js';
import { accounts, users } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { defaultOrganizationId, provisionAccount } from '../provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from '../profiles.js';
import { FaultInjector, FailpointError } from './failpoints.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const createdUsers: string[] = [];
const KEY = `fx-eval-${Math.random().toString(36).slice(2, 8)}`;

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
  createdUsers.push(u!.id);
  return u!.id;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['HTF_AUTO_FUNDING'] = 'false';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: KEY, name: 'Failpoint Eval 50K', accountType: 'EVALUATION', config: config() });
});

afterAll(async () => {
  // Best-effort cleanup; app.close() must always run so the background workers do
  // not leak into the next test file and race its shared-DB assertions.
  try {
    if (createdUsers.length > 0) await db.delete(users).where(inArray(users.id, createdUsers));
  } catch {
    /* residue is harmless on the disposable test DB */
  } finally {
    await app.close();
  }
});

describe('FaultInjector forces a real rollback (probe)', () => {
  it('a fault inside provisionAccount rolls back completely — no account, no lifecycle', async () => {
    const userId = await makeUser('fx');
    const product = await resolveProfileByKey(db, organizationId, KEY);

    // provisionAccount's transaction writes: accounts INSERT, account_lifecycles
    // INSERT, accounts UPDATE (currentLifecycleId), [provisioning_requests INSERT].
    // Trip the 2nd write (the lifecycle insert) — the account insert has already
    // happened inside the same transaction and MUST be rolled back.
    const fx = new FaultInjector().failOnWrite(2);
    await expect(
      provisionAccount(fx.wrap(db), { organizationId, userId, profileVersionId: product.versionId, activate: true }),
    ).rejects.toBeInstanceOf(FailpointError);
    expect(fx.writes).toBe(2);

    // The real database rolled the whole transaction back: zero accounts for this user.
    const rows = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it('after a rolled-back attempt, a normal retry succeeds exactly once (recover safely)', async () => {
    const userId = await makeUser('fx-retry');
    const product = await resolveProfileByKey(db, organizationId, KEY);

    const fx = new FaultInjector().failOnWrite(1); // fail the very first write
    await expect(
      provisionAccount(fx.wrap(db), { organizationId, userId, profileVersionId: product.versionId, activate: true }),
    ).rejects.toBeInstanceOf(FailpointError);
    expect(await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId))).toHaveLength(0);

    // Retry with the real handle: exactly one account exists.
    const r = await provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true });
    expect(r.accountId).toBeTruthy();
    const rows = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId));
    expect(rows).toHaveLength(1);
  });
});
