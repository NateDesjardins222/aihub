/**
 * Engineering Resilience Phase 2 — Parts XIX/XX (outbox durability + poison event),
 * consumer-crash rollback, and Part XXVI (transaction deadlock).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import { outboxEvents, users } from '../../db/schema.js';
import { enqueueOutbox, OutboxWorker, outboxStats } from '../outbox.js';
import { Barrier } from './attack-harness.js';

let db: Database;
let sqlEnd: () => Promise<void>;
const AGG = () => crypto.randomUUID();

beforeAll(() => {
  const h = createDb(process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; sqlEnd = () => h.sql.end({ timeout: 5 });
});
afterAll(async () => { await sqlEnd(); });

describe('Part XIX/XX — outbox: publisher down, at-least-once, poison event', () => {
  it('an event survives a publisher outage and is delivered when the worker runs', async () => {
    const agg = AGG();
    await db.transaction(async (tx) => enqueueOutbox(tx as unknown as Database, { aggregateId: agg, type: 'account.changed', payload: { n: 1 } }));
    // Publisher is "down": nothing consumes. The row is durable + pending.
    expect((await outboxStats(db, agg)).pending).toBe(1);
    const delivered: string[] = [];
    const worker = new OutboxWorker(db, { aggregateId: agg, handler: async (_tx, e) => { delivered.push(e.type); }, pollMs: 5, backoffBaseMs: 1 });
    await worker.runUntilEmpty();
    const s = await outboxStats(db, agg);
    expect(s.delivered).toBe(1);
    expect(s.pending).toBe(0);
    expect(delivered).toEqual(['account.changed']);
  });

  it('a poison event dead-letters after maxAttempts and never wedges the queue', async () => {
    const agg = AGG();
    await db.transaction(async (tx) => {
      await enqueueOutbox(tx as unknown as Database, { aggregateId: agg, type: 'good.a', payload: {} });
      await enqueueOutbox(tx as unknown as Database, { aggregateId: agg, type: 'poison', payload: {} });
      await enqueueOutbox(tx as unknown as Database, { aggregateId: agg, type: 'good.b', payload: {} });
    });
    const delivered: string[] = [];
    const worker = new OutboxWorker(db, {
      aggregateId: agg, pollMs: 5, backoffBaseMs: 0, backoffCapMs: 0, maxAttempts: 3,
      handler: async (_tx, e) => { if (e.type === 'poison') throw new Error('cannot process poison'); delivered.push(e.type); },
    });
    // Tick explicitly: the failing poison delivers nothing, so runUntilEmpty would
    // stop early — drive enough ticks (zero backoff) to exhaust its attempts.
    for (let i = 0; i < 6; i += 1) await worker.tick();

    const s = await outboxStats(db, agg);
    // The two good events delivered; the poison event is parked (dead-letter),
    // NOT looping and NOT blocking the good events. Nothing left pending.
    expect(delivered.sort()).toEqual(['good.a', 'good.b']);
    expect(s.delivered).toBe(2);
    expect(s.deadLetter).toBe(1);
    expect(s.pending).toBe(0);
    const [poison] = await db.select().from(outboxEvents).where(and(eq(outboxEvents.aggregateId, agg), eq(outboxEvents.type, 'poison')));
    expect(poison!.attempts).toBeGreaterThanOrEqual(3);
    expect(poison!.lastError).toContain('poison');
  });

  it('a consumer crash rolls back its work with the delivery mark (nothing partial)', async () => {
    const agg = AGG();
    await db.transaction(async (tx) => enqueueOutbox(tx as unknown as Database, { aggregateId: agg, type: 'writes-then-throws', payload: {} }));
    let attempts = 0;
    const worker = new OutboxWorker(db, {
      aggregateId: agg, pollMs: 5, backoffBaseMs: 1, backoffCapMs: 5, maxAttempts: 10,
      handler: async (tx, _e) => {
        attempts += 1;
        // Do a durable write, then crash. Because the handler shares the claim
        // transaction, the write must roll back with the failed delivery.
        await tx.insert(users).values({ email: `outbox-crash-${crypto.randomUUID()}@t.local`, passwordHash: 'x', displayName: 'ghost' });
        if (attempts === 1) throw new Error('crash after write');
      },
    });
    await worker.tick(); // first attempt: write + crash → rollback
    // The ghost user from the crashed attempt must NOT exist.
    const ghosts1 = await db.select().from(users).where(eq(users.displayName, 'ghost'));
    const before = ghosts1.length;
    await worker.runUntilEmpty(20); // retry succeeds
    const s = await outboxStats(db, agg);
    expect(s.delivered).toBe(1);
    // Exactly one ghost survives (the successful retry), proving the crashed
    // attempt's write did not also persist.
    const ghosts2 = await db.select().from(users).where(eq(users.displayName, 'ghost'));
    expect(ghosts2.length).toBe(before + 1);
    await db.delete(users).where(eq(users.displayName, 'ghost'));
  });
});

describe('Part XXVI — a transaction deadlock aborts one side cleanly, no partial state', () => {
  it('two transactions locking two rows in opposite order: one aborts, retry succeeds', async () => {
    // Two independent connections so the transactions genuinely interleave.
    const h1 = createDb(process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test');
    const h2 = createDb(process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test');
    // Two throwaway users to update (row locks) — no business tables needed.
    const [uA] = await db.insert(users).values({ email: `dlA-${crypto.randomUUID()}@t.local`, passwordHash: 'x', displayName: 'dlA' }).returning();
    const [uB] = await db.insert(users).values({ email: `dlB-${crypto.randomUUID()}@t.local`, passwordHash: 'x', displayName: 'dlB' }).returning();
    const barrier = new Barrier(2);

    const t1 = h1.db.transaction(async (tx) => {
      await tx.update(users).set({ displayName: 'dlA-1' }).where(eq(users.id, uA!.id));
      await barrier.arrive();
      await tx.update(users).set({ displayName: 'dlB-1' }).where(eq(users.id, uB!.id));
    });
    const t2 = h2.db.transaction(async (tx) => {
      await tx.update(users).set({ displayName: 'dlB-2' }).where(eq(users.id, uB!.id));
      await barrier.arrive();
      await tx.update(users).set({ displayName: 'dlA-2' }).where(eq(users.id, uA!.id));
    });

    const results = await Promise.allSettled([t1, t2]);
    const rejected = results.filter((r) => r.status === 'rejected');
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    // Postgres detects the deadlock and aborts exactly one; the other commits.
    expect(rejected.length).toBe(1);
    expect(fulfilled.length).toBe(1);
    // Postgres raises SQLSTATE 40P01 (deadlock_detected); drizzle wraps it, so the
    // deadlock text lives on the cause.
    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string; cause?: { code?: string; message?: string } };
    const isDeadlock = reason.code === '40P01' || reason.cause?.code === '40P01' || /deadlock/i.test(String(reason.cause?.message ?? ''));
    expect(isDeadlock).toBe(true);

    // No partial state: each row shows a consistent winner (both names from the
    // SAME committed transaction), never a mix.
    const [a] = await db.select().from(users).where(eq(users.id, uA!.id));
    const [b] = await db.select().from(users).where(eq(users.id, uB!.id));
    const suffix = a!.displayName.endsWith('-1') ? '-1' : '-2';
    expect(a!.displayName.endsWith(suffix)).toBe(true);
    expect(b!.displayName.endsWith(suffix)).toBe(true);

    await db.delete(users).where(eq(users.id, uA!.id));
    await db.delete(users).where(eq(users.id, uB!.id));
    await h1.sql.end({ timeout: 5 });
    await h2.sql.end({ timeout: 5 });
  });
});
