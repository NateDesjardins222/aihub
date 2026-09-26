/**
 * Phase 8 — the full product matrix, proven through the REAL runtime.
 *
 * The config-level matrix (all 10 products' locked values + family distinctions)
 * is guarded by packages/contracts product-model.test.ts. This suite proves the
 * matrix SURVIVES the runtime: for every one of the 10 commercial products it
 * resolves the seeded profile, provisions a real EVALUATION account through the
 * authoritative provisioning path, and asserts the provisioned account carries
 * that product's own pinned terms — the starting balance, the initial EOD floor,
 * the profit target, the contract limit, the consistency threshold and the
 * pinned version.
 *
 * The primary risk this defends against is PRODUCT RULE CROSS-CONTAMINATION: a
 * 50K default leaking into a 25K/100K/300K account, Select behaving like Core,
 * Daily's buffer bleeding into Core/Select, or the current version being used
 * instead of the account's pinned one. Every assertion is derived from the
 * authoritative catalog, not copied, so the test and the product move together.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { ALL_ACCOUNTS, MICROS, htfEvalKey } from '@atlas/contracts';
import { getDb } from '../db/client.js';
import { accounts, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { resolveProfileByKey } from './profiles.js';
import { reconcileHtfProducts } from './product-reconcile.js';

let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const userIds: string[] = [];

async function makeUser(label: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `pm-${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`,
      passwordHash: await hashPassword('pw'),
      displayName: `PM ${label}`,
      organizationId,
    })
    .returning();
  userIds.push(u!.id);
  return u!.id;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['HTF_AUTO_FUNDING'] = 'false';
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  // Guarantee all 10 eval + 10 funded profiles exist under THIS org (the test DB
  // carries many orgs from prior fixtures; reconcile is idempotent + version-safe).
  await reconcileHtfProducts(db, organizationId);
});

afterAll(async () => {
  if (userIds.length > 0) {
    await db.delete(accounts).where(inArray(accounts.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
});

describe('Phase 8 — full product matrix through provisioning', () => {
  // Provision one real EVALUATION account per commercial product and keep the
  // provisioned row + its resolved product for cross-checks.
  const provisioned: Array<{
    key: string;
    family: string;
    sizeUsd: number;
    row: typeof accounts.$inferSelect;
    versionId: string;
  }> = [];

  it('provisions all 10 commercial products with their OWN pinned terms (no 50K default leak)', async () => {
    for (const a of ALL_ACCOUNTS) {
      const key = htfEvalKey(a.family, a);
      const product = await resolveProfileByKey(db, organizationId, key);
      const userId = await makeUser(key);
      const { accountId } = await provisionAccount(db, {
        organizationId,
        userId,
        profileVersionId: product.versionId,
        activate: true,
      });
      const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId));
      expect(row, key).toBeTruthy();
      provisioned.push({ key, family: a.family, sizeUsd: a.sizeUsd, row: row!, versionId: product.versionId });

      // Provisioned account carries THIS product's size and initial EOD floor.
      expect(row!.startingBalanceMicros, `${key} start`).toBe(a.sizeUsd * MICROS);
      expect(row!.balanceMicros, `${key} balance`).toBe(a.sizeUsd * MICROS);
      expect(row!.highWaterMarkMicros, `${key} hwm`).toBe(a.sizeUsd * MICROS);
      // Initial floor = starting balance − EOD drawdown (e.g. 25K/$1,000 → $24,000).
      expect(row!.drawdownFloorMicros, `${key} floor`).toBe((a.sizeUsd - a.eodDrawdownUsd) * MICROS);
      expect(row!.accountType, `${key} type`).toBe('EVALUATION');
      // Pinned to the resolved version, not "the current version".
      expect(row!.profileVersionId, `${key} pinned version`).toBe(product.versionId);

      // The pinned version's rules are THIS product's rules, not a sibling's.
      const r = product.config.rules;
      expect(r.profitTargetMicros, `${key} target`).toBe(a.targetUsd * MICROS);
      expect(r.maxLossMicros, `${key} dd`).toBe(a.eodDrawdownUsd * MICROS);
      expect(r.maxContracts, `${key} minis`).toBe(a.minis);
      expect(r.drawdownType, `${key} ddtype`).toBe('EOD_TRAILING');
      expect(r.trailingLockAtMicros, `${key} lock`).toBe(0);
      // Consistency: CORE 50%, SELECT/DAILY 40%.
      const expectedEvalC = a.family === 'CORE' ? 0.5 : 0.4;
      expect(r.consistencyThreshold, `${key} evalC`).toBe(expectedEvalC);
    }
    expect(provisioned).toHaveLength(10);
  });

  it('no cross-contamination: distinct sizes never share a starting balance or floor', () => {
    // Every distinct account SIZE must map to exactly one starting balance and,
    // within a family, to exactly one floor. A 50K default leaking into a 25K
    // account would collapse two sizes onto 50,000.
    for (const p of provisioned) {
      expect(p.row.startingBalanceMicros, `${p.key} owns its size`).toBe(p.sizeUsd * MICROS);
    }
    // The four Core sizes have four different floors (25K→24k, 50K→48k, 100K→96k, 300K→290k).
    const coreFloors = provisioned
      .filter((p) => p.family === 'CORE')
      .map((p) => p.row.drawdownFloorMicros);
    expect(new Set(coreFloors).size).toBe(4);
  });

  it('family distinction survives: Select 50K floor differs from Core 50K floor', () => {
    // Same size, different family — the wider Select drawdown must NOT be replaced
    // by Core's. Core 50K DD $2,000 → floor 48,000; Select 50K DD $2,500 → 47,500.
    const core50 = provisioned.find((p) => p.key === 'htf-core-50k')!;
    const select50 = provisioned.find((p) => p.key === 'htf-select-50k')!;
    expect(core50.row.drawdownFloorMicros).toBe(48_000 * MICROS);
    expect(select50.row.drawdownFloorMicros).toBe(47_500 * MICROS);
    expect(core50.row.drawdownFloorMicros).not.toBe(select50.row.drawdownFloorMicros);
  });

  it('family distinction survives: only DAILY carries a funded buffer; only SELECT a funded consistency', async () => {
    for (const p of provisioned) {
      const product = await resolveProfileByKey(db, organizationId, p.key);
      const pr = product.config.payoutRules as {
        fundedBufferMicros: number;
        payoutConsistencyThreshold: number | null;
      };
      const buffer = pr.fundedBufferMicros;
      const fundedC = pr.payoutConsistencyThreshold;
      if (p.family === 'DAILY') {
        expect(buffer, `${p.key} daily buffer`).toBeGreaterThan(0);
        expect(fundedC, `${p.key} daily funded consistency`).toBeNull();
      } else if (p.family === 'SELECT') {
        expect(buffer, `${p.key} select buffer`).toBe(0);
        expect(fundedC, `${p.key} select funded consistency`).toBe(0.4);
      } else {
        // CORE: no buffer, no funded consistency.
        expect(buffer, `${p.key} core buffer`).toBe(0);
        expect(fundedC, `${p.key} core funded consistency`).toBeNull();
      }
    }
  });
});
