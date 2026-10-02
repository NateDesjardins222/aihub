/**
 * Pre-Whop commerce readiness (§6/§7/§8/§30): exactly-once account provisioning
 * for DIRECT callers of provisionAccount under truly-concurrent identical-key
 * delivery. The commerce/funding paths already serialise on a FOR UPDATE lock on
 * the entitlement/qualification; the direct admin/machine callers did not. The
 * per-(org, idempotency-key) advisory lock added in provisionAccount closes that
 * window at the database, so even two racers that both miss the pre-tx SELECT make
 * exactly one account. Runs against the real database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { accounts, provisioningRequests, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { provisionAccount, ProvisioningError } from './provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from './profiles.js';

const M = 1_000_000;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const created: string[] = [];
const KEY = `prov-idem-${Math.random().toString(36).slice(2, 8)}`;

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
  const [u] = await db.insert(users).values({
    email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`,
    passwordHash: await hashPassword('prov-idem-password'),
    displayName: label, organizationId,
  }).returning();
  created.push(u!.id);
  return u!.id;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, {
    organizationId, key: KEY, name: 'Evaluation 50K (Idem)',
    accountType: 'EVALUATION', config: config(),
  });
});

afterAll(async () => {
  if (created.length) {
    await db.delete(provisioningRequests).where(inArray(provisioningRequests.organizationId, [organizationId]));
    await db.delete(accounts).where(inArray(accounts.userId, created));
    await db.delete(users).where(inArray(users.id, created));
  }
  await app.close();
});

describe('provisionAccount — direct-caller exactly-once', () => {
  it('N concurrent identical-key provisions create exactly one account', async () => {
    const userId = await makeUser('prov-race');
    const { versionId } = await resolveProfileByKey(db, organizationId, KEY);
    const idempotencyKey = `direct:${crypto.randomUUID()}`;
    const input = {
      organizationId, userId, profileVersionId: versionId,
      idempotencyKey, enforceActiveLimit: false as const,
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => provisionAccount(db, input)),
    );

    const ids = new Set(results.map((r) => r.accountId));
    expect(ids.size).toBe(1); // exactly one account despite 8 racers
    expect(results.filter((r) => !r.reused)).toHaveLength(1); // exactly one did the insert

    const rows = await db.select().from(accounts).where(eq(accounts.userId, userId));
    expect(rows).toHaveLength(1); // the database holds exactly one

    const reqRows = await db
      .select()
      .from(provisioningRequests)
      .where(and(eq(provisioningRequests.organizationId, organizationId), eq(provisioningRequests.idempotencyKey, idempotencyKey)));
    expect(reqRows).toHaveLength(1); // one mapping, pointing at the one account
    expect(reqRows[0]!.accountId).toBe([...ids][0]);
  });

  it('the same key with a different body is rejected, not a second account', async () => {
    const userId = await makeUser('prov-conflict');
    const { versionId } = await resolveProfileByKey(db, organizationId, KEY);
    const idempotencyKey = `direct:${crypto.randomUUID()}`;
    const first = await provisionAccount(db, {
      organizationId, userId, profileVersionId: versionId, idempotencyKey, enforceActiveLimit: false,
    });
    expect(first.reused).toBe(false);

    await expect(
      provisionAccount(db, {
        organizationId, userId, profileVersionId: versionId, idempotencyKey,
        startingBalanceMicros: 99_999 * M, enforceActiveLimit: false,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    void ProvisioningError;

    const rows = await db.select().from(accounts).where(eq(accounts.userId, userId));
    expect(rows).toHaveLength(1);
  });
});
