/**
 * Production infrastructure domain services (M4-N/O/P/Q/S) against the test DB.
 * Deterministic; no network. Proves mapping defaults + exposure guard, external
 * order idempotency + report dedup + state machine, reconciliation states,
 * entitlement resolution, and the external execution safety gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, positions, providerAccountMappings, ruleTemplates, users } from '../db/schema.js';
import { defaultOrganizationId } from './provisioning.js';
import { getMapping, setMapping, MappingError } from './provider-mapping.js';
import {
  applyExecutionReport,
  getByAtlasOrderId,
  listWorkingByAccount,
  markSubmitted,
  markUnknown,
  recordExternalOrder,
} from './external-orders.js';
import { getReconciliationState, reconcileAccount } from './reconciliation.js';
import { entitlementStatus, upsertEntitlement } from './entitlements.js';
import { externalExecutionGate } from '../execution/safety-gate.js';
import { ExecutionRegistry } from '../execution/registry.js';
import { ScriptedExecutionProvider } from '../execution/providers/scripted-execution.js';
import { defaultMapping } from './provider-mapping.js';
import type { ExecutionProvider } from '../execution/provider.js';

const M = 1_000_000;
let db: Database;
let sql: ReturnType<typeof createDb>['sql'];
let organizationId: string;
let userId: string;
const accountIds: string[] = [];

async function makeAccount(): Promise<string> {
  const size = 100_000 * M;
  const [tpl] = await db.insert(ruleTemplates).values({
    name: `Infra Tpl ${crypto.randomUUID().slice(0, 6)}`, accountType: 'FUNDED_SIM', accountSizeMicros: size,
    profitTargetMicros: 1_000_000 * M, maxLossMicros: size, drawdownType: 'STATIC', trailingLockAtMicros: null,
    dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL',
    consistencyThreshold: null, maxContracts: 50, microsCountAsFraction: false, minTradingDays: 0, minWinningDays: 0,
    maxTradingDays: null, minDailyPnlToCountMicros: 0, flattenOnBreach: true, payoutRules: {},
  }).returning();
  const [a] = await db.insert(accounts).values({
    organizationId, userId, ruleTemplateId: tpl!.id, name: `Infra Acct ${crypto.randomUUID().slice(0, 6)}`,
    accountType: 'FUNDED_SIM', status: 'ACTIVE', startingBalanceMicros: size, balanceMicros: size,
    highWaterMarkMicros: size, drawdownFloorMicros: 0, dayStartBalanceMicros: size, dayStartEquityMicros: size,
    currentTradeDate: '2026-09-15', simulationEnvironment: null as never, instrumentLimits: null,
  }).returning();
  accountIds.push(a!.id);
  return a!.id;
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  const handle = createDb(url); db = handle.db; sql = handle.sql;
  organizationId = await defaultOrganizationId(db);
  const [u] = await db.insert(users).values({ email: `infra-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: 'x', displayName: 'Infra', organizationId }).returning();
  userId = u!.id;
});

afterAll(async () => {
  if (accountIds.length) {
    await db.delete(providerAccountMappings).where(inArray(providerAccountMappings.accountId, accountIds));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
  await db.delete(users).where(eq(users.id, userId));
  await sql.end({ timeout: 5 });
});

describe('provider mapping (M4-P)', () => {
  it('defaults to SIMULATION and requires admin action to change; guards exposure', async () => {
    const acct = await makeAccount();
    const def = await getMapping(db, acct);
    expect(def.executionMode).toBe('SIMULATION');
    expect(def.executionProvider).toBe('simulation');

    const mapped = await setMapping(db, { accountId: acct, executionMode: 'EXTERNAL_PAPER', executionProvider: 'rithmic', actorUserId: userId, reason: 'test' });
    expect(mapped.executionMode).toBe('EXTERNAL_PAPER');

    // Open a position → a mode change is refused while exposed.
    await db.insert(positions).values({ accountId: acct, symbol: 'NQ', qty: 1, avgEntryTicks: 80000, realizedPnlMicros: 0, feesMicros: 0 } as never);
    await expect(
      setMapping(db, { accountId: acct, executionMode: 'SIMULATION', executionProvider: 'simulation', actorUserId: userId }),
    ).rejects.toBeInstanceOf(MappingError);
    await db.delete(positions).where(eq(positions.accountId, acct));
  });
});

describe('external order store + state machine (M4-N)', () => {
  it('records exactly once, links provider id, dedups reports, advances state', async () => {
    const acct = await makeAccount();
    const atlasOrderId = crypto.randomUUID();
    const input = {
      organizationId, accountId: acct, atlasOrderId, idempotencyKey: `k-${atlasOrderId}`,
      providerAccountId: 'PA1', symbol: 'NQ', contractCode: 'NQZ26', side: 'BUY' as const, orderType: 'MARKET' as const, requestedQty: 2,
    };
    const first = await recordExternalOrder(db, input);
    expect(first.created).toBe(true);
    const replay = await recordExternalOrder(db, input);
    expect(replay.created).toBe(false); // idempotent
    expect(replay.id).toBe(first.id);

    await markSubmitted(db, first.id, 'SX-1', 'ACKNOWLEDGED');

    const applied = await applyExecutionReport(db, { externalOrderId: first.id, providerOrderId: 'SX-1', state: 'PARTIALLY_FILLED', filledQty: 1, lastFillQty: 1, avgFillPrice: 20000, providerStatus: 'PF', eventTs: Date.now(), dedupeKey: 'd1' });
    expect(applied).toBe(true);
    const dup = await applyExecutionReport(db, { externalOrderId: first.id, providerOrderId: 'SX-1', state: 'PARTIALLY_FILLED', filledQty: 1, lastFillQty: 1, avgFillPrice: 20000, providerStatus: 'PF', eventTs: Date.now(), dedupeKey: 'd1' });
    expect(dup).toBe(false); // duplicate suppressed

    await applyExecutionReport(db, { externalOrderId: first.id, providerOrderId: 'SX-1', state: 'FILLED', filledQty: 2, lastFillQty: 1, avgFillPrice: 20001, providerStatus: 'F', eventTs: Date.now(), dedupeKey: 'd2' });
    const view = await getByAtlasOrderId(db, atlasOrderId);
    expect(view?.state).toBe('FILLED');
    expect(view?.filledQty).toBe(2);
    expect(view?.remainingQty).toBe(0);

    // A stale report cannot reduce the fill count.
    await applyExecutionReport(db, { externalOrderId: first.id, providerOrderId: 'SX-1', state: 'PARTIALLY_FILLED', filledQty: 1, lastFillQty: 0, avgFillPrice: 20000, providerStatus: 'stale', eventTs: Date.now(), dedupeKey: 'd3' });
    expect((await getByAtlasOrderId(db, atlasOrderId))?.filledQty).toBe(2);
  });

  it('marks a lost acknowledgement UNKNOWN, never assumed filled or canceled', async () => {
    const acct = await makeAccount();
    const atlasOrderId = crypto.randomUUID();
    const rec = await recordExternalOrder(db, { organizationId, accountId: acct, atlasOrderId, idempotencyKey: `lk-${atlasOrderId}`, providerAccountId: 'PA1', symbol: 'NQ', contractCode: null, side: 'BUY', orderType: 'MARKET', requestedQty: 1 });
    await markUnknown(db, rec.id, 'submit timeout');
    expect((await getByAtlasOrderId(db, atlasOrderId))?.state).toBe('UNKNOWN');
  });
});

describe('reconciliation (M4-O)', () => {
  it('IN_SYNC when venue matches, RECONCILIATION_REQUIRED when it does not, UNKNOWN when unreachable', async () => {
    const acct = await makeAccount();
    const atlasOrderId = crypto.randomUUID();
    const rec = await recordExternalOrder(db, { organizationId, accountId: acct, atlasOrderId, idempotencyKey: `rc-${atlasOrderId}`, providerAccountId: 'PA9', symbol: 'NQ', contractCode: null, side: 'BUY', orderType: 'LIMIT', requestedQty: 1 });
    await markSubmitted(db, rec.id, 'SX-9', 'ACKNOWLEDGED');
    expect((await listWorkingByAccount(db, acct)).length).toBe(1);

    const adapter = new ScriptedExecutionProvider();
    // Unreachable (not connected) → UNKNOWN.
    let r = await reconcileAccount(db, acct, 'PA9', adapter);
    expect(r.state).toBe('UNKNOWN');
    expect((await getReconciliationState(db, acct))?.state).toBe('UNKNOWN');

    await adapter.connect();
    adapter.setSnapshot([], []); // venue shows nothing → discrepancy
    r = await reconcileAccount(db, acct, 'PA9', adapter);
    expect(r.state).toBe('RECONCILIATION_REQUIRED');

    adapter.setSnapshot([{ providerOrderId: 'SX-9', symbol: 'NQ', side: 'BUY', qty: 1, filledQty: 0, state: 'ACKNOWLEDGED' }], []);
    r = await reconcileAccount(db, acct, 'PA9', adapter);
    expect(r.state).toBe('IN_SYNC');
  });
});

describe('entitlements (M4-S)', () => {
  it('resolves UNKNOWN by default, ENTITLED/PENDING/NOT_ENTITLED with rows', async () => {
    expect(await entitlementStatus(db, userId, 'CME', 'REALTIME_TOP')).toBe('UNKNOWN');
    await upsertEntitlement(db, { organizationId, userId, exchange: 'CME', dataLevel: 'REALTIME_TOP', status: 'ENTITLED' });
    expect(await entitlementStatus(db, userId, 'CME', 'REALTIME_TOP')).toBe('ENTITLED');
    await upsertEntitlement(db, { organizationId, userId, exchange: 'CBOT', dataLevel: 'DELAYED', status: 'ENTITLED', effectiveAt: Date.now() + 3_600_000 });
    expect(await entitlementStatus(db, userId, 'CBOT', 'DELAYED')).toBe('PENDING');
  });
});

describe('external execution safety gate (M4-Q)', () => {
  const sim = { id: 'atlas-sim', capabilities: () => ({ isSimulation: true }), status: () => ({ providerId: 'atlas-sim', health: 'HEALTHY', isSimulation: true, detail: 'sim' }) } as unknown as ExecutionProvider;
  const reg = new ExecutionRegistry(sim, new Map());
  const OPEN_TS = Date.parse('2026-06-15T14:00:00Z');
  const CLOSED_TS = Date.parse('2026-06-13T14:00:00Z');
  const fresh = { state: 'FRESH' as const, blocksOrderEntry: false };

  it('always allows SIMULATION', () => {
    const r = externalExecutionGate({ mapping: defaultMapping('a'), registry: reg, root: 'NQ', contractCode: null, marketNow: OPEN_TS, freshness: fresh });
    expect(r.allow).toBe(true);
  });

  it('rejects an EXTERNAL_PAPER account with an unavailable provider', () => {
    const mapping = { ...defaultMapping('a'), executionMode: 'EXTERNAL_PAPER' as const, executionProvider: 'rithmic' as const };
    const r = externalExecutionGate({ mapping, registry: reg, root: 'NQ', contractCode: null, marketNow: OPEN_TS, freshness: fresh });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toBe('EXECUTION_PROVIDER_UNAVAILABLE');
  });

  it('rejects a closed market and a stale feed with specific reasons', () => {
    const mapping = { ...defaultMapping('a'), executionMode: 'EXTERNAL_PAPER' as const, executionProvider: 'scripted' as const };
    const closed = externalExecutionGate({ mapping, registry: reg, root: 'NQ', contractCode: null, marketNow: CLOSED_TS, freshness: fresh });
    expect(closed.allow).toBe(false);
    if (!closed.allow) expect(closed.reason).toBe('MARKET_CLOSED');

    const stale = externalExecutionGate({ mapping, registry: reg, root: 'NQ', contractCode: null, marketNow: OPEN_TS, freshness: { state: 'STALE', blocksOrderEntry: true } });
    expect(stale.allow).toBe(false);
    if (!stale.allow) expect(stale.reason).toBe('MARKET_DATA_STALE');
  });

  it('rejects a cross-root contract code', () => {
    const mapping = { ...defaultMapping('a'), executionMode: 'EXTERNAL_PAPER' as const, executionProvider: 'scripted' as const };
    const r = externalExecutionGate({ mapping, registry: reg, root: 'MNQ', contractCode: 'NQZ26', marketNow: OPEN_TS, freshness: fresh });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toBe('INSTRUMENT_NOT_PERMITTED');
  });
});
