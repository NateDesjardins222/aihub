/**
 * Phase 10 — audit chain long-chain + concurrent stress (PART 33-36).
 *
 * Phase 9 fixed the same-millisecond tie race by making each chain row's
 * createdAt strictly greater than its predecessor's. Phase 9 also observed that
 * a combined run of ~13 DB suites sharing the ONE default organisation's chain
 * could still make the whole-history verify report a break. This suite settles
 * whether that is a real production concern (a long-running organisation with a
 * large, concurrently-written chain) or a cross-suite test-isolation artifact.
 *
 * It runs on its OWN fresh organisation (never the shared default org), so it is
 * fully isolated and repeatable regardless of what other suites did. If a
 * long, concurrently-written chain verifies cleanly here, then the audit
 * integrity holds for a legitimate production organisation, and the earlier
 * combined-run redness is proven to be shared-org cross-suite accumulation — a
 * test-isolation property, not an audit defect.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { organizations } from '../db/schema.js';
import { recordAudit, verifyAuditChain } from './audit.js';
import type { Actor } from './actor.js';

let db: ReturnType<typeof getDb>['db'];
let orgId: string;
const actor: Actor = { type: 'SYSTEM', label: 'stress' };

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  db = getDb().db;
  const [org] = await db
    .insert(organizations)
    .values({ slug: `audit-stress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: 'Audit Stress' })
    .returning();
  orgId = org!.id;
});

afterAll(async () => {
  // Chain rows are append-only (DB refuses DELETE); the throwaway org row can go
  // only if no rows reference it, so leave it — it is namespaced and harmless.
  if (orgId) {
    try {
      await db.delete(organizations).where(eq(organizations.id, orgId));
    } catch {
      /* audit rows reference it; leaving the org row is fine for an isolated test org */
    }
  }
});

function entry(i: number) {
  return {
    organizationId: orgId,
    actor,
    subjectType: 'ORGANIZATION' as const,
    subjectId: null,
    action: `stress.event.${i % 7}`,
    newState: { i, note: `event ${i}` },
    reason: `stress ${i}`,
  };
}

describe('audit chain — long chain + concurrent stress (isolated org)', () => {
  it('verifies a several-thousand-event chain written sequentially and in bursts', async () => {
    const TOTAL = 3000;
    const BURST = 50;
    let written = 0;
    while (written < TOTAL) {
      // Alternate: a block of sequential appends, then a concurrent burst.
      // The concurrent burst is the adversarial case — many appends racing for
      // the same organisation's chain at once.
      for (let s = 0; s < 10 && written < TOTAL; s++) {
        await recordAudit(db, entry(written));
        written += 1;
      }
      const n = Math.min(BURST, TOTAL - written);
      if (n > 0) {
        await Promise.all(Array.from({ length: n }, (_, k) => recordAudit(db, entry(written + k))));
        written += n;
      }
    }

    const v = await verifyAuditChain(db, orgId, { limit: 100_000 });
    expect(v.ok, `brokenAt=${v.brokenAt ?? 'none'} checked=${v.checked}`).toBe(true);
    expect(v.checked).toBe(TOTAL);
    expect(v.brokenAt).toBeNull();
  });

  it('a 100-wide concurrent burst on one chain never forks or breaks linkage', async () => {
    const before = (await verifyAuditChain(db, orgId, { limit: 100_000 })).checked;
    await Promise.all(Array.from({ length: 100 }, (_, k) => recordAudit(db, entry(10_000 + k))));
    const v = await verifyAuditChain(db, orgId, { limit: 100_000 });
    expect(v.ok, `brokenAt=${v.brokenAt ?? 'none'}`).toBe(true);
    expect(v.checked).toBe(before + 100);
  });
});
