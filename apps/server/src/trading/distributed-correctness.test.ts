/**
 * Distributed correctness: the same account, contended from independent
 * database connections.
 *
 * A PostgreSQL advisory lock is held by a SESSION — a connection — not by a
 * process. Two independent connections contend on it exactly as two independent
 * OS processes would; Postgres cannot tell the difference. So these tests open
 * their own pools and treat each as a separate "worker". Where a claim would
 * differ for real separate processes, the test says so.
 *
 * What is proven here:
 *   - the advisory lock serializes a critical section across independent
 *     connections (no lost update), and lets different accounts run concurrently;
 *   - the lock is released even when the guarded work throws;
 *   - concurrent operator transitions on one account do not both succeed
 *     (no double transition, no lost update), because the transition re-reads
 *     the status FOR UPDATE under the same lock.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { createFixture } from './harness.js';
import { withAccountAdvisoryLock, advisoryObjId } from './account-lock.js';
import { lockAccount, AccountActionError } from '../platform/account-service.js';
import { createDb } from '../db/client.js';
import { accounts } from '../db/schema.js';

const URL = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';

/** An independent connection — a separate "worker" for locking purposes. */
function worker(): postgres.Sql {
  return postgres(URL, { max: 4, idle_timeout: 10, onnotice: () => {} });
}

const pools: postgres.Sql[] = [];
function trackedWorker(): postgres.Sql {
  const p = worker();
  pools.push(p);
  return p;
}

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end({ timeout: 5 }).catch(() => undefined)));
});

describe('the account advisory lock', () => {
  it('serializes a critical section across two independent connections (no lost update)', async () => {
    const a = trackedWorker();
    const b = trackedWorker();
    const accountId = 'acct-lost-update-test';

    // A deliberately racy read-modify-write on a shared JS value with an await
    // in the middle. Without mutual exclusion both workers read 0 and write 1,
    // losing an update; with it, the result is exactly 2.
    let shared = 0;
    const bump = async (): Promise<void> => {
      const seen = shared;
      await new Promise((r) => setTimeout(r, 25));
      shared = seen + 1;
    };

    await Promise.all([
      withAccountAdvisoryLock(a, accountId, bump),
      withAccountAdvisoryLock(b, accountId, bump),
    ]);

    expect(shared).toBe(2);
  });

  it('lets different accounts run concurrently (the lock is per account, not global)', async () => {
    const a = trackedWorker();
    const b = trackedWorker();
    let insideAtOnce = 0;
    let maxConcurrent = 0;
    const work = async (): Promise<void> => {
      insideAtOnce += 1;
      maxConcurrent = Math.max(maxConcurrent, insideAtOnce);
      await new Promise((r) => setTimeout(r, 40));
      insideAtOnce -= 1;
    };

    await Promise.all([
      withAccountAdvisoryLock(a, 'acct-A', work),
      withAccountAdvisoryLock(b, 'acct-B', work),
    ]);

    // Two different accounts overlapped: the lock did not serialize unrelated work.
    expect(maxConcurrent).toBe(2);
  });

  it('releases the lock when the guarded work throws', async () => {
    const a = trackedWorker();
    const b = trackedWorker();
    const accountId = 'acct-throw-test';

    await expect(
      withAccountAdvisoryLock(a, accountId, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // A second acquisition must not hang: the failed one released the lock.
    let ran = false;
    await withAccountAdvisoryLock(b, accountId, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('derives a stable, non-negative object id from an account id', () => {
    const id = 'a8f1310d-b89b-4845-80a0-c82acb852427';
    expect(advisoryObjId(id)).toBe(advisoryObjId(id));
    expect(advisoryObjId(id)).toBeGreaterThanOrEqual(0);
    expect(advisoryObjId(id)).toBeLessThanOrEqual(0x7fffffff);
    expect(advisoryObjId('other')).not.toBe(advisoryObjId(id));
  });
});

describe('concurrent operator transitions on one account', () => {
  it('lets exactly one of many simultaneous holds win', async () => {
    const fixture = await createFixture({ status: 'ACTIVE' });
    try {
      // Five independent workers (independent connections) all try to hold the
      // same ACTIVE account at once.
      const workers = Array.from({ length: 5 }, () => createDb(URL));
      const actor = { type: 'ADMIN' as const, userId: fixture.userId, label: 'op', ip: null };

      const results = await Promise.allSettled(
        workers.map((w) => lockAccount(w.db, fixture.accountId, actor, 'concurrent hold')),
      );
      await Promise.all(workers.map((w) => w.sql.end({ timeout: 5 }).catch(() => undefined)));

      const won = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter(
        (r) => r.status === 'rejected' && r.reason instanceof AccountActionError,
      );

      // Exactly one transition ACTIVE -> LOCKED committed; the rest saw the
      // committed LOCKED state (re-read FOR UPDATE) and were refused as an
      // invalid transition. No lost update, no double transition.
      expect(won).toHaveLength(1);
      expect(refused).toHaveLength(4);

      // And the account is LOCKED.
      const [row] = await fixture.db
        .select()
        .from(accounts)
        .where(eq(accounts.id, fixture.accountId));
      expect(row!.status).toBe('LOCKED');
    } finally {
      await fixture.close();
    }
  });
});
