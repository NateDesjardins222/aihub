/**
 * M11-C — attribution engine: click recording, first/last touch, the configurable
 * window, deterministic precedence (explicit code > valid link touch > none), and
 * click stats. Every assertion is deterministic (time is injected, never real-clock).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { affiliateTouches, organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import type { Actor } from './actor.js';
import { submitApplication, reviewApplication, acceptAffiliateAgreement, setAffiliateStatus } from './affiliates.js';
import { hashIp, recordClick, resolveAttribution, clickStats } from './affiliate-attribution.js';
import { getAffiliateConfig, updateAffiliateConfig } from './affiliate-config.js';

const OWNER: Actor = { type: 'ADMIN', label: 'owner@test', userId: null };
let db: Database; let handleSql: { end: (o?: unknown) => Promise<void> }; let org: string; let seq = 0;

async function user(): Promise<string> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `at-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('at-pw-12345678'), displayName: `U${seq}`, role: 'TRADER', organizationId: org }).returning({ id: users.id });
  return u!.id;
}
async function activeAffiliate(): Promise<{ affiliateId: string; code: string; userId: string }> {
  const userId = await user();
  const { affiliateId } = await submitApplication(db, { organizationId: org, userId, fullName: `Aff ${seq}`, email: `aff-${seq}@creator.test`, actor: OWNER });
  await reviewApplication(db, affiliateId, 'APPROVE', OWNER);
  const { code } = await acceptAffiliateAgreement(db, affiliateId, { actor: OWNER });
  return { affiliateId, code, userId };
}
const sref = () => `s-${crypto.randomUUID()}`;

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m11att-${crypto.randomUUID().slice(0, 8)}`, name: 'M11ATT' }).returning();
  org = o!.id;
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('hashIp', () => {
  it('is deterministic for the same input', () => { expect(hashIp('1.2.3.4')).toBe(hashIp('1.2.3.4')); });
  it('differs for different inputs', () => { expect(hashIp('1.2.3.4')).not.toBe(hashIp('4.3.2.1')); });
  it('returns null for null/empty', () => { expect(hashIp(null)).toBeNull(); expect(hashIp(undefined)).toBeNull(); expect(hashIp('')).toBeNull(); });
  it('does not store the raw ip', () => { expect(hashIp('8.8.8.8')).not.toContain('8.8.8.8'); });
});

describe('recordClick', () => {
  it('records a click for an active code', async () => {
    const a = await activeAffiliate();
    expect((await recordClick(db, { organizationId: org, code: a.code, sessionRef: sref() })).recorded).toBe(true);
  });
  it('refuses an unknown code', async () => {
    expect((await recordClick(db, { organizationId: org, code: 'nosuchcode', sessionRef: sref() })).recorded).toBe(false);
  });
  it('refuses a suspended affiliate code', async () => {
    const a = await activeAffiliate();
    await setAffiliateStatus(db, a.affiliateId, 'SUSPENDED', OWNER, 'test suspend');
    expect((await recordClick(db, { organizationId: org, code: a.code, sessionRef: sref() })).recorded).toBe(false);
  });
  it('creates exactly one touch row per session and preserves first touch across clicks', async () => {
    const a = await activeAffiliate();
    const b = await activeAffiliate();
    const s = sref();
    await recordClick(db, { organizationId: org, code: a.code, sessionRef: s });
    await recordClick(db, { organizationId: org, code: b.code, sessionRef: s });
    const touches = await db.select().from(affiliateTouches).where(and(eq(affiliateTouches.organizationId, org), eq(affiliateTouches.sessionRef, s)));
    expect(touches.length).toBe(1);
    expect(touches[0]!.firstTouchAffiliateId).toBe(a.affiliateId);
    expect(touches[0]!.lastTouchAffiliateId).toBe(b.affiliateId);
  });
});

describe('resolveAttribution precedence', () => {
  it('unexpired link touch attributes to last touch (REFERRAL_LINK)', async () => {
    const a = await activeAffiliate();
    const s = sref();
    await recordClick(db, { organizationId: org, code: a.code, sessionRef: s });
    const r = await resolveAttribution(db, org, { sessionRef: s });
    expect(r?.affiliateId).toBe(a.affiliateId);
    expect(r?.source).toBe('LINK');
    expect(r?.finalAttributionReason).toBe('REFERRAL_LINK');
  });
  it('explicit code matching last touch is CHECKOUT_CODE', async () => {
    const a = await activeAffiliate();
    const s = sref();
    await recordClick(db, { organizationId: org, code: a.code, sessionRef: s });
    const r = await resolveAttribution(db, org, { sessionRef: s, explicitCode: a.code });
    expect(r?.source).toBe('CODE');
    expect(r?.finalAttributionReason).toBe('CHECKOUT_CODE');
  });
  it('explicit code different from last touch overrides (CHECKOUT_CODE_OVERRIDE) and preserves first touch', async () => {
    const a = await activeAffiliate();
    const b = await activeAffiliate();
    const s = sref();
    await recordClick(db, { organizationId: org, code: a.code, sessionRef: s });
    const r = await resolveAttribution(db, org, { sessionRef: s, explicitCode: b.code });
    expect(r?.affiliateId).toBe(b.affiliateId);
    expect(r?.finalAttributionReason).toBe('CHECKOUT_CODE_OVERRIDE');
    expect(r?.firstTouchAffiliateId).toBe(a.affiliateId);
  });
  it('an expired touch does not attribute (window enforced)', async () => {
    const a = await activeAffiliate();
    const s = sref();
    await recordClick(db, { organizationId: org, code: a.code, sessionRef: s });
    const far = new Date(Date.now() + 400 * 86_400_000);
    expect(await resolveAttribution(db, org, { sessionRef: s, at: far })).toBeNull();
  });
  it('an invalid explicit code falls back to a valid link touch', async () => {
    const a = await activeAffiliate();
    const s = sref();
    await recordClick(db, { organizationId: org, code: a.code, sessionRef: s });
    const r = await resolveAttribution(db, org, { sessionRef: s, explicitCode: 'garbage' });
    expect(r?.source).toBe('LINK');
    expect(r?.affiliateId).toBe(a.affiliateId);
  });
  it('no touch and no code → null', async () => {
    expect(await resolveAttribution(db, org, { sessionRef: sref() })).toBeNull();
  });
  it('no session and an invalid code → null', async () => {
    expect(await resolveAttribution(db, org, { explicitCode: 'garbage' })).toBeNull();
  });
  it('explicit code with no prior touch attributes as CHECKOUT_CODE', async () => {
    const a = await activeAffiliate();
    const r = await resolveAttribution(db, org, { sessionRef: sref(), explicitCode: a.code });
    expect(r?.finalAttributionReason).toBe('CHECKOUT_CODE');
    expect(r?.affiliateId).toBe(a.affiliateId);
  });
});

describe('configurable window', () => {
  it('a longer configured window extends the touch expiry', async () => {
    await updateAffiliateConfig(db, org, { attributionWindowDays: 60 }, OWNER);
    const cfg = await getAffiliateConfig(db, org);
    expect(cfg.settings.attributionWindowDays).toBe(60);
    const a = await activeAffiliate();
    const s = sref();
    await recordClick(db, { organizationId: org, code: a.code, sessionRef: s });
    const [t] = await db.select().from(affiliateTouches).where(and(eq(affiliateTouches.organizationId, org), eq(affiliateTouches.sessionRef, s)));
    const days = (t!.expiresAt.getTime() - t!.lastTouchAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(60);
    await updateAffiliateConfig(db, org, { attributionWindowDays: 30 }, OWNER); // restore
  });
});

describe('clickStats', () => {
  it('counts clicks and unique sessions', async () => {
    const a = await activeAffiliate();
    const s1 = sref(); const s2 = sref();
    await recordClick(db, { organizationId: org, code: a.code, sessionRef: s1 });
    await recordClick(db, { organizationId: org, code: a.code, sessionRef: s1 });
    await recordClick(db, { organizationId: org, code: a.code, sessionRef: s2 });
    const stats = await clickStats(db, a.affiliateId);
    expect(stats.clicks).toBe(3);
    expect(stats.uniqueSessions).toBe(2);
  });
  it('honours the since filter', async () => {
    const a = await activeAffiliate();
    await recordClick(db, { organizationId: org, code: a.code, sessionRef: sref() });
    const future = new Date(Date.now() + 86_400_000);
    expect((await clickStats(db, a.affiliateId, future)).clicks).toBe(0);
  });
  it('is zero for an affiliate with no clicks', async () => {
    const a = await activeAffiliate();
    expect((await clickStats(db, a.affiliateId)).clicks).toBe(0);
  });
});
