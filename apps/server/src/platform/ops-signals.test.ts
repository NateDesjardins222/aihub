/**
 * Operational Readiness Phase 1 — the operational SIGNALS fire and stay safe.
 *
 * These prove the detection surfaces added/hardened this phase actually change
 * state under the condition they exist for, and never mutate authoritative truth:
 *  - outbox oldest-pending AGE is exposed (a stall is detectable, not just a count);
 *  - outbox health is DEGRADED on a stalled backlog or a dead-letter, read-only;
 *  - System Doctor carries a first-class `outbox` probe;
 *  - the console integrity suite surfaces the RES-P2-1 failed-payout-reversal
 *    invariant (previously CLI-only).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { outboxEvents } from '../db/schema.js';
import { createFixture, type TestFixture } from '../trading/harness.js';
import { OutboxWorker, enqueueOutbox, outboxHealth, outboxStats } from './outbox.js';
import { runSystemDoctor } from './system-doctor.js';
import { runIntegrityChecks } from './integrity.js';
import { defaultOrganizationId } from './provisioning.js';

const agg = (): string => randomUUID();

describe('outbox oldest-pending age + health (stall detection)', () => {
  let fixture: TestFixture;
  beforeEach(async () => {
    fixture = await createFixture();
  });
  afterEach(async () => {
    await fixture?.close();
  });

  it('exposes oldestPendingAgeMs: null when empty, a non-negative number when pending', async () => {
    const id = agg();
    const empty = await outboxStats(fixture.db, id);
    expect(empty.pending).toBe(0);
    expect(empty.oldestPendingAgeMs).toBeNull();

    await enqueueOutbox(fixture.db, { aggregateId: id, type: 'account.changed' });
    const pending = await outboxStats(fixture.db, id);
    expect(pending.pending).toBe(1);
    expect(pending.oldestPendingAgeMs).not.toBeNull();
    expect(pending.oldestPendingAgeMs!).toBeGreaterThanOrEqual(0);
  });

  it('health is HEALTHY for a fresh pending row and clears to null after draining', async () => {
    const id = agg();
    await enqueueOutbox(fixture.db, { aggregateId: id, type: 'account.changed' });
    const fresh = await outboxHealth(fixture.db, { aggregateId: id });
    expect(fresh.state).toBe('HEALTHY');

    const worker = new OutboxWorker(fixture.db, { aggregateId: id, handler: async () => {}, batch: 10 });
    await worker.runUntilEmpty();
    const drained = await outboxHealth(fixture.db, { aggregateId: id });
    expect(drained.pending).toBe(0);
    expect(drained.oldestPendingAgeMs).toBeNull();
    expect(drained.state).toBe('HEALTHY');
  });

  it('DEGRADES on a stalled backlog (oldest pending older than threshold) — read-only, event untouched', async () => {
    const id = agg();
    await enqueueOutbox(fixture.db, { aggregateId: id, type: 'account.changed' });
    // Age the pending row past the stall threshold WITHOUT delivering it.
    await fixture.db
      .update(outboxEvents)
      .set({ createdAt: new Date(Date.now() - 5 * 60 * 1000) })
      .where(eq(outboxEvents.aggregateId, id));

    const health = await outboxHealth(fixture.db, { aggregateId: id, stallThresholdMs: 60_000 });
    expect(health.state).toBe('DEGRADED');
    expect(health.reason).toMatch(/stall/i);

    // Detection is read-only: the event is still pending, not deleted, not acked.
    const [row] = await fixture.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, id));
    expect(row).toBeTruthy();
    expect(row!.deliveredAt).toBeNull();
    expect(row!.deadLetter).toBe(false);
  });

  it('DEGRADES on a dead-lettered (poisoned) event', async () => {
    const id = agg();
    await enqueueOutbox(fixture.db, { aggregateId: id, type: 'account.changed' });
    const worker = new OutboxWorker(fixture.db, {
      aggregateId: id,
      handler: async () => {
        throw new Error('poison');
      },
      maxAttempts: 1,
      backoffBaseMs: 0,
      backoffCapMs: 0,
    });
    await worker.tick();
    const health = await outboxHealth(fixture.db, { aggregateId: id });
    expect(health.deadLetter).toBeGreaterThan(0);
    expect(health.state).toBe('DEGRADED');
    expect(health.reason).toMatch(/dead-lettered/i);
  });
});

describe('System Doctor carries an outbox probe', () => {
  let fixture: TestFixture;
  beforeEach(async () => {
    fixture = await createFixture();
  });
  afterEach(async () => {
    await fixture?.close();
  });

  it('includes an `outbox` check in the doctor report', async () => {
    const orgId = await defaultOrganizationId(fixture.db);
    const report = await runSystemDoctor(fixture.db, orgId, false);
    const outbox = report.checks.find((c) => c.key === 'outbox');
    expect(outbox).toBeTruthy();
    expect(outbox!.detail).toHaveProperty('oldestPendingAgeMs');
    expect(outbox!.detail).toHaveProperty('deadLetter');
  });
});

describe('console integrity suite surfaces RES-P2-1 (failed-payout reversal)', () => {
  let fixture: TestFixture;
  beforeEach(async () => {
    fixture = await createFixture();
  });
  afterEach(async () => {
    await fixture?.close();
  });

  it('runIntegrityChecks includes INV_FAILED_PAYOUT_DEBIT_REVERSED and it PASSES on a clean DB', async () => {
    const orgId = await defaultOrganizationId(fixture.db);
    const report = await runIntegrityChecks(fixture.db, orgId, false);
    const check = report.checks.find((c) => c.key === 'INV_FAILED_PAYOUT_DEBIT_REVERSED');
    expect(check).toBeTruthy();
    expect(check!.status).toBe('PASS');
  });
});
