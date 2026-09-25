/**
 * M10.1 hardening — step-up reauth & impersonation adversarial.
 *
 * Attacks the two highest-trust primitives: the step-up token (class-scoped,
 * user-scoped, tamper-evident) and support impersonation (recorded, READ_ONLY,
 * no customer password, forbidden-action gate). A token must never satisfy a
 * class or user it was not minted for; a tampered token must never verify; a
 * dangerous customer action must never be permitted for an impersonated session.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { mintStepUp, verifyStepUp } from './reauth.js';
import { REAUTH_CLASSES } from './permissions.js';
import { startImpersonation, verifyImpersonation, endImpersonation, listActiveImpersonations, impersonationBlocks, IMPERSONATION_FORBIDDEN } from './impersonation.js';
import type { Actor } from './actor.js';

const ACTOR: Actor = { type: 'ADMIN', label: 'reauth@test', userId: null };
const PW = 'reauth-torture-pw-123';
let db: Database;
let handleSql: { end: (o?: unknown) => Promise<void> };
let org: string; let owner: string; let other: string; let target: string; let staffTarget: string;

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m101ri-${crypto.randomUUID().slice(0, 8)}`, name: 'M101RI' }).returning();
  org = o!.id;
  const mk = async (role: string) => {
    const [u] = await db.insert(users).values({ email: `ri-${role}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword(PW), displayName: role, role, status: 'ACTIVE', organizationId: org }).returning({ id: users.id });
    return u!.id;
  };
  owner = await mk('SUPER_ADMIN'); other = await mk('ADMIN'); target = await mk('TRADER'); staffTarget = await mk('ADMIN');
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('step-up token is class- and user-scoped and tamper-evident', () => {
  it('a fresh token verifies for the same user + class', async () => {
    const { token } = await mintStepUp(db, owner, PW, 'FINANCIAL');
    expect(verifyStepUp(token, owner, 'FINANCIAL')).toBe(true);
  });
  it('the token does not satisfy a different class', async () => {
    const { token } = await mintStepUp(db, owner, PW, 'FINANCIAL');
    expect(verifyStepUp(token, owner, 'KILL_SWITCH')).toBe(false);
  });
  it('the token does not satisfy a different user', async () => {
    const { token } = await mintStepUp(db, owner, PW, 'STAFF');
    expect(verifyStepUp(token, other, 'STAFF')).toBe(false);
  });
  it('a tampered token does not verify', async () => {
    const { token } = await mintStepUp(db, owner, PW, 'CONFIG');
    expect(verifyStepUp(`${token}x`, owner, 'CONFIG')).toBe(false);
    expect(verifyStepUp(token.slice(0, -3), owner, 'CONFIG')).toBe(false);
  });
  it('an empty/garbage token does not verify', () => {
    expect(verifyStepUp(undefined, owner, 'FINANCIAL')).toBe(false);
    expect(verifyStepUp('', owner, 'FINANCIAL')).toBe(false);
    expect(verifyStepUp('not.a.jwt', owner, 'FINANCIAL')).toBe(false);
  });
  it('the wrong password is refused', async () => {
    await expect(mintStepUp(db, owner, 'wrong-password', 'FINANCIAL')).rejects.toThrow();
  });
  it.each(REAUTH_CLASSES)('every reauth class round-trips: %s', async (cls) => {
    const { token } = await mintStepUp(db, owner, PW, cls);
    expect(verifyStepUp(token, owner, cls)).toBe(true);
    // and never cross-satisfies a different class
    const otherClass = REAUTH_CLASSES.find((c) => c !== cls)!;
    expect(verifyStepUp(token, owner, otherClass)).toBe(false);
  });
});

describe('impersonation is safe by construction', () => {
  it('requires a reason of substance', async () => {
    await expect(startImpersonation(db, { organizationId: org, operatorUserId: owner, targetUserId: target, reason: '', actor: ACTOR })).rejects.toThrow();
    await expect(startImpersonation(db, { organizationId: org, operatorUserId: owner, targetUserId: target, reason: 'x', actor: ACTOR })).rejects.toThrow();
  });
  it('refuses to impersonate yourself', async () => {
    await expect(startImpersonation(db, { organizationId: org, operatorUserId: owner, targetUserId: owner, reason: 'self impersonation attempt', actor: ACTOR })).rejects.toThrow();
  });
  it('refuses to impersonate a non-customer (staff)', async () => {
    await expect(startImpersonation(db, { organizationId: org, operatorUserId: owner, targetUserId: staffTarget, reason: 'impersonate staff attempt', actor: ACTOR })).rejects.toThrow();
  });
  it('refuses an unknown target', async () => {
    await expect(startImpersonation(db, { organizationId: org, operatorUserId: owner, targetUserId: crypto.randomUUID(), reason: 'ghost target', actor: ACTOR })).rejects.toThrow();
  });
  it('a started session mints a verifiable token and can be ended', async () => {
    const s = await startImpersonation(db, { organizationId: org, operatorUserId: owner, targetUserId: target, reason: 'view as customer for support', actor: ACTOR });
    const claims = await verifyImpersonation(db, s.token);
    expect(claims?.sub).toBe(target);
    expect(claims?.op).toBe(owner);
    expect(claims?.mode).toBe('READ_ONLY');
    await endImpersonation(db, s.sessionId, ACTOR);
    // After ending, the token no longer verifies (session not ACTIVE).
    expect(await verifyImpersonation(db, s.token)).toBeNull();
  });
  it('a garbage impersonation token returns null (never throws open)', async () => {
    expect(await verifyImpersonation(db, 'not-a-token')).toBeNull();
    expect(await verifyImpersonation(db, '')).toBeNull();
  });
  it('an active session appears in the active list and drops out when ended', async () => {
    const s = await startImpersonation(db, { organizationId: org, operatorUserId: owner, targetUserId: target, reason: 'active-list check support', actor: ACTOR });
    let active = await listActiveImpersonations(db);
    expect(active.some((a) => a.id === s.sessionId)).toBe(true);
    await endImpersonation(db, s.sessionId, ACTOR);
    active = await listActiveImpersonations(db);
    expect(active.some((a) => a.id === s.sessionId)).toBe(false);
  });
  it.each(IMPERSONATION_FORBIDDEN)('forbidden action "%s" is blocked in READ_ONLY mode', (action) => {
    expect(impersonationBlocks('READ_ONLY', action)).toBe(true);
  });
  it.each(IMPERSONATION_FORBIDDEN)('forbidden action "%s" is blocked in SUPPORT mode too', (action) => {
    expect(impersonationBlocks('SUPPORT', action)).toBe(true);
  });
  it('ending an unknown session is refused', async () => {
    await expect(endImpersonation(db, crypto.randomUUID(), ACTOR)).rejects.toThrow();
  });
  it('re-ending an already-ended session is a safe no-op', async () => {
    const s = await startImpersonation(db, { organizationId: org, operatorUserId: owner, targetUserId: target, reason: 'double-end safety check', actor: ACTOR });
    await endImpersonation(db, s.sessionId, ACTOR);
    await expect(endImpersonation(db, s.sessionId, ACTOR)).resolves.toBeUndefined();
  });
});

// Sanity: the target really is a TRADER (fixture guard).
it('the impersonation target is a customer', async () => {
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, target));
  expect(u?.role).toBe('TRADER');
});
