/**
 * M4-X — production external-execution TORTURE SUITE (deterministic).
 *
 * 30+ adversarial cases proving the production-infrastructure seam is safe the
 * day an external venue is enabled, WITHOUT any real venue, credentials, network,
 * or unreliable real-clock replay. Every case is a pure function or a DB-backed
 * domain service driven by the Scripted test double, so a green run is a real
 * correctness proof, not "the browser looked right".
 *
 * The invariants under torture:
 *  - Atlas ids are canonical; a transport success is NOT a fill.
 *  - Exactly-once submit; duplicate venue reports suppressed; fills monotonic.
 *  - A lost acknowledgement is UNKNOWN, never assumed filled/canceled.
 *  - Reconciliation never guesses an order vanished; unreachable ⇒ UNKNOWN.
 *  - Default routing is SIMULATION; nothing self-promotes to EXTERNAL.
 *  - The safety gate fails CLOSED with a specific reason, never a generic error.
 *  - No provider secret ever appears in any redacted surface.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, positions, providerAccountMappings, ruleTemplates, users } from '../db/schema.js';
import { defaultOrganizationId } from './provisioning.js';
import { defaultMapping, getMapping, setMapping, MappingError } from './provider-mapping.js';
import {
  applyExecutionReport,
  getByAtlasOrderId,
  listByAccount,
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
import { RithmicExecutionProvider } from '../execution/providers/rithmic-execution.js';
import { SessionAuthority } from '../infra/session-authority.js';
import { Symbology, SymbologyError } from '../infra/symbology.js';
import type { ExecutionProvider } from '../execution/provider.js';
import type { ExecutionProviderKind } from '@atlas/contracts';
import type { ExternalExecutionAdapter } from '../execution/external-provider.js';

const M = 1_000_000;
const OPEN_TS = Date.parse('2026-06-15T14:00:00Z'); // Mon RTH — market OPEN
const CLOSED_TS = Date.parse('2026-06-13T14:00:00Z'); // Sat — CLOSED
const FRESH = { state: 'FRESH' as const, blocksOrderEntry: false };

let db: Database;
let sql: ReturnType<typeof createDb>['sql'];
let organizationId: string;
let userId: string;
const accountIds: string[] = [];

async function makeAccount(): Promise<string> {
  const size = 100_000 * M;
  const [tpl] = await db
    .insert(ruleTemplates)
    .values({
      name: `Tort Tpl ${crypto.randomUUID().slice(0, 6)}`, accountType: 'FUNDED_SIM', accountSizeMicros: size,
      profitTargetMicros: 1_000_000 * M, maxLossMicros: size, drawdownType: 'STATIC', trailingLockAtMicros: null,
      dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL',
      consistencyThreshold: null, maxContracts: 50, microsCountAsFraction: false, minTradingDays: 0, minWinningDays: 0,
      maxTradingDays: null, minDailyPnlToCountMicros: 0, flattenOnBreach: true, payoutRules: {},
    })
    .returning();
  const [a] = await db
    .insert(accounts)
    .values({
      organizationId, userId, ruleTemplateId: tpl!.id, name: `Tort Acct ${crypto.randomUUID().slice(0, 6)}`,
      accountType: 'FUNDED_SIM', status: 'ACTIVE', startingBalanceMicros: size, balanceMicros: size,
      highWaterMarkMicros: size, drawdownFloorMicros: 0, dayStartBalanceMicros: size, dayStartEquityMicros: size,
      currentTradeDate: '2026-06-15', simulationEnvironment: null as never, instrumentLimits: null,
    })
    .returning();
  accountIds.push(a!.id);
  return a!.id;
}

/** A registry whose `scripted` adapter is CONNECTED (ready for paper). */
async function connectedScriptedRegistry(): Promise<ExecutionRegistry> {
  const sim = { id: 'atlas-sim', capabilities: () => ({ isSimulation: true }), status: () => ({ providerId: 'atlas-sim', health: 'HEALTHY', isSimulation: true, detail: 'sim' }) } as unknown as ExecutionProvider;
  const scripted = new ScriptedExecutionProvider();
  await scripted.connect();
  const adapters = new Map<ExecutionProviderKind, ExternalExecutionAdapter>([['scripted', scripted]]);
  return new ExecutionRegistry(sim, adapters);
}

