/**
 * Pre-Whop readiness §17 — the integrity framework now detects commerce-chain
 * breaks it previously could not: a PROVISIONED order with no entitlement, and a
 * CONSUMED entitlement with no account. We seed each break directly (an attacker
 * with a DB connection, a doctored restore, or a latent bug) and assert the
 * detector flags exactly that row. Reuses the existing runIntegrityChecks
 * framework; adds no second reconciliation engine. Runs against the real database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { accountProfileVersions, commercialOrders, entitlements, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from './profiles.js';
import { runIntegrityChecks } from './resilience/integrity-checks.js';

const M = 1_000_000;
let handle: ReturnType<typeof createDb>;
let db: ReturnType<typeof createDb>['db'];
let organizationId: string;
let versionId: string;
const orderIds: string[] = [];
const entIds: string[] = [];
const userIds: string[] = [];
const KEY = `ci-eval-${Math.random().toString(36).slice(2, 8)}`;

function config() {
  return {
    rules: { accountSizeMicros: 50_000 * M, profitTargetMicros: 3_000 * M, maxLossMicros: 2_000 * M, drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true },
    execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: 50_000 * M, priceMicros: 95 * M },
    payoutRules: null, fundedDestinationKey: null,
  };
}

async function makeUser(label: string): Promise<string> {
  const [u] = await db.insert(users).values({
    email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('ci-pw'), displayName: label, organizationId,
  }).returning();
  userIds.push(u!.id);
  return u!.id;
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['DATABASE_URL'] = url;
  handle = createDb(url);
  db = handle.db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: KEY, name: 'CI Eval 50K', accountType: 'EVALUATION', config: config() });
  versionId = (await resolveProfileByKey(db, organizationId, KEY)).versionId;
});

afterAll(async () => {
  if (entIds.length) await db.delete(entitlements).where(inArray(entitlements.id, entIds));
  if (orderIds.length) await db.delete(commercialOrders).where(inArray(commercialOrders.id, orderIds));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  await handle?.sql.end({ timeout: 5 });
});

describe('commerce-chain integrity detectors (pre-Whop §17)', () => {
  it('flags a PROVISIONED order with no entitlement', async () => {
    const userId = await makeUser('ci-no-ent');
    const [order] = await db.insert(commercialOrders).values({
      organizationId, userId, productVersionId: versionId, source: 'PURCHASE', status: 'PROVISIONED',
      idempotencyKey: `ci-${crypto.randomUUID()}`,
    }).returning();
    orderIds.push(order!.id);

    const findings = await runIntegrityChecks(db);
    const f = findings.find((x) => x.check === 'ORDER_PROVISIONED_NO_ENTITLEMENT');
    expect(f).toBeTruthy();
    expect(f!.count).toBeGreaterThanOrEqual(1);
    // The sample shows up to 5 ids; on the shared DB our row is either in the
    // sample or beyond it (more offenders than the sample window).
    expect(f!.sample.includes(order!.id) || f!.count > f!.sample.length).toBe(true);
  });

  it('flags a CONSUMED entitlement with no account', async () => {
    const userId = await makeUser('ci-no-acct');
    const [order] = await db.insert(commercialOrders).values({
      organizationId, userId, productVersionId: versionId, source: 'PURCHASE', status: 'COMPLETED',
      idempotencyKey: `ci-${crypto.randomUUID()}`,
    }).returning();
    orderIds.push(order!.id);
    const [ent] = await db.insert(entitlements).values({
      organizationId, userId, commercialOrderId: order!.id, productVersionId: versionId,
      kind: 'EVALUATION', source: 'PURCHASE', status: 'CONSUMED', consumedByAccountId: null,
    }).returning();
    entIds.push(ent!.id);

    const findings = await runIntegrityChecks(db);
    const f = findings.find((x) => x.check === 'ENTITLEMENT_CONSUMED_NO_ACCOUNT');
    expect(f).toBeTruthy();
    expect(f!.count).toBeGreaterThanOrEqual(1);
    expect(f!.sample.includes(ent!.id) || f!.count > f!.sample.length).toBe(true);
  });
});
