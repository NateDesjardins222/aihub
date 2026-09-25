/**
 * Command Center (M10-K): the owner landing aggregate is assembled from real,
 * server-authoritative data — never fabricated. These tests prove the shape,
 * that attention items link to real surfaces, and that a genuine problem (a
 * dead-letter job) surfaces truthfully in both the aggregate and the brief.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../db/client.js';
import { organizations, outboxEvents } from '../db/schema.js';
import { commandCenter, dailyBrief } from './command-center.js';

let db: Database;
let handleSql: { end: (o?: unknown) => Promise<void> };
let org: string;

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db;
  handleSql = h.sql as never;
  const [o] = await db
    .insert(organizations)
    .values({ slug: `m10cc-${crypto.randomUUID().slice(0, 8)}`, name: 'M10CC' })
    .returning();
  org = o!.id;
}, 60_000);
afterAll(async () => {
  await handleSql.end({ timeout: 5 });
});

describe('M10-K Command Center', () => {
  it('assembles a well-formed aggregate from real system data', async () => {
    const cc = await commandCenter(db, org);
    expect(['HEALTHY', 'DEGRADED', 'CRITICAL']).toContain(cc.overall);
    expect(cc.health).toHaveProperty('doctor');
    expect(cc.health).toHaveProperty('integrityOk');
    expect(cc.kpis).toHaveProperty('totalCustomers');
    expect(cc.kpis).toHaveProperty('pendingPayouts');
    expect(cc.kpis).toHaveProperty('payoutLiabilityMicros');
    expect(Array.isArray(cc.attention)).toBe(true);
    expect(Array.isArray(cc.recentActions)).toBe(true);
    expect(typeof cc.at).toBe('string');
  });

  it('every attention item links to a real surface and carries a severity', async () => {
    const cc = await commandCenter(db, org);
    for (const item of cc.attention) {
      expect(['WARNING', 'CRITICAL']).toContain(item.severity);
      expect(item.link.startsWith('/admin/')).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it('a dead-letter job surfaces truthfully in the aggregate and the brief', async () => {
    await db.insert(outboxEvents).values({
      aggregateType: 'test',
      aggregateId: crypto.randomUUID(),
      type: 'test.event',
      stateVersion: 1,
      payload: {} as never,
      deadLetter: true,
      attempts: 3,
      lastError: 'boom',
    });
    const cc = await commandCenter(db, org);
    expect(cc.kpis.deadLetterJobs).toBeGreaterThanOrEqual(1);
    expect(cc.attention.some((a) => a.label.includes('dead-letter'))).toBe(true);
    // A dead-letter job means "not everything is fine" — never HEALTHY.
    expect(cc.overall).not.toBe('HEALTHY');

    const brief = await dailyBrief(db, org);
    expect(brief.lines.some((l) => l.includes('dead-letter'))).toBe(true);
    expect(brief.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(brief.kpis.deadLetterJobs).toBe(cc.kpis.deadLetterJobs);
  });
});
