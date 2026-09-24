/**
 * Trader Personal Risk Controls — durable CRUD service (M5-E) against the test DB.
 * Deterministic; proves persistence, typed-value round-trip, OFF-preserves-value,
 * ownership scoping, validation, locked-mode (tighten-only), concurrency CAS,
 * and lifecycle restrictions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, ruleTemplates, traderRiskControls, users } from '../db/schema.js';
import { defaultOrganizationId } from './provisioning.js';
import {
  getDayState,
  getPersonalRiskProfile,
  hasEnabledControls,
  loadPersonalConfig,
  upsertPersonalControl,
  PersonalControlError,
} from './personal-risk.js';

const M = 1_000_000;
let db: Database;
let sql: ReturnType<typeof createDb>['sql'];
let organizationId: string;
let userId: string;
const accountIds: string[] = [];

async function makeAccount(status = 'ACTIVE', tradeDate = '2026-06-15'): Promise<string> {
  const size = 100_000 * M;
  const [tpl] = await db.insert(ruleTemplates).values({
    name: `PR Tpl ${crypto.randomUUID().slice(0, 6)}`, accountType: 'FUNDED_SIM', accountSizeMicros: size,
    profitTargetMicros: 1_000_000 * M, maxLossMicros: size, drawdownType: 'STATIC', trailingLockAtMicros: null,
    dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL',
    consistencyThreshold: null, maxContracts: 50, microsCountAsFraction: false, minTradingDays: 0, minWinningDays: 0,
    maxTradingDays: null, minDailyPnlToCountMicros: 0, flattenOnBreach: true, payoutRules: {},
  }).returning();
  const [a] = await db.insert(accounts).values({
    organizationId, userId, ruleTemplateId: tpl!.id, name: `PR Acct ${crypto.randomUUID().slice(0, 6)}`,
    accountType: 'FUNDED_SIM', status, startingBalanceMicros: size, balanceMicros: size,
    highWaterMarkMicros: size, drawdownFloorMicros: 0, dayStartBalanceMicros: size, dayStartEquityMicros: size,
    currentTradeDate: tradeDate, simulationEnvironment: null as never, instrumentLimits: null,
  }).returning();
  accountIds.push(a!.id);
  return a!.id;
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  const handle = createDb(url); db = handle.db; sql = handle.sql;
  organizationId = await defaultOrganizationId(db);
  const [u] = await db.insert(users).values({ email: `pr-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: 'x', displayName: 'PR', organizationId }).returning();
  userId = u!.id;
});

afterAll(async () => {
  if (accountIds.length) {
    await db.delete(traderRiskControls).where(inArray(traderRiskControls.accountId, accountIds));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
  await db.delete(users).where(eq(users.id, userId));
  await sql.end({ timeout: 5 });
});

const owner = () => ({ ownerUserId: userId, actorUserId: userId });

describe('CRUD + persistence (M5-E)', () => {
  it('C01 defaults to a full set of disabled controls', async () => {
    const acct = await makeAccount();
    const profile = await getPersonalRiskProfile(db, acct);
    expect(profile.controls.length).toBe(10);
    expect(profile.controls.every((c) => !c.enabled)).toBe(true);
    expect(profile.editable).toBe(true);
  });

  it('C02 typing a value while disabled persists the value but leaves it OFF', async () => {
    const acct = await makeAccount();
    await upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'MAX_TRADES', enabled: false, mode: 'FLEXIBLE', value: { valueInt: 3 } });
    const profile = await getPersonalRiskProfile(db, acct);
    const c = profile.controls.find((x) => x.controlType === 'MAX_TRADES')!;
    expect(c.enabled).toBe(false);
    expect(c.valueInt).toBe(3);
    // The gate sees it as disabled → no enabled controls.
    expect(await hasEnabledControls(db, acct)).toBe(false);
  });

  it('C03 switching ON enables; switching OFF preserves the value', async () => {
    const acct = await makeAccount();
    await upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'DAILY_LOSS_LIMIT', enabled: true, mode: 'FLEXIBLE', value: { valueMicros: 500 * M } });
    expect(await hasEnabledControls(db, acct)).toBe(true);
    await upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'DAILY_LOSS_LIMIT', enabled: false, mode: 'FLEXIBLE', value: { valueMicros: 500 * M } });
    const cfg = await loadPersonalConfig(db, acct);
    const c = cfg.get('DAILY_LOSS_LIMIT')!;
    expect(c.enabled).toBe(false);
    expect(c.valueMicros).toBe(500 * M); // preserved
  });

  it('C04 validation rejects a bad value when enabling (no silent clamp)', async () => {
    const acct = await makeAccount();
    await expect(
      upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'DAILY_LOSS_LIMIT', enabled: true, mode: 'FLEXIBLE', value: { valueMicros: -5 } }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('locked mode (M5-G) — tighten only', () => {
  it('C05 a locked control cannot be disabled or loosened, but can be tightened', async () => {
    const acct = await makeAccount('ACTIVE', '2026-06-15');
    await upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'DAILY_LOSS_LIMIT', enabled: true, mode: 'LOCKED', value: { valueMicros: 500 * M } });
    const profile = await getPersonalRiskProfile(db, acct);
    expect(profile.controls.find((c) => c.controlType === 'DAILY_LOSS_LIMIT')!.locked).toBe(true);

    // Cannot disable.
    await expect(
      upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'DAILY_LOSS_LIMIT', enabled: false, mode: 'LOCKED', value: { valueMicros: 500 * M } }),
    ).rejects.toMatchObject({ code: 'LOCKED' });
    // Cannot loosen ($500 → $700).
    await expect(
      upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'DAILY_LOSS_LIMIT', enabled: true, mode: 'LOCKED', value: { valueMicros: 700 * M } }),
    ).rejects.toMatchObject({ code: 'LOCKED' });
    // Cannot unlock to FLEXIBLE.
    await expect(
      upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'DAILY_LOSS_LIMIT', enabled: true, mode: 'FLEXIBLE', value: { valueMicros: 500 * M } }),
    ).rejects.toMatchObject({ code: 'LOCKED' });
    // CAN tighten ($500 → $400).
    const tightened = await upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'DAILY_LOSS_LIMIT', enabled: true, mode: 'LOCKED', value: { valueMicros: 400 * M } });
    expect(tightened.valueMicros).toBe(400 * M);
    expect(tightened.locked).toBe(true);
  });

  it('C06 a locked control expires and becomes editable on the next trading day', async () => {
    const acct = await makeAccount('ACTIVE', '2026-06-15');
    await upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'MAX_TRADES', enabled: true, mode: 'LOCKED', value: { valueInt: 3 } });
    // Roll the account's trading day forward.
    await db.update(accounts).set({ currentTradeDate: '2026-06-16' }).where(eq(accounts.id, acct));
    const profile = await getPersonalRiskProfile(db, acct);
    expect(profile.controls.find((c) => c.controlType === 'MAX_TRADES')!.locked).toBe(false);
    // Now it can be loosened / disabled again.
    const loosened = await upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'MAX_TRADES', enabled: true, mode: 'FLEXIBLE', value: { valueInt: 9 } });
    expect(loosened.valueInt).toBe(9);
    expect(loosened.mode).toBe('FLEXIBLE');
  });
});

describe('concurrency + lifecycle', () => {
  it('C07 a stale expectedVersion is rejected (optimistic concurrency)', async () => {
    const acct = await makeAccount();
    const first = await upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'COOLDOWN', enabled: true, mode: 'FLEXIBLE', value: { valueInt: 30 }, expectedVersion: 0 });
    expect(first.version).toBe(0);
    // A second edit at version 0 succeeds and bumps to 1.
    await upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'COOLDOWN', enabled: true, mode: 'FLEXIBLE', value: { valueInt: 45 }, expectedVersion: 0 });
    // A third edit still claiming version 0 is stale.
    await expect(
      upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'COOLDOWN', enabled: true, mode: 'FLEXIBLE', value: { valueInt: 60 }, expectedVersion: 0 }),
    ).rejects.toMatchObject({ code: 'STALE_VERSION' });
  });

  it('C08 a failed/archived account cannot mutate controls', async () => {
    const failed = await makeAccount('FAILED');
    await expect(
      upsertPersonalControl(db, { accountId: failed, ...owner(), controlType: 'MAX_TRADES', enabled: true, mode: 'FLEXIBLE', value: { valueInt: 3 } }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_EDITABLE' });
  });

  it('C09 live usage reflects the day-state counters', async () => {
    const acct = await makeAccount('ACTIVE', '2026-06-15');
    await upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'MAX_TRADES', enabled: true, mode: 'FLEXIBLE', value: { valueInt: 3 } });
    // No day state yet → 0 used.
    let profile = await getPersonalRiskProfile(db, acct);
    let usage = profile.controls.find((c) => c.controlType === 'MAX_TRADES')!.usage as { used: number; limit: number };
    expect(usage).toMatchObject({ used: 0, limit: 3 });
    expect(await getDayState(db, acct, '2026-06-15')).toBeNull();
  });

  it('C10 an unknown control type is rejected', async () => {
    const acct = await makeAccount();
    await expect(
      upsertPersonalControl(db, { accountId: acct, ...owner(), controlType: 'NONSENSE' as never, enabled: true, mode: 'FLEXIBLE', value: {} }),
    ).rejects.toBeInstanceOf(PersonalControlError);
  });
});
