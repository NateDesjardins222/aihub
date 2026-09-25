/**
 * Payout Operations HTTP authorization, IDOR, and webhook contract (Milestone 8).
 *
 * Hiding a button is not authorization: every owner gate is exercised over HTTP
 * with a token that lacks the capability. SUPPORT reads the console but cannot act;
 * ADMIN retries/reconciles/configures but cannot break-glass mark-paid; only
 * SUPER_ADMIN can, and it is audited with external evidence. A trader never reaches
 * the owner surface and never sees or touches another trader's payout, destination
 * or timeline. The webhook accepts no browser auth, is idempotent, and never echoes
 * a raw provider reference or bank secret. An unconfigured production provider fails
 * closed. Every operation is created through the real service so the assertions run
 * against authoritative rows, not fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import {
  accounts, auditLog, dailyAccountStats, payoutDestinations, users,
} from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from '../platform/provisioning.js';
import { publishProfileVersion } from '../platform/profiles.js';
import { SYSTEM_ACTOR } from '../platform/actor.js';
import { ensureCustomerIdentity } from '../platform/customer-identity.js';
import { requestPayout } from '../platform/payouts.js';
import { addDestination } from '../platform/payout-destinations.js';
import { getOpsConfig, updateOpsConfig, closeCircuitBreaker } from '../platform/payout-ops-config.js';
import { resetMockPayoutProvider } from '../platform/payout-provider-registry.js';
import { getOperationByRequest, runFastLane, submitPayable } from '../platform/payout-operations.js';

const M = 1_000_000;
const $ = (d: number) => d * M;
const PASSWORD = 'payout-ops-http-pw';
const PROFILE_KEY = 'htf-pops-http-50k';

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const created: string[] = [];
const tokens: Record<string, string> = {};
let seq = 0;

function fundedConfig(sizeMicros: number) {
  return {
    rules: {
      accountSizeMicros: sizeMicros, profitTargetMicros: 0, maxLossMicros: $(2000), drawdownType: 'STATIC' as const,
      trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const,
      consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0,
      maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true,
    },
    execution: null,
    instruments: { allowed: null, maxContracts: 50, perInstrument: {} },
    display: { startingBalanceMicros: sizeMicros },
    payoutRules: {
      model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150),
      requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0,
      requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000), $(2000), $(2000), $(2000), $(2000)] },
    },
    fundedDestinationKey: null, whopPlanId: null,
  };
}

async function makeUser(role: string): Promise<{ id: string; token: string; email: string }> {
  const email = `pops-http-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [user] = await db.insert(users).values({
    email, passwordHash: await hashPassword(PASSWORD), displayName: role, role, organizationId,
    isAdmin: role === 'ADMIN' || role === 'SUPER_ADMIN',
  }).returning();
  created.push(user!.id);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  return { id: user!.id, token: JSON.parse(res.body).accessToken, email };
}

interface Trader { userId: string; token: string; accountId: string; identityId: string; requestId: string }

/** A funded, eligible trader with a live MOCK destination and one fast-laned payout. */
async function makeTrader(): Promise<Trader> {
  seq += 1;
  const u = await makeUser('TRADER');
  const ident = await ensureCustomerIdentity(db, { organizationId, userId: u.id });
  const { accountId } = await provisionAccount(db, { organizationId, userId: u.id, profileKey: PROFILE_KEY });
  const balance = $(53_000);
  await db.update(accounts).set({
    balanceMicros: balance, startingBalanceMicros: $(50_000), dayStartBalanceMicros: balance, dayStartEquityMicros: balance,
    highWaterMarkMicros: Math.max(balance, $(50_000)), activatedAt: new Date('2026-02-01T00:00:00Z'),
  }).where(eq(accounts.id, accountId));
  for (let i = 0; i < 5; i += 1) {
    await db.insert(dailyAccountStats).values({
      accountId, tradeDate: `2026-03-1${i}`,
      startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true,
    });
  }
  await addDestination(db, { organizationId, customerIdentityId: ident.id, provider: 'MOCK', providerRef: `mock_dest_http_${seq}` });
  const r = await requestPayout(db, { accountId, userId: u.id, requestedGrossMicros: $(1000), idempotencyKey: `req-http-${accountId}`, actor: SYSTEM_ACTOR });
  await runFastLane(db, r.id);
  return { userId: u.id, token: u.token, accountId, identityId: ident.id, requestId: r.id };
}

