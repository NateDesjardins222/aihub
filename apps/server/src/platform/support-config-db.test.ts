/**
 * M12-L — support configuration & seeding over the DB, plus light diagnostics
 * safety paths that need no heavy fixtures. Proves getSupportConfig seeds v1 +
 * categories + the default SLA, updateSupportConfig appends a new version, the
 * category tree is well-formed, and refund/diagnostics degrade safely.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../db/client.js';
import { organizations } from '../db/schema.js';
import type { Actor } from './actor.js';
import { DEFAULT_SLA, DEFAULT_SUPPORT_SETTINGS, getSupportConfig, listCategories, seedSupportDefaults, slaPolicy, updateSupportConfig } from './support-config.js';
import { refundEligibility, whatHappened } from './support-diagnostics.js';

let db: Database; let h: { end: (o?: unknown) => Promise<void> }; let org: string;
const staff: Actor = { type: 'ADMIN', label: 'cfg@test', userId: null };

beforeAll(async () => {
  const conn = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = conn.db; h = conn.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m12cfg-${crypto.randomUUID().slice(0, 8)}`, name: 'CFG' }).returning();
  org = o!.id;
}, 60_000);
afterAll(async () => { await h.end({ timeout: 5 }); });

describe('config seeding', () => {
  it('getSupportConfig seeds version 1 with the default settings', async () => {
    const cfg = await getSupportConfig(db, org);
    expect(cfg.version).toBe(1);
    expect(cfg.settings.reopenWindowDays).toBe(DEFAULT_SUPPORT_SETTINGS.reopenWindowDays);
    expect(cfg.settings.maxAttachmentBytes).toBe(DEFAULT_SUPPORT_SETTINGS.maxAttachmentBytes);
  });
  it('is idempotent — a second call keeps version 1', async () => {
    const a = await getSupportConfig(db, org);
    const b = await getSupportConfig(db, org);
    expect(a.version).toBe(b.version);
  });
  it('seeds the default category tree', async () => {
    const cats = await listCategories(db, org);
    expect(cats.length).toBeGreaterThan(5);
    const tops = cats.filter((c) => !c.parentKey);
    const subs = cats.filter((c) => c.parentKey);
    expect(tops.length).toBeGreaterThan(0);
    // every subcategory points at a real parent
    const keys = new Set(cats.map((c) => c.key));
    expect(subs.every((c) => keys.has(c.parentKey!))).toBe(true);
  });
  it('seeds the default SLA policy with per-priority minutes', async () => {
    const p = await slaPolicy(db, org, DEFAULT_SLA.key);
    expect(p).toBeTruthy();
    const fr = p!.firstResponseMinsByPriority as Record<string, number>;
    expect(fr['URGENT']).toBeLessThanOrEqual(fr['LOW']!);
  });
  it('seedSupportDefaults is safe to run twice', async () => {
    await seedSupportDefaults(db, org);
    await seedSupportDefaults(db, org);
    const cats = await listCategories(db, org);
    // no duplicate keys after re-seeding
    expect(new Set(cats.map((c) => c.key)).size).toBe(cats.length);
  });
});

describe('config update', () => {
  it('appends a new version and merges the patch', async () => {
    const before = await getSupportConfig(db, org);
    const after = await updateSupportConfig(db, org, { reopenWindowDays: 30 }, staff);
    expect(after.version).toBe(before.version + 1);
    expect(after.settings.reopenWindowDays).toBe(30);
    // unrelated settings are preserved
    expect(after.settings.maxAttachmentBytes).toBe(before.settings.maxAttachmentBytes);
  });
  it('getSupportConfig then returns the latest version', async () => {
    const latest = await getSupportConfig(db, org);
    expect(latest.settings.reopenWindowDays).toBe(30);
  });
});

describe('diagnostics safe paths', () => {
  it('refundEligibility reports ORDER_NOT_FOUND for an unknown order', async () => {
    const r = await refundEligibility(db, org, crypto.randomUUID());
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('ORDER_NOT_FOUND');
  });
  it('whatHappened returns a safe base for an unknown object type', async () => {
    const d = await whatHappened(db, org, 'nonsense_type', 'x');
    expect(d.objectType).toBe('nonsense_type');
    expect(Array.isArray(d.facts)).toBe(true);
  });
  it('whatHappened reports order-not-found for a missing order', async () => {
    const d = await whatHappened(db, org, 'order', crypto.randomUUID());
    expect(d.headline).toMatch(/not found/i);
  });
  it('whatHappened reports certificate-not-found for a missing certificate', async () => {
    const d = await whatHappened(db, org, 'certificate', crypto.randomUUID());
    expect(d.headline).toMatch(/not found/i);
  });
});
