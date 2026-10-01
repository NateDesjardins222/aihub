/**
 * Celebrations — authoritative sourcing, idempotent acknowledgement (no replay on
 * refresh), and strict cross-customer isolation. Runs against the real database.
 *
 * These are the Experience-Layer safety proofs: a celebration fires only from a real
 * authoritative achievement, it is shown once (ack → never pending again), and one
 * customer can NEVER see or affect another's celebrations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { celebrationAcks, customerIdentities, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { issueAchievement } from './achievements.js';
import { acknowledgeCelebration, listPendingCelebrations } from './celebrations.js';

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const userIds: string[] = [];

async function makeUser(label: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('pw'), displayName: label, organizationId })
    .returning();
  userIds.push(u!.id);
  await ensureCustomerIdentity(db, { organizationId, userId: u!.id });
  return u!.id;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
});

afterAll(async () => {
  const ids = await db.select({ id: customerIdentities.id }).from(customerIdentities).where(inArray(customerIdentities.userId, userIds));
  if (ids.length) await db.delete(celebrationAcks).where(inArray(celebrationAcks.customerIdentityId, ids.map((r) => r.id)));
  await app.close();
});

describe('celebrations — authoritative + idempotent + isolated', () => {
  it('derives celebrations only from authoritative achievements, highest priority first', async () => {
    const user = await makeUser('celeb-a');
    await issueAchievement(db, { organizationId, userId: user, type: 'FUNDED', dedupeKey: `funded:${user}` });
    await issueAchievement(db, { organizationId, userId: user, type: 'FIRST_PAYOUT', dedupeKey: `fp:${user}` });
    await issueAchievement(db, { organizationId, userId: user, type: 'TENK_CLUB', dedupeKey: `10k:${user}` });

    const pending = await listPendingCelebrations(db, user);
    const types = pending.map((p) => p.type);
    expect(types).toContain('FUNDED');
    expect(types).toContain('FIRST_PAYOUT');
    expect(types).toContain('TENK_CLUB');
    // Priority: FIRST_PAYOUT (80) > FUNDED (70) > TENK_CLUB (50).
    expect(pending.map((p) => p.priority)).toEqual([...pending.map((p) => p.priority)].sort((a, b) => b - a));
    const fp = pending.findIndex((p) => p.type === 'FIRST_PAYOUT');
    const funded = pending.findIndex((p) => p.type === 'FUNDED');
    const tenk = pending.findIndex((p) => p.type === 'TENK_CLUB');
    expect(fp).toBeLessThan(funded);
    expect(funded).toBeLessThan(tenk);
    // Every event key is the stable achievement key.
    for (const p of pending) expect(p.eventKey).toMatch(/^achievement:[0-9a-f-]{36}$/);
  });

  it('a celebration is shown once: after ack it never returns (no replay on refresh)', async () => {
    const user = await makeUser('celeb-b');
    await issueAchievement(db, { organizationId, userId: user, type: 'FIFTYK_CLUB', dedupeKey: `50k:${user}` });
    const before = await listPendingCelebrations(db, user);
    const key = before.find((p) => p.type === 'FIFTYK_CLUB')!.eventKey;

    const first = await acknowledgeCelebration(db, user, key);
    expect(first).toBe(true);               // newly stored
    const second = await acknowledgeCelebration(db, user, key);
    expect(second).toBe(false);             // idempotent — already acked

    const after = await listPendingCelebrations(db, user);        // "refresh"
    expect(after.map((p) => p.eventKey)).not.toContain(key);
  });

  it('customer A never sees or can affect customer B’s celebrations', async () => {
    const a = await makeUser('celeb-iso-a');
    const b = await makeUser('celeb-iso-b');
    await issueAchievement(db, { organizationId, userId: a, type: 'FUNDED', dedupeKey: `funded:${a}` });
    await issueAchievement(db, { organizationId, userId: b, type: 'FUNDED', dedupeKey: `funded:${b}` });

    const aPending = await listPendingCelebrations(db, a);
    const bPending = await listPendingCelebrations(db, b);
    const aKeys = new Set(aPending.map((p) => p.eventKey));
    const bKeys = new Set(bPending.map((p) => p.eventKey));
    // Disjoint — no shared event key across customers.
    for (const k of aKeys) expect(bKeys.has(k)).toBe(false);

    // B acking A's event key does NOT remove it from A's pending feed.
    const aKey = [...aKeys][0]!;
    await acknowledgeCelebration(db, b, aKey);
    const aStill = await listPendingCelebrations(db, a);
    expect(aStill.map((p) => p.eventKey)).toContain(aKey);
  });

  it('rejects a malformed event key (cannot force-store arbitrary acks)', async () => {
    const user = await makeUser('celeb-bad');
    expect(await acknowledgeCelebration(db, user, 'not-a-key')).toBe(false);
    expect(await acknowledgeCelebration(db, user, 'achievement:../etc')).toBe(false);
    expect(await acknowledgeCelebration(db, user, '')).toBe(false);
  });
});