function call(method: 'GET' | 'POST' | 'PATCH', url: string, token: string | null | undefined, payload?: unknown) {
  return app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never })
    .then((r) => ({ status: r.statusCode, json: r.body ? JSON.parse(r.body) : null, raw: r.body }));
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: PROFILE_KEY, name: 'Pops HTTP 50K', accountType: 'FUNDED_SIM', config: fundedConfig($(50_000)) });
  await updateOpsConfig(db, organizationId, { provider: 'MOCK', actor: SYSTEM_ACTOR });
  for (const role of ['SUPPORT', 'ADMIN', 'SUPER_ADMIN']) tokens[role] = (await makeUser(role)).token;
});

beforeEach(async () => {
  resetMockPayoutProvider();
  await closeCircuitBreaker(db, organizationId, 'test reset', SYSTEM_ACTOR);
});

afterAll(async () => {
  // The shared atlas_test pool is intentionally not torn down: funded traders carry
  // append-only payout_ledger rows, and unique ids keep each run isolated.
  void created;
  await app.close();
});

// ============================================================================
describe('owner console — role-based access control over HTTP', () => {
  it('rejects an unauthenticated overview read (401)', async () => {
    expect((await call('GET', '/api/v1/admin/payout-ops/overview', null)).status).toBe(401);
  });
  it('rejects a trader from the owner overview (403)', async () => {
    const t = await makeTrader();
    expect((await call('GET', '/api/v1/admin/payout-ops/overview', t.token)).status).toBe(403);
  });
  it('lets SUPPORT read the overview, operations, config', async () => {
    expect((await call('GET', '/api/v1/admin/payout-ops/overview', tokens.SUPPORT)).status).toBe(200);
    expect((await call('GET', '/api/v1/admin/payout-ops/operations', tokens.SUPPORT)).status).toBe(200);
    expect((await call('GET', '/api/v1/admin/payout-ops/config', tokens.SUPPORT)).status).toBe(200);
  });
  it('forbids SUPPORT from editing config (read-only)', async () => {
    const r = await call('PATCH', '/api/v1/admin/payout-ops/config', tokens.SUPPORT, { reserveThresholdMicros: 1 });
    expect(r.status).toBe(403);
  });
  it('forbids SUPPORT from opening the circuit breaker', async () => {
    const r = await call('POST', '/api/v1/admin/payout-ops/circuit-breaker', tokens.SUPPORT, { action: 'OPEN', reason: 'nope' });
    expect(r.status).toBe(403);
  });
  it('lets ADMIN edit config and toggle the breaker', async () => {
    const cfg = await getOpsConfig(db, organizationId);
    const r = await call('PATCH', '/api/v1/admin/payout-ops/config', tokens.ADMIN, { reconStaleThresholdSeconds: 600, expectedVersion: cfg.version });
    expect(r.status).toBe(200);
    const open = await call('POST', '/api/v1/admin/payout-ops/circuit-breaker', tokens.ADMIN, { action: 'OPEN', reason: 'owner pause' });
    expect(open.status).toBe(200);
    expect(open.json.open).toBe(true);
    const close = await call('POST', '/api/v1/admin/payout-ops/circuit-breaker', tokens.ADMIN, { action: 'CLOSE', reason: 'owner resume' });
    expect(close.status).toBe(200);
  });
  it('returns 409 on a stale config version (optimistic concurrency)', async () => {
    const cfg = await getOpsConfig(db, organizationId);
    const r = await call('PATCH', '/api/v1/admin/payout-ops/config', tokens.ADMIN, { reconStaleThresholdSeconds: 700, expectedVersion: cfg.version - 1 });
    expect(r.status).toBe(409);
  });
  it('SUPPORT sees a single operation detail (checks/attempts/events/reconciliation) but no raw secret', async () => {
    const t = await makeTrader();
    const r = await call('GET', `/api/v1/admin/payout-ops/operations/${t.requestId}`, tokens.SUPPORT);
    expect(r.status).toBe(200);
    expect(r.json.operation.payoutRequestId).toBe(t.requestId);
    expect(Array.isArray(r.json.checks)).toBe(true);
    expect(r.json).toHaveProperty('timings');
    // A destination's raw provider reference must never surface in the owner detail body.
    expect(r.raw).not.toContain('mock_dest_http_');
  });
  it('404s an operation detail for an unknown id', async () => {
    const r = await call('GET', `/api/v1/admin/payout-ops/operations/${crypto.randomUUID()}`, tokens.SUPPORT);
    expect(r.status).toBe(404);
  });
});

