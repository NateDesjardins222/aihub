/**
 * M10.1 hardening — concurrency, storms, kill switches, integrity.
 *
 * Adversarial concurrency against the operational-safety surfaces: kill-switch
 * engage/release under contention, optimistic-concurrency conflict detection on
 * feature flags, alert/incident storms, and the audit-chain integrity invariant.
 * Every raise must be accounted for exactly once; a switch must fail closed; a
 * stale write must be refused. Kill switches are global, so this file engages
 * only DISABLE_EXTERNAL_EXECUTION (checked by no HTTP route in the test suite)
 * and always releases it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { alerts, incidents, killSwitches, organizations } from '../db/schema.js';
import type { Actor } from './actor.js';
import { engageKillSwitch, releaseKillSwitch, isEngaged, assertNotEngaged } from './kill-switches.js';
import { setFlag, isEnabled } from './feature-flags.js';
import { raiseAlert, alertSummary } from './alerts.js';
import { openOrGroupIncident } from './incidents.js';
import { runIntegrityChecks } from './integrity.js';
import { verifyAuditChain } from './audit.js';

const ACTOR: Actor = { type: 'ADMIN', label: 'torture@test', userId: null };
const KS = 'DISABLE_EXTERNAL_EXECUTION' as const;
let db: Database;
let handleSql: { end: (o?: unknown) => Promise<void> };
let org: string;

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m101tort-${crypto.randomUUID().slice(0, 8)}`, name: 'M101TORT' }).returning();
  org = o!.id;
}, 60_000);
afterEach(async () => { await releaseKillSwitch(db, KS, 'test cleanup', ACTOR, org).catch(() => {}); });
afterAll(async () => { await releaseKillSwitch(db, KS, 'final cleanup', ACTOR, org).catch(() => {}); await handleSql.end({ timeout: 5 }); });

describe('kill switch fail-safe + idempotency', () => {
  it('engage blocks (423), release restores', async () => {
    await engageKillSwitch(db, KS, 'torture engage', ACTOR, org);
    expect(await isEngaged(db, KS)).toBe(true);
    await expect(assertNotEngaged(db, KS)).rejects.toMatchObject({ statusCode: 423 });
    await releaseKillSwitch(db, KS, 'torture release', ACTOR, org);
    expect(await isEngaged(db, KS)).toBe(false);
    await expect(assertNotEngaged(db, KS)).resolves.toBeUndefined();
  });
  it('engaging requires a reason', async () => {
    await expect(engageKillSwitch(db, KS, '', ACTOR, org)).rejects.toThrow();
    await expect(engageKillSwitch(db, KS, 'x', ACTOR, org)).rejects.toThrow();
  });
  it('a double-engage is idempotent (stays engaged, still one row)', async () => {
    await engageKillSwitch(db, KS, 'first', ACTOR, org);
    await engageKillSwitch(db, KS, 'second', ACTOR, org);
    expect(await isEngaged(db, KS)).toBe(true);
    const ksRows = await db.select({ n: sql<number>`count(*)::int` }).from(killSwitches).where(eq(killSwitches.key, KS));
    expect(ksRows[0]?.n ?? 0).toBe(1);
  });
  it('engage then a burst of concurrent releases converges to released', async () => {
    await engageKillSwitch(db, KS, 'burst', ACTOR, org);
    await Promise.all(Array.from({ length: 8 }, () => releaseKillSwitch(db, KS, 'concurrent release', ACTOR, org)));
    expect(await isEngaged(db, KS)).toBe(false);
  });
});

describe('feature flag optimistic concurrency', () => {
  it('two writers with the same stale expectedUpdatedAt: exactly one conflicts', async () => {
    const key = `TORTURE_FLAG_${crypto.randomUUID().slice(0, 6)}`;
    const created = await setFlag(db, { organizationId: org, key, environment: 'ALL', enabled: false, actor: ACTOR });
    const stale = created.updatedAt.toISOString();
    const results = await Promise.allSettled([
      setFlag(db, { organizationId: org, key, environment: 'ALL', enabled: true, expectedUpdatedAt: stale, actor: ACTOR }),
      setFlag(db, { organizationId: org, key, environment: 'ALL', enabled: false, expectedUpdatedAt: stale, actor: ACTOR }),
    ]);
    const rejected = results.filter((r) => r.status === 'rejected');
    // Exactly one writer wins; the other is refused with a conflict (no silent
    // lost update). Fixed in M10.1 via a pre-image-guarded conditional UPDATE.
    expect(rejected.length).toBe(1);
    expect(typeof (await isEnabled(db, key, 'ALL'))).toBe('boolean');
  });
  it('a write with a matching expectedUpdatedAt succeeds', async () => {
    const key = `TORTURE_FLAG2_${crypto.randomUUID().slice(0, 6)}`;
    const created = await setFlag(db, { organizationId: org, key, enabled: false, actor: ACTOR });
    const ok = await setFlag(db, { organizationId: org, key, enabled: true, expectedUpdatedAt: created.updatedAt.toISOString(), actor: ACTOR });
    expect(ok.enabled).toBe(true);
  });
});

describe('alert storm — every raise is accounted for exactly once', () => {
  it('50 concurrent identical raises coalesce; the counts sum to 50', async () => {
    const key = `storm-${crypto.randomUUID().slice(0, 8)}`;
    await Promise.all(Array.from({ length: 50 }, (_, i) => raiseAlert(db, { organizationId: org, severity: 'WARNING', category: 'TORTURE', title: 'storm', dedupeKey: key, body: `raise ${i}` })));
    const rows = await db.select({ count: alerts.count }).from(alerts).where(and(eq(alerts.organizationId, org), eq(alerts.dedupeKey, key), eq(alerts.status, 'OPEN')));
    const total = rows.reduce((n, r) => n + r.count, 0);
    expect(total).toBe(50); // no raise lost, none double-counted
    // Fixed in M10.1: the coalesce is serialized per key, so the storm collapses
    // to exactly ONE alert row even under true concurrency.
    expect(rows.length).toBe(1);
    expect(rows[0]!.count).toBe(50);
  });
  it('50 sequential identical raises collapse to ONE alert with count 50', async () => {
    const key = `storm-seq-${crypto.randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 50; i += 1) await raiseAlert(db, { organizationId: org, severity: 'WARNING', category: 'TORTURE', title: 'seq storm', dedupeKey: key });
    const rows = await db.select({ count: alerts.count }).from(alerts).where(and(eq(alerts.organizationId, org), eq(alerts.dedupeKey, key), eq(alerts.status, 'OPEN')));
    expect(rows.length).toBe(1);
    expect(rows[0]!.count).toBe(50);
    const summary = await alertSummary(db, org);
    expect(typeof summary.WARNING === 'number' || summary.WARNING === undefined).toBe(true);
  });
});

describe('incident storm — grouping holds', () => {
  it('30 concurrent opens on one dedupe key produce a small, grouped set', async () => {
    const key = `outage-${crypto.randomUUID().slice(0, 8)}`;
    const results = await Promise.all(Array.from({ length: 30 }, () => openOrGroupIncident(db, { organizationId: org, title: 'concurrent outage', dedupeKey: key })));
    const distinct = new Set(results.map((r) => r.id));
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(incidents).where(and(eq(incidents.organizationId, org), eq(incidents.dedupeKey, key)));
    // Fixed in M10.1: the check-then-insert is serialized per dedupe key with an
    // advisory lock, so 30 concurrent opens collapse to exactly ONE incident —
    // the "one incident, not hundreds" guarantee now holds under real concurrency.
    expect(distinct.size).toBe(1);
    expect(rows[0]!.n).toBe(1);
  });
  it('50 sequential opens on one dedupe key produce exactly one incident', async () => {
    const key = `outage-seq-${crypto.randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 50; i += 1) await openOrGroupIncident(db, { organizationId: org, title: 'seq outage', dedupeKey: key });
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(incidents).where(and(eq(incidents.organizationId, org), eq(incidents.dedupeKey, key)));
    expect(rows[0]!.n).toBe(1);
  });
});

describe('audit-chain integrity holds under load', () => {
  it('the isolated org audit chain verifies end to end after many writes', async () => {
    // The kill-switch/flag/alert activity above wrote many audit rows for this org.
    const v = await verifyAuditChain(db, org, { limit: 5000 });
    expect(v.ok).toBe(true);
    const report = await runIntegrityChecks(db, org, false);
    const chain = report.checks.find((c) => c.key === 'INV_AUDIT_CHAIN_INTACT');
    expect(chain?.status).toBe('PASS');
    expect(report.ok).toBe(true);
  });
});
