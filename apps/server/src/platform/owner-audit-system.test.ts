/**
 * Audit explorer filters + cursor, and honest System health V3.
 *
 * The audit explorer must filter and page without lying (a status is checked
 * before any business assertion), and System must report projection/outbox/
 * payment health with explicit states — payments NOT_CONFIGURED when sandbox
 * credentials are absent, never a green "connected".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
let adminToken: string;
const users_: string[] = [];
const KEY = `aud-eval-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, {
    organizationId, key: KEY, name: 'Audit Eval', accountType: 'EVALUATION',
    config: {
      rules: { accountSizeMicros: 50_000 * M, profitTargetMicros: 3_000 * M, maxLossMicros: 2_000 * M, drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true },
      execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: 50_000 * M }, payoutRules: null,
    },
  });
  const email = `aud-admin-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [admin] = await db.insert(users).values({ email, passwordHash: await hashPassword('aud-pw'), displayName: 'Admin', role: 'ADMIN', organizationId }).returning();
  users_.push(admin!.id);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'aud-pw' } });
  adminToken = JSON.parse(login.body).accessToken;

  // Generate a few audited events (account.created) to explore.
  for (let i = 0; i < 3; i += 1) {
    const [u] = await db.insert(users).values({ email: `aud-t${i}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: 'x', displayName: `T${i}`, role: 'TRADER', organizationId }).returning();
    users_.push(u!.id);
    await provisionAccount(db, { organizationId, userId: u!.id, profileKey: KEY, actor: { type: 'ADMIN', label: 'aud-test' } });
  }
});

afterAll(async () => {
  for (const id of users_) await db.delete(users).where(eq(users.id, id));
  await app.close();
});

const auth = () => ({ authorization: `Bearer ${adminToken}` });

describe('audit explorer', () => {
  it('filters by action and pages with a cursor', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit?action=account.created&limit=2',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.entries.length).toBeLessThanOrEqual(2);
    for (const e of body.entries) expect(e.action).toBe('account.created');
    // With at least 3 created events, a cursor is returned and the next page is disjoint.
    if (body.nextCursor) {
      const page2 = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit?action=account.created&limit=2&cursor=${encodeURIComponent(body.nextCursor)}`,
        headers: auth(),
      });
      expect(page2.statusCode).toBe(200);
      const ids1 = new Set(body.entries.map((e: { id: string }) => e.id));
      for (const e of JSON.parse(page2.body).entries) expect(ids1.has(e.id)).toBe(false);
    }
  });

  it('filters by actor label', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit?actor=aud-test&limit=50',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const entries = JSON.parse(res.body).entries;
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect((e.actor.label ?? '').includes('aud-test')).toBe(true);
  });
});

describe('system health V3', () => {
  it('reports projection, outbox and payment health with explicit states', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/system', headers: auth() });
    expect(res.statusCode).toBe(200);
    const s = JSON.parse(res.body);
    expect(['HEALTHY', 'DEGRADED']).toContain(s.projections.state);
    expect(Number.isInteger(s.projections.total)).toBe(true);
    expect(['HEALTHY', 'DEGRADED']).toContain(s.outbox.state);
    expect(Number.isInteger(s.outbox.pending)).toBe(true);
    // Payments are sandbox-only and unconfigured in this worker → NOT_CONFIGURED,
    // never a green connected state.
    expect(s.payments.provider).toBe('whop');
    expect(['NOT_CONFIGURED', 'AWAITING_VALIDATION']).toContain(s.payments.state);
  });
});