// ============================================================================
describe('owner console — ADMIN can act, only SUPER_ADMIN can break-glass', () => {
  it('lets ADMIN retry a PAYABLE payout', async () => {
    const t = await makeTrader();
    const r = await call('POST', `/api/v1/admin/payout-ops/operations/${t.requestId}/retry`, tokens.ADMIN, {});
    expect(r.status).toBe(200);
    expect(['SUBMITTED', 'PROCESSING', 'PAYABLE', 'PAID']).toContain(r.json.opState);
  });
  it('lets ADMIN trigger a manual reconcile', async () => {
    const t = await makeTrader();
    await submitPayable(db, t.requestId);
    const r = await call('POST', `/api/v1/admin/payout-ops/operations/${t.requestId}/reconcile`, tokens.ADMIN, {});
    expect(r.status).toBe(200);
    expect(r.json).toHaveProperty('mismatchType');
  });
  it('forbids ADMIN from break-glass manual resolution (403)', async () => {
    const t = await makeTrader();
    const r = await call('POST', `/api/v1/admin/payout-ops/operations/${t.requestId}/manual-resolution`, tokens.ADMIN, {
      resolution: 'MARK_PAID', reason: 'external wire confirmed by bank', externalReference: 'WIRE-123', amountMicros: $(900),
    });
    expect(r.status).toBe(403);
  });
  it('forbids a trader from break-glass manual resolution (403)', async () => {
    const t = await makeTrader();
    const r = await call('POST', `/api/v1/admin/payout-ops/operations/${t.requestId}/manual-resolution`, t.token, {
      resolution: 'MARK_PAID', reason: 'please just pay me now', externalReference: 'SELF-1', amountMicros: $(900),
    });
    expect(r.status).toBe(403);
  });
  it('rejects a break-glass resolution missing external evidence (validation)', async () => {
    const t = await makeTrader();
    const r = await call('POST', `/api/v1/admin/payout-ops/operations/${t.requestId}/manual-resolution`, tokens.SUPER_ADMIN, {
      resolution: 'MARK_PAID', reason: 'short', externalReference: '', amountMicros: $(900),
    });
    expect(r.status).toBe(400);
  });
  it('lets SUPER_ADMIN break-glass mark-paid, and writes an audit record', async () => {
    const t = await makeTrader();
    const r = await call('POST', `/api/v1/admin/payout-ops/operations/${t.requestId}/manual-resolution`, tokens.SUPER_ADMIN, {
      resolution: 'MARK_PAID', reason: 'external wire confirmed by treasury on 2026-09-25', externalReference: 'WIRE-9987', amountMicros: $(900),
    });
    expect(r.status).toBe(200);
    expect(r.json.opState).toBe('PAID');
    const op = await getOperationByRequest(db, t.requestId);
    expect(op!.opState).toBe('PAID');
    expect(op!.providerPayoutId).toBe('MANUAL:WIRE-9987');
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'payout_ops.manual_resolution'));
    expect(audits.some((a) => (a.newState as { payoutRequestId?: string } | null)?.payoutRequestId === t.requestId)).toBe(true);
  });
});

// ============================================================================
describe('trader portal — strictly own-scoped (IDOR-safe)', () => {
  it('rejects an unauthenticated portal read (401)', async () => {
    expect((await call('GET', '/api/v1/portal/payout-ops/operations', null)).status).toBe(401);
  });
  it('shows a trader only their own destinations, masked, without a raw reference', async () => {
    const t = await makeTrader();
    const r = await call('GET', '/api/v1/portal/payout-ops/destinations', t.token);
    expect(r.status).toBe(200);
    expect(r.json.destinations.length).toBeGreaterThanOrEqual(1);
    for (const d of r.json.destinations) {
      expect(d).toHaveProperty('maskedDisplay');
      expect(d).not.toHaveProperty('providerRef');
    }
    expect(r.raw).not.toContain('mock_dest_http_');
  });
  it('shows a trader only their own operations, never another trader\'s', async () => {
    const a = await makeTrader();
    const b = await makeTrader();
    const ra = await call('GET', '/api/v1/portal/payout-ops/operations', a.token);
    expect(ra.status).toBe(200);
    const ids = ra.json.operations.map((o: { payoutRequestId: string }) => o.payoutRequestId);
    expect(ids).toContain(a.requestId);
    expect(ids).not.toContain(b.requestId);
  });
  it('lets a trader read their own timeline', async () => {
    const t = await makeTrader();
    const r = await call('GET', `/api/v1/portal/payout-ops/operations/${t.requestId}/timeline`, t.token);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.timeline)).toBe(true);
    expect(r.json).toHaveProperty('status');
  });
  it('404s when trader A reads trader B\'s timeline (no cross-tenant read)', async () => {
    const a = await makeTrader();
    const b = await makeTrader();
    const r = await call('GET', `/api/v1/portal/payout-ops/operations/${b.requestId}/timeline`, a.token);
    expect(r.status).toBe(404);
  });
  it('404s when trader A disables trader B\'s destination (no cross-tenant write)', async () => {
    const a = await makeTrader();
    const b = await makeTrader();
    const [destB] = await db.select().from(payoutDestinations).where(eq(payoutDestinations.customerIdentityId, b.identityId));
    const r = await call('POST', `/api/v1/portal/payout-ops/destinations/${destB!.id}/disable`, a.token, {});
    expect(r.status).toBe(404);
    // B's destination stays active — A could not touch it.
    const [after] = await db.select().from(payoutDestinations).where(eq(payoutDestinations.id, destB!.id));
    expect(after!.status).not.toBe('DISABLED');
  });
  it('a trader cannot fabricate a PAID via any portal route (no such endpoint)', async () => {
    const t = await makeTrader();
    // The break-glass path is the only mark-paid, and it is owner-guarded.
    const r = await call('POST', `/api/v1/admin/payout-ops/operations/${t.requestId}/manual-resolution`, t.token, {
      resolution: 'MARK_PAID', reason: 'trying to self-pay right now', externalReference: 'X', amountMicros: $(900),
    });
    expect(r.status).toBe(403);
    const op = await getOperationByRequest(db, t.requestId);
    expect(op!.opState).not.toBe('PAID');
  });
});

