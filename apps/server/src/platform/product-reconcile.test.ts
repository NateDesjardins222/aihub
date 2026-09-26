/**
 * Product reconciliation — against the real database.
 *
 * Proves the authoritative catalog lands in the DB verbatim, that funded
 * destinations are INTERNAL (not commercial), that legacy Atlas templates are
 * retired without being deleted, and that re-running the reconciliation is a
 * no-op (idempotent). Runs in an ISOLATED organization so it never disturbs the
 * default org's products.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { htfEvalProfiles, htfFundedProfiles } from '@atlas/contracts';
import { getDb } from '../db/client.js';
import { accountProfileVersions, accountProfiles, organizations } from '../db/schema.js';
import { normalizeProfileConfig, publishProfileVersion } from './profiles.js';
import { reconcileHtfProducts } from './product-reconcile.js';

const { db, sql } = getDb();
let orgId: string;
const suffix = Math.random().toString(36).slice(2, 8);

beforeAll(async () => {
  const [org] = await db
    .insert(organizations)
    .values({ name: `reconcile-test-${suffix}`, slug: `reconcile-test-${suffix}` })
    .returning();
  orgId = org!.id;

  // Seed a legacy Atlas evaluation product in this org, so we can prove it gets
  // retired (not deleted) by the reconciliation.
  await publishProfileVersion(db, {
    organizationId: orgId,
    key: 'evaluation-50k',
    name: 'Evaluation 50K',
    accountType: 'EVALUATION',
    config: {
      rules: {
        accountSizeMicros: 50_000_000_000,
        profitTargetMicros: 3_000_000_000,
        maxLossMicros: 2_000_000_000,
        drawdownType: 'EOD_TRAILING',
        trailingLockAtMicros: 2_000_000_000,
        dailyLossLimitMicros: null,
        dailyLossPolicy: 'LOCK_DAY',
        consistencyFormula: 'BEST_DAY_OVER_TOTAL',
        consistencyThreshold: 0.5,
        minTradingDays: 0,
        minWinningDays: 0,
        maxTradingDays: null,
        minDailyPnlToCountMicros: 0,
        minWinningDayPnlMicros: 1,
        maxContracts: 5,
        microsCountAsFraction: true,
        flattenOnBreach: true,
      },
      execution: null,
      instruments: { allowed: null, maxContracts: 5, perInstrument: {} },
      display: { startingBalanceMicros: 50_000_000_000 },
      payoutRules: null,
    },
  });
});

afterAll(async () => {
  await sql.end({ timeout: 5 }).catch(() => undefined);
});

async function latestConfig(key: string) {
  const [p] = await db
    .select()
    .from(accountProfiles)
    .where(and(eq(accountProfiles.organizationId, orgId), eq(accountProfiles.key, key)));
  if (!p) return null;
  const [v] = await db
    .select()
    .from(accountProfileVersions)
    .where(eq(accountProfileVersions.profileId, p.id))
    .orderBy(desc(accountProfileVersions.version))
    .limit(1);
  return { status: p.status, accountType: p.accountType, config: v?.config ?? null, version: v?.version ?? 0 };
}

describe('reconcileHtfProducts (real DB, isolated org)', () => {
  it('publishes exactly the 10 commercial evaluations (ACTIVE) + 10 funded (INTERNAL)', async () => {
    const r = await reconcileHtfProducts(db, orgId);
    expect(r.active.sort()).toEqual(htfEvalProfiles().map((p) => p.key).sort());
    expect(r.internal).toEqual(expect.arrayContaining(htfFundedProfiles().map((p) => p.key)));
    // 20 profiles published fresh (10 eval + 10 funded).
    expect(r.published.length).toBe(20);
  });

  it('DB active version equals the authoritative builder config for every product', async () => {
    for (const p of [...htfEvalProfiles(), ...htfFundedProfiles()]) {
      const row = await latestConfig(p.key);
      expect(row, p.key).toBeTruthy();
      const dbCfg = normalizeProfileConfig(row!.config);
      const want = normalizeProfileConfig(p.config);
      expect(dbCfg, p.key).toEqual(want);
    }
  });

  it('marks funded destinations INTERNAL and evaluations ACTIVE', async () => {
    expect((await latestConfig('htf-core-50k'))!.status).toBe('ACTIVE');
    expect((await latestConfig('htf-core-50k-funded'))!.status).toBe('INTERNAL');
  });

  it('retires the legacy Atlas template without deleting it', async () => {
    const legacy = await latestConfig('evaluation-50k');
    expect(legacy).toBeTruthy(); // still present (history preserved)
    expect(legacy!.status).toBe('RETIRED');
  });

  it('is idempotent — a second run publishes no new versions', async () => {
    const before = await latestConfig('htf-core-50k');
    const r2 = await reconcileHtfProducts(db, orgId);
    expect(r2.published).toEqual([]);
    expect(r2.unchanged.length).toBe(20);
    const after = await latestConfig('htf-core-50k');
    expect(after!.version).toBe(before!.version); // no new version written
  });

  it('CORE 300K Gold and SELECT drawdowns are correct in the DB', async () => {
    const gold = normalizeProfileConfig((await latestConfig('htf-core-300k'))!.config);
    expect(gold.rules.profitTargetMicros).toBe(15_000_000_000);
    expect(gold.rules.maxLossMicros).toBe(10_000_000_000);
    expect(gold.rules.drawdownType).toBe('EOD_TRAILING');
    const sel = normalizeProfileConfig((await latestConfig('htf-select-50k'))!.config);
    expect(sel.rules.maxLossMicros).toBe(2_500_000_000);
    expect(sel.payoutRules).toBeTruthy();
  });
});
