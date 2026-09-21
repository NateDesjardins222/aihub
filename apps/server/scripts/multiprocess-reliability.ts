/**
 * Real multi-process reliability proof.
 *
 * The V2 milestone's concurrency proof used independent connections in ONE
 * process. This spawns actual separate OS processes against one PostgreSQL and
 * proves, across real process boundaries:
 *
 *   1. FOR UPDATE SKIP LOCKED: many worker processes drain one outbox and no
 *      event is processed twice, none is lost.
 *   2. Crash recovery: a worker killed (SIGKILL) mid-batch loses no event - its
 *      claim's transaction rolls back, the rows unlock, another worker finishes.
 *   3. The account advisory lock serializes a critical section across processes
 *      (no lost update), exactly as it must for two API instances.
 *
 * Run: pnpm --filter @atlas/server exec tsx scripts/multiprocess-reliability.ts
 * Roles are dispatched by --role; the default (parent) orchestrates children.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import { outboxEvents } from '../src/db/schema.js';
import { enqueueOutbox, OutboxWorker, outboxStats } from '../src/platform/outbox.js';
import { withAccountAdvisoryLock } from '../src/trading/account-lock.js';
import { sql } from 'drizzle-orm';

const URL = process.env['DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas';
const SELF = fileURLToPath(import.meta.url);

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : null;
}

async function ensureScratch(db: ReturnType<typeof createDb>['db']): Promise<void> {
  await db.execute(sql`create table if not exists mp_processed (event_id uuid primary key, worker_pid int not null, at timestamptz not null default now())`);
  await db.execute(sql`create table if not exists mp_counter (id text primary key, value int not null)`);
}

// ---- child roles ----------------------------------------------------------

async function runWorker(): Promise<void> {
  const aggregateId = arg('agg')!;
  const slowMs = Number(arg('slow') ?? '0');
  const { sql: pg, db } = createDb(URL);
  const worker = new OutboxWorker(db, {
    aggregateId,
    batch: 5,
    handler: async (tx, event) => {
      if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
      // Unique insert: a second processing of one event would violate the PK,
      // so this table is the cross-process "delivered exactly once" ledger.
      await tx.execute(
        sql`insert into mp_processed (event_id, worker_pid) values (${event.id}, ${process.pid})`,
      );
    },
  });
  try {
    await worker.runUntilEmpty();
  } finally {
    await pg.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function runLocker(): Promise<void> {
  const accountId = arg('account')!;
  const iterations = Number(arg('iters') ?? '50');
  const { sql: pg } = createDb(URL);
  try {
    for (let i = 0; i < iterations; i += 1) {
      await withAccountAdvisoryLock(pg, accountId, async () => {
        // Racy read-modify-write on a shared row; the lock must serialize it
        // across processes or updates are lost.
        const rows = await pg`select value from mp_counter where id = ${accountId}`;
        const current = Number(rows[0]?.['value'] ?? 0);
        await new Promise((r) => setTimeout(r, 1));
        await pg`update mp_counter set value = ${current + 1} where id = ${accountId}`;
      });
    }
  } finally {
    await pg.end({ timeout: 5 }).catch(() => undefined);
  }
}

// ---- parent orchestrator --------------------------------------------------

function child(args: string[], opts: { killAfterMs?: number } = {}): Promise<number | 'killed'> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', SELF, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    let killed = false;
    if (opts.killAfterMs) {
      setTimeout(() => {
        killed = true;
        proc.kill('SIGKILL');
      }, opts.killAfterMs);
    }
    proc.on('exit', (code) => resolve(killed ? 'killed' : (code ?? -1)));
    proc.on('error', reject);
  });
}

async function main(): Promise<void> {
  const role = arg('role') ?? 'parent';
  if (role === 'worker') return runWorker();
  if (role === 'locker') return runLocker();

  const { sql: pg, db } = createDb(URL);
  let ok = true;
  try {
    await ensureScratch(db);
    const results: string[] = [];

    // -- 1. SKIP LOCKED across real processes -------------------------------
    {
      const agg = randomUUID();
      const N = 200;
      for (let i = 0; i < N; i += 1) {
        await enqueueOutbox(db, { aggregateId: agg, type: 'mp.test' });
      }
      const t0 = Date.now();
      await Promise.all([
        child(['--role', 'worker', '--agg', agg]),
        child(['--role', 'worker', '--agg', agg]),
        child(['--role', 'worker', '--agg', agg]),
        child(['--role', 'worker', '--agg', agg]),
      ]);
      const ms = Date.now() - t0;
      const processed = await pg`select count(*)::int as n from mp_processed p
        join outbox_events o on o.id = p.event_id where o.aggregate_id = ${agg}`;
      const distinct = await pg`select count(distinct event_id)::int as n from mp_processed p
        join outbox_events o on o.id = p.event_id where o.aggregate_id = ${agg}`;
      const stats = await outboxStats(db, agg);
      const pass = Number(processed[0]!['n']) === N && Number(distinct[0]!['n']) === N && stats.pending === 0;
      ok &&= pass;
      results.push(
        `[1] SKIP LOCKED 4 processes / ${N} events: processed=${processed[0]!['n']} distinct=${distinct[0]!['n']} pending=${stats.pending} in ${ms}ms => ${pass ? 'PASS' : 'FAIL'}`,
      );
    }

    // -- 2. Crash recovery: kill a worker mid-drain -------------------------
    {
      const agg = randomUUID();
      const N = 120;
      for (let i = 0; i < N; i += 1) {
        await enqueueOutbox(db, { aggregateId: agg, type: 'mp.test' });
      }
      // A slow worker we SIGKILL mid-batch, plus a healthy worker.
      const killed = child(['--role', 'worker', '--agg', agg, '--slow', '40'], { killAfterMs: 500 });
      const healthy = child(['--role', 'worker', '--agg', agg, '--slow', '5']);
      const [killResult] = await Promise.all([killed, healthy]);
      // Drain any rows the killed worker had claimed (its tx rolled back, so
      // they are available again) with a final healthy worker.
      await child(['--role', 'worker', '--agg', agg, '--slow', '0']);
      const distinct = await pg`select count(distinct event_id)::int as n from mp_processed p
        join outbox_events o on o.id = p.event_id where o.aggregate_id = ${agg}`;
      const stats = await outboxStats(db, agg);
      const pass = killResult === 'killed' && Number(distinct[0]!['n']) === N && stats.pending === 0;
      ok &&= pass;
      results.push(
        `[2] crash recovery (SIGKILL mid-drain): killed=${killResult === 'killed'} distinct=${distinct[0]!['n']}/${N} pending=${stats.pending} => ${pass ? 'PASS' : 'FAIL'}`,
      );
    }

    // -- 3. Advisory lock across real processes -----------------------------
    {
      const account = randomUUID();
      await pg`insert into mp_counter (id, value) values (${account}, 0)
        on conflict (id) do update set value = 0`;
      const iters = 50;
      await Promise.all([
        child(['--role', 'locker', '--account', account, '--iters', String(iters)]),
        child(['--role', 'locker', '--account', account, '--iters', String(iters)]),
        child(['--role', 'locker', '--account', account, '--iters', String(iters)]),
      ]);
      const rows = await pg`select value from mp_counter where id = ${account}`;
      const value = Number(rows[0]!['value']);
      const expected = iters * 3;
      const pass = value === expected;
      ok &&= pass;
      results.push(
        `[3] advisory lock 3 processes x ${iters} increments: counter=${value} expected=${expected} => ${pass ? 'PASS' : 'FAIL'}`,
      );
    }

    // Cleanup scratch rows for repeatability.
    await db.execute(sql`truncate mp_processed`);
    await db.execute(sql`truncate mp_counter`);
    await db
      .delete(outboxEvents)
      .where(and(eq(outboxEvents.type, 'mp.test'), isNull(outboxEvents.deliveredAt)));

    console.log('\n=== multi-process reliability ===');
    for (const line of results) console.log(line);
    console.log(ok ? '\nALL PASS' : '\nFAILURES PRESENT');
  } finally {
    await pg.end({ timeout: 5 }).catch(() => undefined);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('multiprocess harness failed:', err);
  process.exit(1);
});
