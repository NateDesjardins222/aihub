/**
 * Scale + backlog measurement for the read model and outbox (Phases 11, 14).
 *
 * Measures, against whatever accounts exist in the database:
 *   - projection rebuild-from-authority throughput (accounts/sec);
 *   - account-state read latency from the projection (p50/p95/p99);
 *   - outbox backlog drain throughput and per-event latency;
 *   - reconciliation over the whole set (drift count).
 *
 * It does not fabricate load: it reports the account count it actually found and
 * the numbers it actually measured. Seed load-test fixtures first for 1k/10k.
 *
 *   pnpm --filter @atlas/server exec tsx scripts/loadtest-fixtures.ts --count 10000
 *   pnpm --filter @atlas/server exec tsx scripts/projection-scale.ts --backlog 2000 --reads 500
 */
import { sql } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import { accounts, accountProjections } from '../src/db/schema.js';
import {
  rebuildAllProjections,
  readAccountProjection,
  reconcileAll,
  accountOutboxHandler as handler,
} from '../src/platform/projection.js';
import { enqueueOutbox, OutboxWorker } from '../src/platform/outbox.js';

const URL = process.env['DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas';
const market = { markPrice: () => 20_000, era: () => 'live:yahoo-delayed' };

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

async function main(): Promise<void> {
  const backlog = arg('backlog', 2000);
  const reads = arg('reads', 500);
  const { sql: pg, db } = createDb(URL);
  try {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(accounts);
    console.log(`\n=== projection scale (accounts in DB: ${n}) ===`);

    // 1. Rebuild-from-authority throughput.
    const t0 = Date.now();
    const rebuilt = await rebuildAllProjections(db);
    const rebuildMs = Date.now() - t0;
    console.log(
      `rebuild: ${rebuilt} projections in ${rebuildMs}ms => ${Math.round((rebuilt / rebuildMs) * 1000)} accounts/sec`,
    );

    // 2. Read latency from the projection.
    const ids = (
      await db.select({ id: accountProjections.accountId }).from(accountProjections).limit(reads)
    ).map((r) => r.id);
    const readTimes: number[] = [];
    for (const id of ids) {
      const s = performance.now();
      await readAccountProjection(db, market, id);
      readTimes.push(performance.now() - s);
    }
    if (readTimes.length) {
      console.log(
        `read (${readTimes.length}): p50=${pct(readTimes, 50).toFixed(2)}ms p95=${pct(readTimes, 95).toFixed(2)}ms p99=${pct(readTimes, 99).toFixed(2)}ms`,
      );
    }

    // 3. Outbox backlog drain. Enqueue `backlog` events spread over the accounts.
    const targets = ids.length ? ids : [];
    if (targets.length) {
      for (let i = 0; i < backlog; i += 1) {
        await enqueueOutbox(db, { aggregateId: targets[i % targets.length]!, type: 'account.changed' });
      }
      const worker = new OutboxWorker(db, { handler, batch: 100 });
      const drainStart = Date.now();
      const delivered = await worker.runUntilEmpty();
      const drainMs = Date.now() - drainStart;
      console.log(
        `backlog drain: ${delivered} events in ${drainMs}ms => ${Math.round((delivered / drainMs) * 1000)} events/sec`,
      );
    }

    // 4. Reconciliation over the whole set.
    const rc0 = Date.now();
    const rc = await reconcileAll(db);
    console.log(
      `reconcile: checked ${rc.checked} in ${Date.now() - rc0}ms, drifted ${rc.drifted.length}`,
    );
  } finally {
    await pg.end({ timeout: 5 }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('scale run failed:', err);
  process.exit(1);
});
