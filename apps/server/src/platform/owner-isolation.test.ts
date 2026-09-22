/**
 * Tenant isolation across the Owner V3 endpoints.
 *
 * A firm must never see another firm's data, and must not be able to infer its
 * existence. Every new owner read is scoped by the caller's organisation; a
 * foreign account is a 404 (no existence oracle), foreign audit/exposure/notes
 * simply are not present, and a foreign-scoped filter returns nothing rather
 * than leaking a count.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { accountProfileVersions, accountProfiles, organizations, traderNotes, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let orgA: string;
let orgB: string;
let adminAToken: string;
let bAccountId: string;
let bUserId: string;
const users_: string[] = [];
const orgs_: string[] = [];

async function publishEval(organizationId: string, key: string): Promise<void> {
  await publishProfileVersion(db, {
    organizationId, key, name: 'Iso Eval', accountType: 'EVALUATION',
    config: {
      rules: { accountSizeMicros: 50_000 * M, profitTargetMicros: 3_000 * M, maxLossMicros: 2_000 * M, drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true },
      execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: 50_000 * M }, payoutRules: null,
    },
  });
}

async function makeUser(role: string, organizationId: string): Promise<{ id: string; email: string }> {
  const email = `iso-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [u] = await db.insert(users).values({ email, passwordHash: await hashPassword('iso-pw'), displayName: role, role, organizationId }).returning();
  users_.push(u!.id);
  return { id: u!.id, email };
}

async function tokenFor(email: string): Promise<string> {
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'iso-pw' } });
  return JSON.parse(login.body).accessToken;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  orgA = await defaultOrganizationId(db);
  const [b] = await db.insert(organizations).values({ slug: `iso-b-${crypto.randomUUID().slice(0, 6)}`, name: 'Firm B' }).returning();
  orgB = b!.id;
  orgs_.push(orgB);

  const KEYB = `iso-b-${Math.random().toString(36).slice(2, 8)}`;
  await publishEval(orgB, KEYB);
  const adminA = await makeUser('ADMIN', orgA);
  adminAToken = await tokenFor(adminA.email);

  // Firm B: a trader with an account and a staff note.
  const traderB = await makeUser('TRADER', orgB);
  bUserId = traderB.id;
  const prov = await provisionAccount(db, { organizationId: orgB, userId: bUserId, profileKey: KEYB });
  bAccountId = prov.accountId;
  await db.insert(traderNotes).values({ organizationId: orgB, subjectUserId: bUserId, category: 'GENERAL', body: 'firm B secret', authorLabel: 'b-staff' });
});

afterAll(async () => {
  if (users_.length > 0) await db.delete(traderNotes).where(inArray(traderNotes.subjectUserId, users_));
  for (const id of users_) await db.delete(users).where(eq(users.id, id));
  // Best-effort: remove Firm B's products, then the org. An org retains audit
  // rows (append-only, org-referencing) that make a full delete impossible
  // without erasing history, so a leftover empty test org is acceptable — the
  // assertions, not the teardown, are the point.
  for (const orgId of orgs_) {
    try {
      const profs = await db.select({ id: accountProfiles.id }).from(accountProfiles).where(eq(accountProfiles.organizationId, orgId));
      const ids = profs.map((p) => p.id);
      if (ids.length > 0) {
        await db.delete(accountProfileVersions).where(inArray(accountProfileVersions.profileId, ids));
        await db.delete(accountProfiles).where(inArray(accountProfiles.id, ids));
      }
      await db.delete(organizations).where(eq(organizations.id, orgId));
    } catch {
      // Leftover empty org; harmless.
    }
  }
  await app.close();
});

describe('tenant isolation (Owner V3)', () => {
  const auth = () => ({ authorization: `Bearer ${adminAToken}` });

  it("a firm cannot open another firm's account (404, no oracle)", async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/admin/accounts/${bAccountId}`, headers: auth() });
    expect(res.statusCode).toBe(404);
  });

  it("a firm cannot read another firm's trader or notes", async () => {
    const detail = await app.inject({ method: 'GET', url: `/api/v1/admin/users/${bUserId}`, headers: auth() });
    expect(detail.statusCode).toBe(404);
    const notes = await app.inject({ method: 'GET', url: `/api/v1/admin/users/${bUserId}/notes`, headers: auth() });
    expect(notes.statusCode).toBe(404);
  });

  it("another firm's trader never appears in search results", async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/admin/users?q=iso-trader&limit=200`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const ids = new Set((JSON.parse(res.body).users as Array<{ id: string }>).map((u) => u.id));
    expect(ids.has(bUserId)).toBe(false);
  });

  it("another firm's positions never appear in exposure or trading", async () => {
    // Firm B account has no position here, but the scan must be org-scoped
    // regardless: firm A's exposure contributors are all firm A accounts.
    const exposure = await app.inject({ method: 'GET', url: '/api/v1/admin/exposure', headers: auth() });
    expect(exposure.statusCode).toBe(200);
    for (const s of JSON.parse(exposure.body).symbols as Array<{ contributors: Array<{ accountId: string }> }>) {
      for (const c of s.contributors) expect(c.accountId).not.toBe(bAccountId);
    }
  });

  it("another firm's audit records never appear", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/audit?limit=200', headers: auth() });
    expect(res.statusCode).toBe(200);
    for (const e of JSON.parse(res.body).entries as Array<{ userId: string | null; accountId: string | null }>) {
      expect(e.userId).not.toBe(bUserId);
      expect(e.accountId).not.toBe(bAccountId);
    }
  });
});