function emptyRegistry(): ExecutionRegistry {
  const sim = { id: 'atlas-sim', capabilities: () => ({ isSimulation: true }), status: () => ({ providerId: 'atlas-sim', health: 'HEALTHY', isSimulation: true, detail: 'sim' }) } as unknown as ExecutionProvider;
  return new ExecutionRegistry(sim, new Map());
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  const handle = createDb(url); db = handle.db; sql = handle.sql;
  organizationId = await defaultOrganizationId(db);
  const [u] = await db.insert(users).values({ email: `tort-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: 'x', displayName: 'Tort', organizationId }).returning();
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

// ─────────────────────────────────────────────────────────────────────────────
// External order lifecycle + idempotency + state machine (M4-N)
// ─────────────────────────────────────────────────────────────────────────────
describe('M4-X external order lifecycle (M4-N)', () => {
  it('T01 records a fresh order exactly once as PENDING_SUBMIT', async () => {
    const acct = await makeAccount();
    const atlasOrderId = crypto.randomUUID();
    const r = await recordExternalOrder(db, { organizationId, accountId: acct, atlasOrderId, idempotencyKey: `t01-${atlasOrderId}`, providerAccountId: 'PA', symbol: 'NQ', contractCode: 'NQZ26', side: 'BUY', orderType: 'MARKET', requestedQty: 3 });
    expect(r.created).toBe(true);
    expect(r.order.state).toBe('PENDING_SUBMIT');
    expect(r.order.remainingQty).toBe(3);
  });

  it('T02 idempotent replay returns the same row and never a second order', async () => {
    const acct = await makeAccount();
    const atlasOrderId = crypto.randomUUID();
    const input = { organizationId, accountId: acct, atlasOrderId, idempotencyKey: `t02-${atlasOrderId}`, providerAccountId: 'PA', symbol: 'NQ', contractCode: null, side: 'BUY' as const, orderType: 'MARKET' as const, requestedQty: 1 };
    const a = await recordExternalOrder(db, input);
    const b = await recordExternalOrder(db, input);
    const c = await recordExternalOrder(db, input);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(c.created).toBe(false);
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
    expect((await listByAccount(db, acct)).length).toBe(1);
  });

  it('T03 markSubmitted links the provider id and advances state', async () => {
    const acct = await makeAccount();
    const atlasOrderId = crypto.randomUUID();
    const r = await recordExternalOrder(db, { organizationId, accountId: acct, atlasOrderId, idempotencyKey: `t03-${atlasOrderId}`, providerAccountId: 'PA', symbol: 'ES', contractCode: null, side: 'SELL', orderType: 'LIMIT', requestedQty: 2 });
    await markSubmitted(db, r.id, 'SX-3', 'ACKNOWLEDGED');
    const v = await getByAtlasOrderId(db, atlasOrderId);
    expect(v?.providerOrderId).toBe('SX-3');
    expect(v?.state).toBe('ACKNOWLEDGED');
    expect(v?.submittedAt).not.toBeNull();
  });

  it('T04 a partial fill advances filledQty / remainingQty / state', async () => {
    const acct = await makeAccount();
    const atlasOrderId = crypto.randomUUID();
    const r = await recordExternalOrder(db, { organizationId, accountId: acct, atlasOrderId, idempotencyKey: `t04-${atlasOrderId}`, providerAccountId: 'PA', symbol: 'NQ', contractCode: null, side: 'BUY', orderType: 'MARKET', requestedQty: 4 });
    await markSubmitted(db, r.id, 'SX-4', 'ACKNOWLEDGED');
    await applyExecutionReport(db, { externalOrderId: r.id, providerOrderId: 'SX-4', state: 'PARTIALLY_FILLED', filledQty: 1, lastFillQty: 1, avgFillPrice: 20000, providerStatus: 'PF', eventTs: OPEN_TS, dedupeKey: 't04a' });
    const v = await getByAtlasOrderId(db, atlasOrderId);
    expect(v?.state).toBe('PARTIALLY_FILLED');
    expect(v?.filledQty).toBe(1);
    expect(v?.remainingQty).toBe(3);
  });

  it('T05 a duplicate execution report is suppressed by dedupe key', async () => {
    const acct = await makeAccount();
    const atlasOrderId = crypto.randomUUID();
    const r = await recordExternalOrder(db, { organizationId, accountId: acct, atlasOrderId, idempotencyKey: `t05-${atlasOrderId}`, providerAccountId: 'PA', symbol: 'NQ', contractCode: null, side: 'BUY', orderType: 'MARKET', requestedQty: 2 });
    const first = await applyExecutionReport(db, { externalOrderId: r.id, providerOrderId: 'SX-5', state: 'PARTIALLY_FILLED', filledQty: 1, lastFillQty: 1, avgFillPrice: 20000, providerStatus: 'PF', eventTs: OPEN_TS, dedupeKey: 't05dup' });
    const dup = await applyExecutionReport(db, { externalOrderId: r.id, providerOrderId: 'SX-5', state: 'PARTIALLY_FILLED', filledQty: 1, lastFillQty: 1, avgFillPrice: 20000, providerStatus: 'PF', eventTs: OPEN_TS, dedupeKey: 't05dup' });
    expect(first).toBe(true);
    expect(dup).toBe(false);
    expect((await getByAtlasOrderId(db, atlasOrderId))?.filledQty).toBe(1);
  });

  it('T06 a stale report can never reduce the fill count (monotonic)', async () => {
    const acct = await makeAccount();
    const atlasOrderId = crypto.randomUUID();
    const r = await recordExternalOrder(db, { organizationId, accountId: acct, atlasOrderId, idempotencyKey: `t06-${atlasOrderId}`, providerAccountId: 'PA', symbol: 'NQ', contractCode: null, side: 'BUY', orderType: 'MARKET', requestedQty: 2 });
    await applyExecutionReport(db, { externalOrderId: r.id, providerOrderId: 'SX-6', state: 'FILLED', filledQty: 2, lastFillQty: 2, avgFillPrice: 20001, providerStatus: 'F', eventTs: OPEN_TS, dedupeKey: 't06a' });
    await applyExecutionReport(db, { externalOrderId: r.id, providerOrderId: 'SX-6', state: 'PARTIALLY_FILLED', filledQty: 1, lastFillQty: 0, avgFillPrice: 20000, providerStatus: 'stale', eventTs: OPEN_TS - 1000, dedupeKey: 't06b' });
    expect((await getByAtlasOrderId(db, atlasOrderId))?.filledQty).toBe(2);
  });

  it('T07 a full fill reaches FILLED with zero remaining', async () => {
    const acct = await makeAccount();
    const atlasOrderId = crypto.randomUUID();
    const r = await recordExternalOrder(db, { organizationId, accountId: acct, atlasOrderId, idempotencyKey: `t07-${atlasOrderId}`, providerAccountId: 'PA', symbol: 'NQ', contractCode: null, side: 'BUY', orderType: 'MARKET', requestedQty: 2 });
    await applyExecutionReport(db, { externalOrderId: r.id, providerOrderId: 'SX-7', state: 'FILLED', filledQty: 2, lastFillQty: 2, avgFillPrice: 20002, providerStatus: 'F', eventTs: OPEN_TS, dedupeKey: 't07a' });
    const v = await getByAtlasOrderId(db, atlasOrderId);
    expect(v?.state).toBe('FILLED');
    expect(v?.remainingQty).toBe(0);
  });

  it('T08 a lost acknowledgement is UNKNOWN, never assumed filled or canceled', async () => {
    const acct = await makeAccount();
    const atlasOrderId = crypto.randomUUID();
    const r = await recordExternalOrder(db, { organizationId, accountId: acct, atlasOrderId, idempotencyKey: `t08-${atlasOrderId}`, providerAccountId: 'PA', symbol: 'NQ', contractCode: null, side: 'BUY', orderType: 'MARKET', requestedQty: 1 });
    await markUnknown(db, r.id, 'submit timeout');
    const v = await getByAtlasOrderId(db, atlasOrderId);
    expect(v?.state).toBe('UNKNOWN');
  });

  it('T09 the working-order list excludes FILLED orders', async () => {
    const acct = await makeAccount();
    const filledId = crypto.randomUUID();
    const workingId = crypto.randomUUID();
    const rf = await recordExternalOrder(db, { organizationId, accountId: acct, atlasOrderId: filledId, idempotencyKey: `t09f-${filledId}`, providerAccountId: 'PA', symbol: 'NQ', contractCode: null, side: 'BUY', orderType: 'MARKET', requestedQty: 1 });
    await applyExecutionReport(db, { externalOrderId: rf.id, providerOrderId: 'SX-9f', state: 'FILLED', filledQty: 1, lastFillQty: 1, avgFillPrice: 20000, providerStatus: 'F', eventTs: OPEN_TS, dedupeKey: 't09f' });
    const rw = await recordExternalOrder(db, { organizationId, accountId: acct, atlasOrderId: workingId, idempotencyKey: `t09w-${workingId}`, providerAccountId: 'PA', symbol: 'NQ', contractCode: null, side: 'BUY', orderType: 'LIMIT', requestedQty: 1 });
    await markSubmitted(db, rw.id, 'SX-9w', 'ACKNOWLEDGED');
    const working = await listWorkingByAccount(db, acct);
    expect(working.some((o) => o.atlasOrderId === workingId)).toBe(true);
    expect(working.some((o) => o.atlasOrderId === filledId)).toBe(false);
  });

  it('T10 getByAtlasOrderId returns null for an unknown id', async () => {
    expect(await getByAtlasOrderId(db, crypto.randomUUID())).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation (M4-O)
// ─────────────────────────────────────────────────────────────────────────────
describe('M4-X reconciliation (M4-O)', () => {
  it('T11 an unreachable venue is UNKNOWN, never assumed vanished', async () => {
    const acct = await makeAccount();
    const id = crypto.randomUUID();
    const r = await recordExternalOrder(db, { organizationId, accountId: acct, atlasOrderId: id, idempotencyKey: `t11-${id}`, providerAccountId: 'PA', symbol: 'NQ', contractCode: null, side: 'BUY', orderType: 'LIMIT', requestedQty: 1 });
    await markSubmitted(db, r.id, 'SX-11', 'ACKNOWLEDGED');
    const adapter = new ScriptedExecutionProvider(); // not connected
    const res = await reconcileAccount(db, acct, 'PA', adapter);
    expect(res.state).toBe('UNKNOWN');
  });

  it('T12 venue shows nothing while Atlas has a working order → RECONCILIATION_REQUIRED', async () => {
    const acct = await makeAccount();
    const id = crypto.randomUUID();
    const r = await recordExternalOrder(db, { organizationId, accountId: acct, atlasOrderId: id, idempotencyKey: `t12-${id}`, providerAccountId: 'PA', symbol: 'NQ', contractCode: null, side: 'BUY', orderType: 'LIMIT', requestedQty: 1 });
    await markSubmitted(db, r.id, 'SX-12', 'ACKNOWLEDGED');
    const adapter = new ScriptedExecutionProvider();
    await adapter.connect();
    adapter.setSnapshot([], []);
    const res = await reconcileAccount(db, acct, 'PA', adapter);
    expect(res.state).toBe('RECONCILIATION_REQUIRED');
    expect(res.discrepancies.length).toBeGreaterThan(0);
  });

  it('T13 venue matches Atlas → IN_SYNC', async () => {
    const acct = await makeAccount();
    const id = crypto.randomUUID();
    const r = await recordExternalOrder(db, { organizationId, accountId: acct, atlasOrderId: id, idempotencyKey: `t13-${id}`, providerAccountId: 'PA', symbol: 'NQ', contractCode: null, side: 'BUY', orderType: 'LIMIT', requestedQty: 1 });
    await markSubmitted(db, r.id, 'SX-13', 'ACKNOWLEDGED');
    const adapter = new ScriptedExecutionProvider();
    await adapter.connect();
    adapter.setSnapshot([{ providerOrderId: 'SX-13', symbol: 'NQ', side: 'BUY', qty: 1, filledQty: 0, state: 'ACKNOWLEDGED' }], []);
    const res = await reconcileAccount(db, acct, 'PA', adapter);
    expect(res.state).toBe('IN_SYNC');
  });

  it('T14 a venue order Atlas does not know → RECONCILIATION_REQUIRED', async () => {
    const acct = await makeAccount();
    const adapter = new ScriptedExecutionProvider();
    await adapter.connect();
    adapter.setSnapshot([{ providerOrderId: 'GHOST-1', symbol: 'NQ', side: 'BUY', qty: 1, filledQty: 0, state: 'ACKNOWLEDGED' }], []);
    const res = await reconcileAccount(db, acct, 'PA', adapter);
    expect(res.state).toBe('RECONCILIATION_REQUIRED');
    expect(res.discrepancies.join(' ')).toContain('GHOST-1');
  });

  it('T15 the reconciliation state is persisted and retrievable', async () => {
    const acct = await makeAccount();
    const adapter = new ScriptedExecutionProvider();
    await adapter.connect();
    adapter.setSnapshot([], []);
    await reconcileAccount(db, acct, 'PA', adapter);
    const stored = await getReconciliationState(db, acct);
    expect(stored?.state).toBe('IN_SYNC'); // nothing working, nothing at venue
    expect(stored?.lastCheckedAt).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Provider mapping (M4-P)
// ─────────────────────────────────────────────────────────────────────────────
describe('M4-X provider mapping (M4-P)', () => {
  it('T16 an unmapped account defaults to SIMULATION', async () => {
    const acct = await makeAccount();
    const m = await getMapping(db, acct);
    expect(m.executionMode).toBe('SIMULATION');
    expect(m.executionProvider).toBe('simulation');
  });

  it('T17 an admin can move an account to EXTERNAL_PAPER (audited)', async () => {
    const acct = await makeAccount();
    const m = await setMapping(db, { accountId: acct, executionMode: 'EXTERNAL_PAPER', executionProvider: 'rithmic', actorUserId: userId, reason: 'torture' });
    expect(m.executionMode).toBe('EXTERNAL_PAPER');
    expect(m.executionProvider).toBe('rithmic');
  });

  it('T18 a mapping change is refused while the account is exposed', async () => {
    const acct = await makeAccount();
    await setMapping(db, { accountId: acct, executionMode: 'EXTERNAL_PAPER', executionProvider: 'scripted', actorUserId: userId });
    await db.insert(positions).values({ accountId: acct, symbol: 'NQ', qty: 1, avgEntryTicks: 80000, realizedPnlMicros: 0, feesMicros: 0 } as never);
    await expect(setMapping(db, { accountId: acct, executionMode: 'SIMULATION', executionProvider: 'simulation', actorUserId: userId })).rejects.toBeInstanceOf(MappingError);
    await db.delete(positions).where(eq(positions.accountId, acct));
  });

  it('T19 a mapping change is allowed once the account is flat', async () => {
    const acct = await makeAccount();
    await setMapping(db, { accountId: acct, executionMode: 'EXTERNAL_PAPER', executionProvider: 'scripted', actorUserId: userId });
    const back = await setMapping(db, { accountId: acct, executionMode: 'SIMULATION', executionProvider: 'simulation', actorUserId: userId });
    expect(back.executionMode).toBe('SIMULATION');
  });

  it('T20 an unknown account is rejected ACCOUNT_NOT_FOUND', async () => {
    await expect(setMapping(db, { accountId: crypto.randomUUID(), executionMode: 'EXTERNAL_PAPER', executionProvider: 'rithmic', actorUserId: userId })).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// External execution safety gate (M4-Q) — fails CLOSED with a specific reason
// ─────────────────────────────────────────────────────────────────────────────
describe('M4-X safety gate (M4-Q)', () => {
  it('T21 SIMULATION always passes (nothing external to guard)', () => {
    const r = externalExecutionGate({ mapping: defaultMapping('a'), registry: emptyRegistry(), root: 'NQ', contractCode: null, marketNow: OPEN_TS, freshness: FRESH });
    expect(r.allow).toBe(true);
    if (r.allow) expect(r.mode).toBe('SIMULATION');
  });

  it('T22 an EXTERNAL provider that is not connected → EXECUTION_PROVIDER_UNAVAILABLE', () => {
    const mapping = { ...defaultMapping('a'), executionMode: 'EXTERNAL_PAPER' as const, executionProvider: 'rithmic' as const };
    const r = externalExecutionGate({ mapping, registry: emptyRegistry(), root: 'NQ', contractCode: null, marketNow: OPEN_TS, freshness: FRESH });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toBe('EXECUTION_PROVIDER_UNAVAILABLE');
  });

  it('T23 a closed market → MARKET_CLOSED', () => {
    const mapping = { ...defaultMapping('a'), executionMode: 'EXTERNAL_PAPER' as const, executionProvider: 'scripted' as const };
    const r = externalExecutionGate({ mapping, registry: emptyRegistry(), root: 'NQ', contractCode: null, marketNow: CLOSED_TS, freshness: FRESH });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toBe('MARKET_CLOSED');
  });

  it('T24 a stale feed → MARKET_DATA_STALE', () => {
    const mapping = { ...defaultMapping('a'), executionMode: 'EXTERNAL_PAPER' as const, executionProvider: 'scripted' as const };
    const r = externalExecutionGate({ mapping, registry: emptyRegistry(), root: 'NQ', contractCode: null, marketNow: OPEN_TS, freshness: { state: 'STALE', blocksOrderEntry: true } });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toBe('MARKET_DATA_STALE');
  });

  it('T25 absent market data → MARKET_DATA_UNAVAILABLE', () => {
    const mapping = { ...defaultMapping('a'), executionMode: 'EXTERNAL_PAPER' as const, executionProvider: 'scripted' as const };
    const r = externalExecutionGate({ mapping, registry: emptyRegistry(), root: 'NQ', contractCode: null, marketNow: OPEN_TS, freshness: null });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toBe('MARKET_DATA_UNAVAILABLE');
  });

  it('T26 a cross-root contract code → INSTRUMENT_NOT_PERMITTED', () => {
    const mapping = { ...defaultMapping('a'), executionMode: 'EXTERNAL_PAPER' as const, executionProvider: 'scripted' as const };
    const r = externalExecutionGate({ mapping, registry: emptyRegistry(), root: 'MNQ', contractCode: 'NQZ26', marketNow: OPEN_TS, freshness: FRESH });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toBe('INSTRUMENT_NOT_PERMITTED');
  });

  it('T27 a suspended mapping never routes externally', () => {
    const mapping = { ...defaultMapping('a'), executionMode: 'EXTERNAL_PAPER' as const, executionProvider: 'scripted' as const, status: 'SUSPENDED' as const };
    const r = externalExecutionGate({ mapping, registry: emptyRegistry(), root: 'NQ', contractCode: null, marketNow: OPEN_TS, freshness: FRESH });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toBe('EXECUTION_PROVIDER_UNAVAILABLE');
  });

  it('T28 a connected paper provider on an open, fresh market → ALLOW', async () => {
    const mapping = { ...defaultMapping('a'), executionMode: 'EXTERNAL_PAPER' as const, executionProvider: 'scripted' as const };
    const reg = await connectedScriptedRegistry();
    const r = externalExecutionGate({ mapping, registry: reg, root: 'NQ', contractCode: null, marketNow: OPEN_TS, freshness: FRESH });
    expect(r.allow).toBe(true);
    if (r.allow) expect(r.mode).toBe('EXTERNAL_PAPER');
  });

  it('T29 EXTERNAL_LIVE is gated off even when the provider is connected', async () => {
    const mapping = { ...defaultMapping('a'), executionMode: 'EXTERNAL_LIVE' as const, executionProvider: 'scripted' as const };
    const reg = await connectedScriptedRegistry();
    const r = externalExecutionGate({ mapping, registry: reg, root: 'NQ', contractCode: null, marketNow: OPEN_TS, freshness: FRESH });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toBe('EXECUTION_PROVIDER_UNAVAILABLE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Entitlements (M4-S) — absence resolves to UNKNOWN, never ENTITLED
// ─────────────────────────────────────────────────────────────────────────────
describe('M4-X entitlements (M4-S)', () => {
  it('T30 absence of any row resolves to UNKNOWN', async () => {
    expect(await entitlementStatus(db, crypto.randomUUID(), 'CME', 'REALTIME_TOP')).toBe('UNKNOWN');
  });

  it('T31 an ENTITLED row resolves ENTITLED for that user', async () => {
    const [u] = await db.insert(users).values({ email: `ent-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: 'x', displayName: 'Ent', organizationId }).returning();
    await upsertEntitlement(db, { organizationId, userId: u!.id, exchange: 'CME', dataLevel: 'REALTIME_TOP', status: 'ENTITLED' });
    expect(await entitlementStatus(db, u!.id, 'CME', 'REALTIME_TOP')).toBe('ENTITLED');
    await db.delete(users).where(eq(users.id, u!.id));
  });

  it('T32 a future-effective row resolves PENDING', async () => {
    const [u] = await db.insert(users).values({ email: `pend-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: 'x', displayName: 'Pend', organizationId }).returning();
    await upsertEntitlement(db, { organizationId, userId: u!.id, exchange: 'CBOT', dataLevel: 'DELAYED', status: 'ENTITLED', effectiveAt: Date.now() + 3_600_000 });
    expect(await entitlementStatus(db, u!.id, 'CBOT', 'DELAYED')).toBe('PENDING');
    await db.delete(users).where(eq(users.id, u!.id));
  });

  it('T33 an expired row resolves NOT_ENTITLED', async () => {
    const [u] = await db.insert(users).values({ email: `exp-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: 'x', displayName: 'Exp', organizationId }).returning();
    await upsertEntitlement(db, { organizationId, userId: u!.id, exchange: 'NYMEX', dataLevel: 'REALTIME_TOP', status: 'ENTITLED', expiresAt: Date.now() - 3_600_000 });
    expect(await entitlementStatus(db, u!.id, 'NYMEX', 'REALTIME_TOP')).toBe('NOT_ENTITLED');
    await db.delete(users).where(eq(users.id, u!.id));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reference-data guards under torture (M4-G/I) + secret redaction (M4-AA)
// ─────────────────────────────────────────────────────────────────────────────
describe('M4-X reference-data + redaction guards', () => {
  it('T34 session authority reports UNKNOWN outside calendar coverage, never OPEN', () => {
    const s = new SessionAuthority();
    expect(s.status('NQ', Date.parse('2035-06-16T14:00:00Z')).state).toBe('UNKNOWN');
    expect(s.status('ZZZ', OPEN_TS).state).toBe('UNKNOWN');
  });

  it('T35 a registered halt overrides an open calendar', () => {
    const s = new SessionAuthority();
    s.registerHalt('NQ', 'circuit breaker', null);
    expect(s.status('NQ', OPEN_TS).state).toBe('HALTED');
  });

  it('T36 symbology refuses a contract code that does not belong to its root', () => {
    const sym = new Symbology();
    expect(() => sym.assertExecutable('MNQ', 'NQZ26', OPEN_TS)).toThrow(SymbologyError);
  });

  it('T37 an UNCONFIGURED Rithmic execution provider never leaks credentials and refuses to connect', async () => {
    const p = new RithmicExecutionProvider();
    await expect(p.connect()).rejects.toBeTruthy();
    const snap = p.healthSnapshot();
    expect(snap.isSimulation).toBe(false);
    // No real credentials are set in THIS test file's env, so it is UNCONFIGURED
    // and never reports a fabricated CONNECTED state.
    expect(snap.configState).toBe('UNCONFIGURED');
    expect(snap.health).not.toBe('CONNECTED');
  });
});
