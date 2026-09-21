/**
 * The read model, the outbox delivery worker, and reconciliation.
 *
 * These attack the failure modes: duplicate delivery, stale recompute, worker
 * contention, handler failure/backoff/dead-letter, and projection drift. The
 * projection recomputes from authority, so the central claim under test is that
 * no delivery pattern corrupts it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { accountProjections, accounts, outboxEvents } from '../db/schema.js';
import { TradingEngine } from '../trading/engine.js';
import { ScriptedMarket, createFixture, settle, type TestFixture } from '../trading/harness.js';
import {
  accountOutboxHandler,
  projectAccount,
  readAccountProjection,
  reconcileAccountProjection,
  rebuildAllProjections,
  valueProjection,
} from './projection.js';
import { OutboxWorker, enqueueOutbox, outboxStats } from './outbox.js';

describe('the account projection', () => {
  let fixture: TestFixture;
  let market: ScriptedMarket;
  let engine: TradingEngine;

  beforeEach(async () => {
    fixture = await createFixture();
    market = new ScriptedMarket();
    engine = new TradingEngine(fixture.db, market);
    await engine.start();
    await market.quote('NQ', 20_000);
  });

  afterEach(async () => {
    engine?.stop();
    await fixture?.close();
  });

  it('recomputes an account snapshot from authority, idempotently', async () => {
    const a = await projectAccount(fixture.db, fixture.accountId);
    const b = await projectAccount(fixture.db, fixture.accountId);
    expect(a).not.toBeNull();
    expect(b!.balanceMicros).toBe(a!.balanceMicros);
    expect(b!.stateVersion).toBe(a!.stateVersion);
    // The projection matches the account row.
    const [acct] = await fixture.db.select().from(accounts).where(eq(accounts.id, fixture.accountId));
    expect(a!.balanceMicros).toBe(acct!.balanceMicros);
    expect(a!.status).toBe(acct!.status);
  });

  it('reflects a fill after the outbox is drained', async () => {
    await engine.submitOrder({
      accountId: fixture.accountId,
      userId: fixture.userId,
      clientOrderId: `p-${Date.now()}`,
      symbol: 'NQ',
      side: 'BUY',
      qty: 2,
      type: 'MARKET',
    });
    await settle(300);

    // A fill enqueued an outbox row; drain it into the projection.
    const worker = new OutboxWorker(fixture.db, {
      aggregateId: fixture.accountId,
      handler: accountOutboxHandler,
    });
    const delivered = await worker.runUntilEmpty();
    expect(delivered).toBeGreaterThan(0);

    // Value it with the same market the position was opened against (matching era).
    const valued = await readAccountProjection(fixture.db, market, fixture.accountId);
    expect(valued).not.toBeNull();
    expect(valued!.openContracts).toBe(2);
    // Equity is balance + unrealized, applied from the live mark - not stored.
    expect(valued!.equityMicros).not.toBeNull();
  });

  it('does not roll the stored version backward on a stale recompute', async () => {
    await projectAccount(fixture.db, fixture.accountId);
    // Force the stored projection to a higher version than the account.
    await fixture.db
      .update(accountProjections)
      .set({ stateVersion: 999_999, balanceMicros: 12345 })
      .where(eq(accountProjections.accountId, fixture.accountId));
    // A recompute at the (lower) authoritative seq must not overwrite it.
    await projectAccount(fixture.db, fixture.accountId);
    const [row] = await fixture.db
      .select()
      .from(accountProjections)
      .where(eq(accountProjections.accountId, fixture.accountId));
    expect(row!.stateVersion).toBe(999_999);
    expect(row!.balanceMicros).toBe(12345);
  });

  it('values the projection identically to the engine (owner == trader truth)', async () => {
    await engine.submitOrder({
      accountId: fixture.accountId,
      userId: fixture.userId,
      clientOrderId: `same-${Date.now()}`,
      symbol: 'NQ',
      side: 'BUY',
      qty: 3,
      type: 'MARKET',
    });
    await settle(300);
    // Move the mark so unrealized is non-trivial.
    await market.quote('NQ', 20_050);
    await projectAccount(fixture.db, fixture.accountId);

    const fromEngine = await engine.valuation(fixture.accountId);
    const fromProjection = await readAccountProjection(fixture.db, market, fixture.accountId);
    expect(fromEngine).not.toBeNull();
    expect(fromProjection).not.toBeNull();
    // The read model, valued with the same marks, agrees with the authoritative
    // engine valuation to the micro-dollar.
    expect(fromProjection!.equityMicros).toBe(fromEngine!.equityMicros);
    expect(fromProjection!.unrealizedPnlMicros).toBe(fromEngine!.openPnlMicros);
    expect(fromProjection!.remainingLossMicros).toBe(fromEngine!.remainingDrawdownMicros);
    expect(fromProjection!.openContracts).toBe(fromEngine!.openContracts);
    expect(fromProjection!.balanceMicros).toBe(fromEngine!.balanceMicros);
  });

  it('keeps unrealized P&L unknown, never zero, when a position cannot be marked', async () => {
    await engine.submitOrder({
      accountId: fixture.accountId,
      userId: fixture.userId,
      clientOrderId: `u-${Date.now()}`,
      symbol: 'NQ',
      side: 'BUY',
      qty: 1,
      type: 'MARKET',
    });
    await settle(300);
    await projectAccount(fixture.db, fixture.accountId);
    const [row] = await fixture.db
      .select()
      .from(accountProjections)
      .where(eq(accountProjections.accountId, fixture.accountId));
    // A market that returns no price -> equity unknown, not a fabricated zero.
    const valued = valueProjection(row!, { markPrice: () => null, era: () => 'x' });
    expect(valued.unrealizedPnlMicros).toBeNull();
    expect(valued.equityMicros).toBeNull();
  });
});

describe('reconciliation', () => {
  let fixture: TestFixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });
  afterEach(async () => {
    await fixture?.close();
  });

  it('detects a corrupted projection and rebuild repairs it', async () => {
    await projectAccount(fixture.db, fixture.accountId);
    expect((await reconcileAccountProjection(fixture.db, fixture.accountId)).ok).toBe(true);

    // Corrupt the balance and the version.
    await fixture.db
      .update(accountProjections)
      .set({ balanceMicros: 1, stateVersion: 0 })
      .where(eq(accountProjections.accountId, fixture.accountId));

    const bad = await reconcileAccountProjection(fixture.db, fixture.accountId);
    expect(bad.ok).toBe(false);
    expect(bad.diffs.some((d) => d.field === 'balanceMicros')).toBe(true);

    // Rebuild from authority (touches no financial truth) fixes it.
    await rebuildAllProjections(fixture.db, { organizationId: undefined });
    expect((await reconcileAccountProjection(fixture.db, fixture.accountId)).ok).toBe(true);
  });

  it('reports a missing projection as drift', async () => {
    const r = await reconcileAccountProjection(fixture.db, fixture.accountId);
    expect(r.ok).toBe(false);
    expect(r.missing).toBe(true);
  });
});

describe('the outbox delivery worker', () => {
  // The outbox is a global table shared by every test on this database, so each
  // test scopes its worker and stats to a unique aggregate id of its own.
  let fixture: TestFixture;
  const agg = () => crypto.randomUUID();

  beforeEach(async () => {
    fixture = await createFixture();
  });
  afterEach(async () => {
    await fixture?.close();
  });

  it('drains a backlog and marks it delivered exactly once', async () => {
    const id = agg();
    let handled = 0;
    for (let i = 0; i < 25; i += 1) {
      await enqueueOutbox(fixture.db, { aggregateId: id, type: 'account.changed' });
    }
    const worker = new OutboxWorker(fixture.db, {
      aggregateId: id,
      handler: async () => {
        handled += 1;
      },
      batch: 10,
    });
    await worker.runUntilEmpty();
    expect(handled).toBe(25);
    const stats = await outboxStats(fixture.db, id);
    expect(stats.pending).toBe(0);
    expect(stats.delivered).toBe(25);
  });

  it('never lets two workers process the same event (SKIP LOCKED)', async () => {
    const id = agg();
    const seen = new Map<string, number>();
    for (let i = 0; i < 40; i += 1) {
      await enqueueOutbox(fixture.db, { aggregateId: id, type: 'account.changed' });
    }
    const make = () =>
      new OutboxWorker(fixture.db, {
        aggregateId: id,
        handler: async (_tx, e) => {
          seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
        },
        batch: 7,
      });
    const w1 = make();
    const w2 = make();
    for (let i = 0; i < 20; i += 1) {
      await Promise.all([w1.tick(), w2.tick()]);
    }
    const stats = await outboxStats(fixture.db, id);
    expect(stats.pending).toBe(0);
    expect(stats.delivered).toBe(40);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(seen.size).toBe(40);
  });

  it('backs off a failing handler and dead-letters after max attempts', async () => {
    const id = agg();
    await enqueueOutbox(fixture.db, { aggregateId: id, type: 'account.changed' });
    const worker = new OutboxWorker(fixture.db, {
      aggregateId: id,
      handler: async () => {
        throw new Error('handler boom');
      },
      maxAttempts: 3,
      backoffBaseMs: 0,
      backoffCapMs: 0,
    });
    await worker.tick();
    await worker.tick();
    await worker.tick();
    const [row] = await fixture.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, id));
    expect(row!.attempts).toBe(3);
    expect(row!.deadLetter).toBe(true);
    expect(row!.lastError).toContain('boom');
    const stats = await outboxStats(fixture.db, id);
    expect(stats.deadLetter).toBe(1);
    expect(stats.pending).toBe(0);
  });

  it('is harmless to redeliver the same event to the projection consumer', async () => {
    await enqueueOutbox(fixture.db, { aggregateId: fixture.accountId, type: 'account.changed' });
    await enqueueOutbox(fixture.db, { aggregateId: fixture.accountId, type: 'account.changed' });
    const worker = new OutboxWorker(fixture.db, {
      aggregateId: fixture.accountId,
      handler: accountOutboxHandler,
    });
    await worker.runUntilEmpty();
    const r = await reconcileAccountProjection(fixture.db, fixture.accountId);
    expect(r.ok).toBe(true);
  });
});