// ============================================================================
describe('webhook — provider evidence only, no browser auth, idempotent, no leak', () => {
  it('accepts a POST with no authorization header', async () => {
    const t = await makeTrader();
    await submitPayable(db, t.requestId); // gives the op a provider payout id
    const op = await getOperationByRequest(db, t.requestId);
    const body = { id: `wh_${t.requestId}`, type: 'processing', payoutId: op!.providerPayoutId, ts: Date.now() };
    const r = await call('POST', '/api/v1/webhooks/payout/MOCK', null, body);
    expect(r.status).toBe(200);
    expect(r.json.received).toBe(true);
  });
  it('is idempotent — a duplicate event id is deduped', async () => {
    const t = await makeTrader();
    await submitPayable(db, t.requestId);
    const op = await getOperationByRequest(db, t.requestId);
    const body = { id: `wh_dup_${t.requestId}`, type: 'processing', payoutId: op!.providerPayoutId, ts: Date.now() };
    const first = await call('POST', '/api/v1/webhooks/payout/MOCK', null, body);
    const second = await call('POST', '/api/v1/webhooks/payout/MOCK', null, body);
    expect(first.json.deduped).toBe(false);
    expect(second.json.deduped).toBe(true);
  });
  it('a PAID webhook drives authoritative settlement exactly once', async () => {
    const t = await makeTrader();
    await submitPayable(db, t.requestId);
    const op = await getOperationByRequest(db, t.requestId);
    const body = { id: `wh_paid_${t.requestId}`, type: 'paid', payoutId: op!.providerPayoutId, ts: Date.now(), amountMicros: $(900) };
    const r = await call('POST', '/api/v1/webhooks/payout/MOCK', null, body);
    expect(r.status).toBe(200);
    const after = await getOperationByRequest(db, t.requestId);
    expect(['PAID', 'RECONCILED']).toContain(after!.opState);
    // A duplicate PAID never double-settles.
    const again = await call('POST', '/api/v1/webhooks/payout/MOCK', null, body);
    expect(again.json.deduped).toBe(true);
  });
  it('an unknown/unparseable provider body is a safe no-op (202)', async () => {
    const r = await call('POST', '/api/v1/webhooks/payout/MOCK', null, { garbage: true });
    expect(r.status).toBe(202);
    expect(r.json.processed).toBe(false);
  });
  it('an unknown provider fails closed (no normalized event, 202 no-op)', async () => {
    const r = await call('POST', '/api/v1/webhooks/payout/NOPE', null, { id: 'x', type: 'paid', payoutId: 'y' });
    expect(r.status).toBe(202);
  });
  it('never echoes a raw provider reference in the webhook response', async () => {
    const t = await makeTrader();
    await submitPayable(db, t.requestId);
    const op = await getOperationByRequest(db, t.requestId);
    const body = { id: `wh_leak_${t.requestId}`, type: 'accepted', payoutId: op!.providerPayoutId, secret: 'sk_live_should_never_persist', ts: Date.now() };
    const r = await call('POST', '/api/v1/webhooks/payout/MOCK', null, body);
    expect(r.raw).not.toContain('sk_live_should_never_persist');
  });
});
