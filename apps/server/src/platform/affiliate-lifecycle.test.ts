/**
 * M11-A/B — affiliate config, money/tier math, code rules, and the locked
 * activation flow (apply → review → approve → agreement → activate → code).
 * Approval never activates; a code exists only after the agreement is accepted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { affiliateCodes, affiliates, organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import type { Actor } from './actor.js';
import {
  DEFAULT_AFFILIATE_SETTINGS, getAffiliateConfig, updateAffiliateConfig,
  commissionMicrosFor, tierForRevenue, tierRateBps,
} from './affiliate-config.js';
import {
  canonicalizeCode, validateCode, submitApplication, reviewApplication,
  acceptAffiliateAgreement, resolveActiveCode, affiliateForUser, computeEffectiveRateBps,
  changeAffiliateRate,
} from './affiliates.js';

const M = 1_000_000;
const OWNER: Actor = { type: 'ADMIN', label: 'owner@test', userId: null };
let db: Database; let handleSql: { end: (o?: unknown) => Promise<void> }; let org: string;

async function makeUser(role = 'TRADER'): Promise<string> {
  const [u] = await db.insert(users).values({ email: `aff-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('aff-pw-12345678'), displayName: 'Applicant', role, organizationId: org }).returning({ id: users.id });
  return u!.id;
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m11a-${crypto.randomUUID().slice(0, 8)}`, name: 'M11A' }).returning();
  org = o!.id;
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('config defaults + versioning', () => {
  it('seeds documented defaults on first read', async () => {
    const cfg = await getAffiliateConfig(db, org);
    expect(cfg.version).toBe(1);
    expect(cfg.settings.attributionWindowDays).toBe(30);
    expect(cfg.settings.commissionMaturityDays).toBe(14);
    expect(cfg.settings.tierRatesBps.AFFILIATE).toBe(1500);
    expect(cfg.settings.minPayoutMicros).toBe(50 * M);
  });
  it('updates create a new version, preserving history', async () => {
    const before = await getAffiliateConfig(db, org);
    const after = await updateAffiliateConfig(db, org, { commissionMaturityDays: 21 }, OWNER);
    expect(after.version).toBe(before.version + 1);
    expect(after.settings.commissionMaturityDays).toBe(21);
    expect(after.settings.attributionWindowDays).toBe(30); // untouched keys preserved
  });
});

describe('money + tier math (integer only)', () => {
  it('commission floors qualified*bps/10000', () => {
    expect(commissionMicrosFor(100 * M, 1500)).toBe(15 * M);
    expect(commissionMicrosFor(95 * M, 1500)).toBe(Math.floor(95 * M * 0.15)); // 25K Core-ish
    expect(commissionMicrosFor(90 * M, 1500)).toBe(135 * M / 10); // $13.50
    expect(commissionMicrosFor(0, 1500)).toBe(0);
    expect(commissionMicrosFor(100 * M, 0)).toBe(0);
  });
  it('17.5% rate is exact (no float error)', () => {
    expect(commissionMicrosFor(200 * M, 1750)).toBe(35 * M);
  });
  it.each([
    [9_999 * M + 990000, 'AFFILIATE'],
    [10_000 * M, 'PARTNER'],
    [29_999 * M + 990000, 'PARTNER'],
    [30_000 * M, 'GOLD'],
    [74_999 * M + 990000, 'GOLD'],
    [75_000 * M, 'PLATINUM'],
  ] as const)('tier boundary %d → %s', (rev, tier) => {
    expect(tierForRevenue(DEFAULT_AFFILIATE_SETTINGS, rev)).toBe(tier);
  });
  it('tier rates map correctly', () => {
    expect(tierRateBps(DEFAULT_AFFILIATE_SETTINGS, 'PARTNER')).toBe(1750);
    expect(tierRateBps(DEFAULT_AFFILIATE_SETTINGS, 'PLATINUM')).toBe(2500);
  });
});

describe('code canonicalization + validation', () => {
  it('NATE, nate, Nate canonicalize identically', () => {
    expect(canonicalizeCode('NATE')).toBe('nate');
    expect(canonicalizeCode('Nate')).toBe('nate');
    expect(canonicalizeCode('  nAtE ')).toBe('nate');
  });
  it('rejects reserved, too-short, and unsafe codes', () => {
    expect(() => validateCode('admin')).toThrow();
    expect(() => validateCode('ab')).toThrow();
    expect(() => validateCode("na'te")).toThrow();
    expect(() => validateCode('<script>')).toThrow();
    expect(validateCode('NateD')).toBe('nated');
  });
});

describe('locked activation flow', () => {
  it('apply → approve does NOT activate or create a code; accept agreement activates + generates code', async () => {
    const userId = await makeUser();
    const { affiliateId } = await submitApplication(db, { organizationId: org, userId, fullName: 'Nate Desjardins', email: 'nate@creator.test', brandName: 'NateTrades', primaryPlatform: 'YouTube', actor: OWNER });
    let aff = (await affiliateForUser(db, org, userId))!;
    expect(aff.status).toBe('SUBMITTED');

    await reviewApplication(db, affiliateId, 'APPROVE', OWNER, { notes: 'good fit' });
    aff = (await affiliateForUser(db, org, userId))!;
    expect(aff.status).toBe('APPROVED_PENDING_AGREEMENT');
    // No active code yet.
    const preCodes = await db.select().from(affiliateCodes).where(eq(affiliateCodes.affiliateId, affiliateId));
    expect(preCodes.length).toBe(0);

    const res = await acceptAffiliateAgreement(db, affiliateId, { ip: '1.2.3.4', userAgent: 'jest', sessionRef: 's1', actor: OWNER });
    expect(res.status).toBe('ACTIVE');
    aff = (await affiliateForUser(db, org, userId))!;
    expect(aff.status).toBe('ACTIVE');
    expect(aff.activatedAt).toBeTruthy();
    const codes = await db.select().from(affiliateCodes).where(eq(affiliateCodes.affiliateId, affiliateId));
    expect(codes.length).toBe(1);
    expect(codes[0]!.kind).toBe('PRIMARY');

    // The code resolves only while the affiliate is ACTIVE.
    const resolved = await resolveActiveCode(db, org, codes[0]!.code.toUpperCase());
    expect(resolved?.affiliateId).toBe(affiliateId);
  });

  it('accepting the agreement before approval is refused', async () => {
    const userId = await makeUser();
    const { affiliateId } = await submitApplication(db, { organizationId: org, userId, fullName: 'Too Early', email: 'early@creator.test', actor: OWNER });
    await expect(acceptAffiliateAgreement(db, affiliateId, { actor: OWNER })).rejects.toThrow();
  });

  it('a declined applicant never activates', async () => {
    const userId = await makeUser();
    const { affiliateId } = await submitApplication(db, { organizationId: org, userId, fullName: 'Declined Person', email: 'no@creator.test', actor: OWNER });
    await reviewApplication(db, affiliateId, 'DECLINE', OWNER, { declineReason: 'not a fit' });
    const aff = (await affiliateForUser(db, org, userId))!;
    expect(aff.status).toBe('DECLINED');
    await expect(acceptAffiliateAgreement(db, affiliateId, { actor: OWNER })).rejects.toThrow();
  });

  it('a duplicate application for the same user is refused', async () => {
    const userId = await makeUser();
    await submitApplication(db, { organizationId: org, userId, fullName: 'Dup', email: 'dup@creator.test', actor: OWNER });
    await expect(submitApplication(db, { organizationId: org, userId, fullName: 'Dup', email: 'dup@creator.test', actor: OWNER })).rejects.toThrow();
  });

  it('a disabled/terminated affiliate code does not resolve', async () => {
    const userId = await makeUser();
    const { affiliateId } = await submitApplication(db, { organizationId: org, userId, fullName: 'Term Later', email: 'term@creator.test', actor: OWNER });
    await reviewApplication(db, affiliateId, 'APPROVE', OWNER);
    const { code } = await acceptAffiliateAgreement(db, affiliateId, { actor: OWNER });
    expect((await resolveActiveCode(db, org, code))).toBeTruthy();
    await db.update(affiliates).set({ status: 'SUSPENDED' }).where(eq(affiliates.id, affiliateId));
    expect(await resolveActiveCode(db, org, code)).toBeNull();
  });
});

describe('effective rate: custom override wins over tier', () => {
  it('computeEffectiveRateBps prefers an in-effect custom rate', () => {
    const base = { tierRateBps: 1750, customRateBps: 2200, customRateEffectiveAt: new Date(Date.now() - 1000), customRateExpiresAt: null };
    expect(computeEffectiveRateBps(base).bps).toBe(2200);
    expect(computeEffectiveRateBps(base).source).toBe('CUSTOM');
  });
  it('an expired custom rate falls back to tier', () => {
    const base = { tierRateBps: 1750, customRateBps: 2200, customRateEffectiveAt: new Date(Date.now() - 2000), customRateExpiresAt: new Date(Date.now() - 1000) };
    expect(computeEffectiveRateBps(base).bps).toBe(1750);
  });
  it('changeAffiliateRate persists the override, sets STRATEGIC tier, and records history', async () => {
    const userId = await makeUser();
    const { affiliateId } = await submitApplication(db, { organizationId: org, userId, fullName: 'Custom Rate', email: 'custom@creator.test', actor: OWNER });
    await reviewApplication(db, affiliateId, 'APPROVE', OWNER);
    await acceptAffiliateAgreement(db, affiliateId, { actor: OWNER });
    await changeAffiliateRate(db, affiliateId, 2200, OWNER, { reason: 'strategic partner' });
    const [aff] = await db.select().from(affiliates).where(eq(affiliates.id, affiliateId));
    expect(aff!.effectiveRateBps).toBe(2200);
    expect(aff!.tier).toBe('STRATEGIC');
  });
});
