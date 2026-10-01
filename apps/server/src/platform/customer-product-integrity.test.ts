/**
 * Customer Product Integrity — provenance detectors (Phase 1).
 *
 * Proves the three new read-only integrity detectors actually DETECT the broken
 * business states this phase is about, and that the seeded business data is clean:
 *  - INV_STRANDED_PURCHASE    — paid order with no account past the window
 *  - INV_ORPHAN_ACCOUNT       — account with no terms source
 *  - INV_OWNERSHIP_MISMATCH   — order/entitlement/account owners disagree
 *
 * Detectors are read-only; this test injects minimal bad rows, asserts the
 * detector flips to FAIL, and cleans them up (no silent repair).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { accounts, accountProfileVersions, commercialOrders, entitlements, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { runIntegrityChecks } from './integrity.js';

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
let productVersionId: string;
const userIds: string[] = [];
const accountIds: string[] = [];
const orderIds: string[] = [];
const entitlementIds: string[] = [];

async function makeUser(label: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${label}-${crypto.randomUUID().slice(0, 8)}@cpi.test`, passwordHash: await hashPassword('pw'), displayName: label, organizationId })
    .returning();
  userIds.push(u!.id);
  return u!.id;
}

async function check(key: string): Promise<{ status: string; affectedCount: number }> {
  const report = await runIntegrityChecks(db, organizationId, false);
  const c = report.checks.find((x) => x.key === key);
  if (!c) throw new Error(`missing check ${key}`);
  return { status: c.status, affectedCount: c.affectedCount };
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  const [pv] = await db.select({ id: accountProfileVersions.id }).from(accountProfileVersions).limit(1);
  productVersionId = pv!.id;
});

afterAll(async () => {
  if (entitlementIds.length) await db.delete(entitlements).where(inArray(entitlements.id, entitlementIds));
  if (orderIds.length) await db.delete(commercialOrders).where(inArray(commercialOrders.id, orderIds));
  if (accountIds.length) await db.delete(accounts).where(inArray(accounts.id, accountIds));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  await app.close();
});

describe('Customer Product Integrity — provenance detectors', () => {
  it('all three detectors run and the seeded business data is clean', async () => {
    const report = await runIntegrityChecks(db, organizationId, false);
    const keys = report.checks.map((c) => c.key);
    expect(keys).toContain('INV_STRANDED_PURCHASE');
    expect(keys).toContain('INV_ORPHAN_ACCOUNT');
    expect(keys).toContain('INV_OWNERSHIP_MISMATCH');
    for (const k of ['INV_STRANDED_PURCHASE', 'INV_ORPHAN_ACCOUNT', 'INV_OWNERSHIP_MISMATCH']) {
      expect((report.checks.find((c) => c.key === k))!.status, k).toBe('PASS');
    }
  });

  it('INV_ORPHAN_ACCOUNT detects an account with no terms source', async () => {
    const uid = await makeUser('orphan');
    const [a] = await db
      .insert(accounts)
      .values({ userId: uid, organizationId, name: 'ORPHAN', accountType: 'EVALUATION', status: 'ACTIVE', startingBalanceMicros: 50_000 * 1_000_000, balanceMicros: 50_000 * 1_000_000, realizedPnlMicros: 0, feesMicros: 0, highWaterMarkMicros: 50_000 * 1_000_000, drawdownFloorMicros: 48_000 * 1_000_000, dayStartBalanceMicros: 50_000 * 1_000_000, dayStartEquityMicros: 50_000 * 1_000_000, bestDayProfitMicros: 0, profileVersionId: null, ruleTemplateId: null })
      .returning();
    accountIds.push(a!.id);
    const r = await check('INV_ORPHAN_ACCOUNT');
    expect(r.status).toBe('FAIL');
    expect(r.affectedCount).toBeGreaterThanOrEqual(1);
  });

  it('INV_OWNERSHIP_MISMATCH detects an entitlement consumed by another customer’s account', async () => {
    const a = await makeUser('own-a');
    const b = await makeUser('own-b');
    const [acctB] = await db
      .insert(accounts)
      .values({ userId: b, organizationId, name: 'B-ACCT', accountType: 'EVALUATION', status: 'ACTIVE', startingBalanceMicros: 50_000 * 1_000_000, balanceMicros: 50_000 * 1_000_000, realizedPnlMicros: 0, feesMicros: 0, highWaterMarkMicros: 50_000 * 1_000_000, drawdownFloorMicros: 48_000 * 1_000_000, dayStartBalanceMicros: 50_000 * 1_000_000, dayStartEquityMicros: 50_000 * 1_000_000, bestDayProfitMicros: 0, profileVersionId: productVersionId })
      .returning();
    accountIds.push(acctB!.id);
    const [ent] = await db
      .insert(entitlements)
      .values({ organizationId, userId: a, productVersionId, kind: 'EVALUATION', source: 'PURCHASE', status: 'CONSUMED', consumedByAccountId: acctB!.id })
      .returning();
    entitlementIds.push(ent!.id);
    const r = await check('INV_OWNERSHIP_MISMATCH');
    expect(r.status).toBe('FAIL');
    expect(r.affectedCount).toBeGreaterThanOrEqual(1);
  });

  it('INV_STRANDED_PURCHASE detects a retained-money order with no account past the window', async () => {
    const uid = await makeUser('stranded');
    const [o] = await db
      .insert(commercialOrders)
      .values({ organizationId, userId: uid, productVersionId, source: 'PURCHASE', status: 'COMPLETED', createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .returning();
    orderIds.push(o!.id);
    const r = await check('INV_STRANDED_PURCHASE');
    expect(r.status).toBe('FAIL');
    expect(r.affectedCount).toBeGreaterThanOrEqual(1);
  });
});
