/**
 * The payout HTTP surface — auth, RBAC, ownership, and the full trader→owner
 * flow over real requests. Delegates money-safety proofs to payouts.test.ts;
 * this proves the routes enforce who may do what and wire to the service.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { getDb, type Database } from '../../db/client.js';
import { accounts, dailyAccountStats, users } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { defaultOrganizationId, provisionAccount } from '../../platform/provisioning.js';
import { publishProfileVersion } from '../../platform/profiles.js';

const M = 1_000_000;
const $ = (d: number) => d * M;
let app: FastifyInstance;
let db: Database;
let organizationId: string;
let seq = 0;
// Tokens are minted ONCE (the login route is rate-limited) and reused.
let owner: { id: string; email: string };
let other: { id: string; email: string };
let ownerToken: string;
let otherToken: string;
let supportToken: string;
let adminToken: string;

async function makeUser(role: string, pw = 'payout-route-pw'): Promise<{ id: string; email: string }> {
  seq += 1;
  const email = `route-${role.toLowerCase()}-${seq}-${Date.now()}@test.local`;
  const [u] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(pw), displayName: role, role, organizationId })
    .returning();
  return { id: u!.id, email };
}
async function tokenFor(email: string, pw = 'payout-route-pw'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: pw } });
  const token = res.statusCode === 200 ? JSON.parse(res.body).accessToken : null;
  if (!token) throw new Error(`login failed (${res.statusCode}): ${res.body.slice(0, 200)}`);
  return token;
}

async function fundedAccountFor(userId: string): Promise<string> {
  const { accountId } = await provisionAccount(db, { organizationId, userId, profileKey: 'htf-core-route' });
  await db
    .update(accounts)
    .set({ balanceMicros: $(53_000), startingBalanceMicros: $(50_000), dayStartBalanceMicros: $(53_000), dayStartEquityMicros: $(53_000), highWaterMarkMicros: $(53_000), activatedAt: new Date('2026-02-01') })
    .where(eq(accounts.id, accountId));
  for (let i = 0; i < 5; i += 1) {
    await db.insert(dailyAccountStats).values({
      accountId,
      tradeDate: `2026-03-0${i + 1}`,
      startingBalanceMicros: $(50_000),
      endingBalanceMicros: $(50_200),
      highEquityMicros: $(50_200),
      lowEquityMicros: $(50_000),
      counted: true,
    });
  }
  return accountId;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, {
    organizationId,
    key: 'htf-core-route',
    name: 'Core Route 50K',
    accountType: 'FUNDED_SIM',
    config: {
      rules: { accountSizeMicros: $(50_000), profitTargetMicros: 0, maxLossMicros: $(2000), drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true },
      execution: null,
      instruments: { allowed: null, maxContracts: 50, perInstrument: {} },
      display: { startingBalanceMicros: $(50_000) },
      payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] } },
      fundedDestinationKey: null,
      whopPlanId: null,
    },
  });
  owner = await makeUser('TRADER');
  other = await makeUser('TRADER');
  const support = await makeUser('SUPPORT');
  const admin = await makeUser('ADMIN');
  ownerToken = await tokenFor(owner.email);
  otherToken = await tokenFor(other.email);
  supportToken = await tokenFor(support.email);
  adminToken = await tokenFor(admin.email);
});
afterAll(async () => {
  await app.close();
});

describe('trader payout routes — own account only', () => {
  it('a trader sees their eligibility and can request; another trader cannot', async () => {
    const acct = await fundedAccountFor(owner.id);

    const elig = await app.inject({ method: 'GET', url: `/api/v1/payouts/eligibility/${acct}`, headers: { authorization: `Bearer ${ownerToken}` } });
    expect(elig.statusCode).toBe(200);
    expect(elig.json().state).toBe('ELIGIBLE');
    expect(elig.json().grossWithdrawableMicros).toBe($(3000));

    // Another trader is refused the same account (IDOR guard).
    const foreign = await app.inject({ method: 'GET', url: `/api/v1/payouts/eligibility/${acct}`, headers: { authorization: `Bearer ${otherToken}` } });
    expect(foreign.statusCode).toBe(404);

    const req = await app.inject({
      method: 'POST',
      url: '/api/v1/payouts/requests',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { accountId: acct, amountMicros: $(1000), idempotencyKey: `route-${acct}` },
    });
    expect(req.statusCode).toBe(201);
    expect(req.json().state).toBe('REQUESTED');

    // A foreign trader cannot request against the owner's account.
    const foreignReq = await app.inject({
      method: 'POST',
      url: '/api/v1/payouts/requests',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { accountId: acct, amountMicros: $(1000) },
    });
    expect(foreignReq.statusCode).toBe(404);
  });

  it('rejects an out-of-bounds amount with a reason', async () => {
    const acct = await fundedAccountFor(owner.id);
    const tooBig = await app.inject({ method: 'POST', url: '/api/v1/payouts/requests', headers: { authorization: `Bearer ${ownerToken}` }, payload: { accountId: acct, amountMicros: $(9999) } });
    expect(tooBig.statusCode).toBe(400);
    const body = tooBig.json();
    // The reason code travels in the error detail so the UI shows exactly why.
    expect(body.error?.detail?.reason ?? body.error?.code).toBeTruthy();
  });
});

describe('owner payout routes — RBAC', () => {
  it('a trader cannot read the owner queue; support can; admin can approve', async () => {
    const acct = await fundedAccountFor(owner.id);
    await app.inject({ method: 'POST', url: '/api/v1/payouts/requests', headers: { authorization: `Bearer ${ownerToken}` }, payload: { accountId: acct, amountMicros: $(1000), idempotencyKey: `rbac-${acct}` } });

    const asTrader = await app.inject({ method: 'GET', url: '/api/v1/admin/payouts', headers: { authorization: `Bearer ${ownerToken}` } });
    expect(asTrader.statusCode).toBe(403);

    const queue = await app.inject({ method: 'GET', url: '/api/v1/admin/payouts?state=REQUESTED', headers: { authorization: `Bearer ${supportToken}` } });
    expect(queue.statusCode).toBe(200);
    const row = queue.json().rows.find((r: { accountId: string }) => r.accountId === acct);
    expect(row).toBeTruthy();

    // Support cannot approve (needs ADMIN).
    const supportApprove = await app.inject({ method: 'POST', url: `/api/v1/admin/payouts/${row.id}/approve`, headers: { authorization: `Bearer ${supportToken}` }, payload: { confirm: true, reason: 'ok' } });
    expect(supportApprove.statusCode).toBe(403);

    const approve = await app.inject({ method: 'POST', url: `/api/v1/admin/payouts/${row.id}/approve`, headers: { authorization: `Bearer ${adminToken}` }, payload: { confirm: true, reason: 'looks good' } });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().state).toBe('APPROVED');

    // Exposure reflects the approved-unpaid liability.
    const exposure = await app.inject({ method: 'GET', url: '/api/v1/admin/payouts/exposure', headers: { authorization: `Bearer ${supportToken}` } });
    expect(exposure.statusCode).toBe(200);
    expect(exposure.json().approvedUnpaidMicros).toBeGreaterThanOrEqual($(1000));
  });

  it('approve without a reason is refused', async () => {
    const acct = await fundedAccountFor(owner.id);
    const req = await app.inject({ method: 'POST', url: '/api/v1/payouts/requests', headers: { authorization: `Bearer ${ownerToken}` }, payload: { accountId: acct, amountMicros: $(1000), idempotencyKey: `noreason-${acct}` } });
    const bad = await app.inject({ method: 'POST', url: `/api/v1/admin/payouts/${req.json().id}/approve`, headers: { authorization: `Bearer ${adminToken}` }, payload: { confirm: true } });
    expect(bad.statusCode).toBe(400);
  });
});
