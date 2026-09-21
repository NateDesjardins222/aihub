/**
 * Deterministic end-to-end reliability scenario.
 *
 * One scripted run that drives the whole account-state + event-reliability
 * spine across REAL process boundaries and asserts a financial invariant at
 * every step. Where the V1 report proved the pieces separately, this assembles
 * them into a single ordered story and fails loudly if any link breaks:
 *
 *   1. order submission (a real separate API process)
 *   2. duplicate submission (client-order-id idempotency: no second order/fill)
 *   3. fill -> outbox -> projection, drained by TWO real worker processes
 *   4. owner read == trader read (projection valuation == engine valuation)
 *   5. worker SIGKILL mid-drain -> recovery, nothing lost, projection consistent
 *   6. duplicate event redelivery is harmless (recompute-from-authority)
 *   7. projection corruption detected by reconciliation, repaired by rebuild
 *   8. account switch + a DELAYED old-account event: neither account corrupts
 *   9. API process SIGKILLed mid-submit: authority is never torn
 *  10. reconnect: a fresh connection reads the durable state
 *  11. whole application-layer restart: new clients, re-drain, state intact
 *  12. final financial reconciliation: 0 drift, owner == trader, money conserved
 *
 * The market is scripted so fills are deterministic; the database is the only
 * shared state, exactly as it is in production. Every child is a real OS
 * process (`--role`), so the SKIP-LOCKED, crash-recovery and atomicity claims
 * are proven across process boundaries, not simulated in one event loop.
 *
 * Run: TEST_DATABASE_URL=postgres://atlas:atlas@localhost:5432/atlas_test \
 *      pnpm --filter @atlas/server exec tsx scripts/e2e-reliability.ts
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../src/db/client.js';
import { accountProjections, outboxEvents } from '../src/db/schema.js';
import { TradingEngine } from '../src/trading/engine.js';
import { ScriptedMarket, createFixture, settle, type TestFixture } from '../src/trading/harness.js';
import {
  accountOutboxHandler,
  readAccountProjection,
  reconcileAccountProjection,
  rebuildAllProjections,
} from '../src/platform/projection.js';
import { enqueueOutbox, OutboxWorker, outboxStats } from '../src/platform/outbox.js';

const URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
const SELF = fileURLToPath(import.meta.url);
const NQ_MARK = 20_000;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : null;
}

/** A market frame every process agrees on: same era, same mark. */
function markingMarket(price: number): ScriptedMarket {
  const m = new ScriptedMarket();
  // Fire-and-forget quote; ScriptedMarket.quote resolves synchronously enough
  // for markPrice to read it back before we value.
  void m.quote('NQ', price);
  return m;
}

// ---- child roles ----------------------------------------------------------

/** A real, separate API process: connect, submit one market order, fill, exit. */
async function runSubmit(): Promise<void> {
  const accountId = arg('account')!;
  const userId = arg('user')!;
  const clientOrderId = arg('client')!;
  const side = (arg('side') ?? 'BUY') as 'BUY' | 'SELL';
  const qty = Number(arg('qty') ?? '1');
  const spinMs = Number(arg('spin') ?? '0');
  const { db, sql: pg } = createDb(URL);
  const market = new ScriptedMarket();
  const engine = new TradingEngine(db, market);
  try {
    await engine.start();
    await market.quote('NQ', NQ_MARK);
    // Optional busy spin BEFORE the mutation, so a SIGKILL lands mid-flight
    // with nothing yet committed - proving the authority is never left torn.
    if (spinMs > 0) await settle(spinMs);
    await engine.submitOrder({ accountId, userId, clientOrderId, symbol: 'NQ', side, qty, type: 'MARKET' });
    await settle(600);
  } finally {
    engine.stop();
    await pg.end({ timeout: 5 }).catch(() => undefined);
  }
}

/** A real worker process: drain one account's outbox into its projection. */
async function runWorker(): Promise<void> {
  const accountId = arg('account')!;
  const slowMs = Number(arg('slow') ?? '0');
  const { db, sql: pg } = createDb(URL);
  const worker = new OutboxWorker(db, {
    aggregateId: accountId,
    batch: 4,
    handler: async (tx, event) => {
      if (slowMs > 0) await settle(slowMs);
      await accountOutboxHandler(tx as unknown as Database, event);
    },
  });
  try {
    await worker.runUntilEmpty();
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
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    let killed = false;
    if (opts.killAfterMs) {
      setTimeout(() => {
        killed = true;
        proc.kill('SIGKILL');
      }, opts.killAfterMs);
    }
    proc.on('exit', (code) => resolve(killed ? 'killed' : code ?? -1));
    proc.on('error', reject);
  });
}

interface Step {
  readonly n: number;
  readonly label: string;
  readonly pass: boolean;
  readonly detail: string;
}

async function main(): Promise<void> {
  const role = arg('role') ?? 'parent';
  if (role === 'submit') return runSubmit();
  if (role === 'worker') return runWorker();

  const { db, sql: pg } = createDb(URL);
  const steps: Step[] = [];
  const record = (n: number, label: string, pass: boolean, detail: string): void => {
    steps.push({ n, label, pass, detail });
    console.log(`[${n}] ${label}: ${detail} => ${pass ? 'PASS' : 'FAIL'}`);
  };

  let a: TestFixture | null = null;
  let b: TestFixture | null = null;
  try {
    // Two accounts, each its own user, on the shared database.
    a = await createFixture({ maxContracts: 50 });
    b = await createFixture({ maxContracts: 50 });
    const market = markingMarket(NQ_MARK);
    const engine = new TradingEngine(db, market);
    await engine.start();
    await market.quote('NQ', NQ_MARK);

    const startingBalanceA = (await one(pg, a.accountId)).balanceMicros;

    // -- 1. order submission (real API process) -----------------------------
    const coid = `e2e-a-${Date.now()}`;
    {
      const code = await child(['--role', 'submit', '--account', a.accountId, '--user', a.userId, '--client', coid, '--side', 'BUY', '--qty', '2']);
      const pos = await openQty(pg, a.accountId);
      record(1, 'order submission (separate API process)', code === 0 && pos === 2, `exit=${code} openQty=${pos}`);
    }

    // -- 2. duplicate submission (idempotency) ------------------------------
    {
      const code = await child(['--role', 'submit', '--account', a.accountId, '--user', a.userId, '--client', coid, '--side', 'BUY', '--qty', '2']);
      const orderCount = await countByClient(pg, a.accountId, coid);
      const pos = await openQty(pg, a.accountId);
      record(2, 'duplicate submission is idempotent', code === 0 && orderCount === 1 && pos === 2, `orders(coid)=${orderCount} openQty=${pos}`);
    }

    // -- 3. fill -> outbox -> projection, TWO real worker processes ----------
    {
      const pendingBefore = (await outboxStats(db, a.accountId)).pending;
      await Promise.all([
        child(['--role', 'worker', '--account', a.accountId]),
        child(['--role', 'worker', '--account', a.accountId]),
      ]);
      const stats = await outboxStats(db, a.accountId);
      const proj = await readAccountProjection(db, market, a.accountId);
      record(3, 'fill -> outbox -> projection (2 workers)', stats.pending === 0 && proj?.openContracts === 2, `pendingBefore=${pendingBefore} pendingAfter=${stats.pending} projOpen=${proj?.openContracts}`);
    }

    // -- 4. owner read == trader read ---------------------------------------
    {
      const fromEngine = await engine.valuation(a.accountId);
      const fromProjection = await readAccountProjection(db, market, a.accountId);
      const eq_ =
        !!fromEngine && !!fromProjection &&
        fromProjection.equityMicros === fromEngine.equityMicros &&
        fromProjection.unrealizedPnlMicros === fromEngine.openPnlMicros &&
        fromProjection.remainingLossMicros === fromEngine.remainingDrawdownMicros &&
        fromProjection.openContracts === fromEngine.openContracts &&
        fromProjection.balanceMicros === fromEngine.balanceMicros;
      record(4, 'owner read == trader read (to the micro-dollar)', eq_, `equity engine=${fromEngine?.equityMicros} proj=${fromProjection?.equityMicros}`);
    }

    // The authoritative balance the fill produced (starting, less commission).
    // Everything from here on is read-model, outbox, corruption, restart and
    // recovery machinery - none of it may move this number by a single micro.
    const balanceAfterFill = (await one(pg, a.accountId)).balanceMicros;

    // -- 5. worker SIGKILL mid-drain -> recovery ----------------------------
    {
      const N = 60;
      for (let i = 0; i < N; i += 1) await enqueueOutbox(db, { aggregateId: a.accountId, type: 'account.changed' });
      const killed = child(['--role', 'worker', '--account', a.accountId, '--slow', '30'], { killAfterMs: 400 });
      const healthy = child(['--role', 'worker', '--account', a.accountId, '--slow', '3']);
      const [killResult] = await Promise.all([killed, healthy]);
      await child(['--role', 'worker', '--account', a.accountId]); // final sweep
      const stats = await outboxStats(db, a.accountId);
      const rec = await reconcileAccountProjection(db, a.accountId);
      record(5, 'worker SIGKILL mid-drain -> recovery', killResult === 'killed' && stats.pending === 0 && rec.ok, `killed=${killResult === 'killed'} pending=${stats.pending} reconcile=${rec.ok}`);
    }

    // -- 6. duplicate event redelivery is harmless --------------------------
    {
      await enqueueOutbox(db, { aggregateId: a.accountId, type: 'account.changed' });
      await enqueueOutbox(db, { aggregateId: a.accountId, type: 'account.changed' });
      await child(['--role', 'worker', '--account', a.accountId]);
      const rec = await reconcileAccountProjection(db, a.accountId);
      record(6, 'duplicate event redelivery harmless', rec.ok, `reconcile=${rec.ok}`);
    }

    // -- 7. projection corruption -> reconcile detects -> rebuild repairs ----
    {
      await db
        .update(accountProjections)
        .set({ balanceMicros: 1, stateVersion: 0 })
        .where(eq(accountProjections.accountId, a.accountId));
      const bad = await reconcileAccountProjection(db, a.accountId);
      await rebuildAllProjections(db, {});
      const good = await reconcileAccountProjection(db, a.accountId);
      record(7, 'corruption detected, rebuild repairs', !bad.ok && good.ok, `detected=${!bad.ok} repaired=${good.ok}`);
    }

    // -- 8. account switch + a DELAYED old-account event --------------------
    {
      const coidB = `e2e-b-${Date.now()}`;
      await child(['--role', 'submit', '--account', b.accountId, '--user', b.userId, '--client', coidB, '--side', 'BUY', '--qty', '1']);
      await child(['--role', 'worker', '--account', b.accountId]);
      // The trader has "switched" to B. Now a stale/delayed event for A lands.
      await enqueueOutbox(db, { aggregateId: a!.accountId, type: 'account.changed', payload: { reason: 'delayed' } });
      await child(['--role', 'worker', '--account', a!.accountId]);
      const recA = await reconcileAccountProjection(db, a!.accountId);
      const recB = await reconcileAccountProjection(db, b.accountId);
      const projB = await readAccountProjection(db, market, b.accountId);
      record(8, 'account switch + delayed old-account event', recA.ok && recB.ok && projB?.openContracts === 1, `reconcileA=${recA.ok} reconcileB=${recB.ok} bOpen=${projB?.openContracts}`);
    }

    // -- 9. API process SIGKILLed mid-submit: authority never torn ----------
    {
      const coidKill = `e2e-kill-${Date.now()}`;
      const balBefore = (await one(pg, a!.accountId)).balanceMicros;
      const posBefore = await openQty(pg, a!.accountId);
      // A submit that spins before mutating, killed while it spins: nothing
      // should have been committed, so authority is unchanged.
      const res = await child(['--role', 'submit', '--account', a!.accountId, '--user', a!.userId, '--client', coidKill, '--side', 'BUY', '--qty', '1', '--spin', '5000'], { killAfterMs: 300 });
      // Recover any partial delivery, then reconcile.
      await child(['--role', 'worker', '--account', a!.accountId]);
      const acct = await one(pg, a!.accountId);
      const posAfter = await openQty(pg, a!.accountId);
      const rec = await reconcileAccountProjection(db, a!.accountId);
      // Authority is coherent (balance is a finite integer, positions consistent)
      // and the projection reconciles. The killed order either does not exist or
      // is a complete row - never a half-written one.
      const torn = !Number.isFinite(acct.balanceMicros) || posAfter < 0;
      const noPartial = acct.balanceMicros === balBefore && posAfter === posBefore;
      record(9, 'API process killed mid-submit: authority not torn', res === 'killed' && !torn && rec.ok && noPartial, `killed=${res === 'killed'} balSame=${noPartial} reconcile=${rec.ok}`);
    }

    // -- 10. reconnect: a fresh connection reads durable state --------------
    {
      const { db: db2, sql: pg2 } = createDb(URL);
      try {
        const proj = await readAccountProjection(db2, market, a!.accountId);
        const rec = await reconcileAccountProjection(db2, a!.accountId);
        record(10, 'reconnect reads durable state', !!proj && proj.openContracts === 2 && rec.ok, `projOpen=${proj?.openContracts} reconcile=${rec.ok}`);
      } finally {
        await pg2.end({ timeout: 5 }).catch(() => undefined);
      }
    }

    // -- 11. whole application-layer restart --------------------------------
    {
      engine.stop();
      // Brand-new clients and engine, as a cold process would have.
      const { db: db3, sql: pg3 } = createDb(URL);
      try {
        const market3 = markingMarket(NQ_MARK);
        const engine3 = new TradingEngine(db3, market3);
        await engine3.start();
        // Re-drain anything outstanding and reconcile both accounts.
        await child(['--role', 'worker', '--account', a!.accountId]);
        await child(['--role', 'worker', '--account', b!.accountId]);
        const recA = await reconcileAccountProjection(db3, a!.accountId);
        const recB = await reconcileAccountProjection(db3, b!.accountId);
        const vE = await engine3.valuation(a!.accountId);
        const vP = await readAccountProjection(db3, market3, a!.accountId);
        const converge = !!vE && !!vP && vE.equityMicros === vP.equityMicros && vE.openContracts === vP.openContracts;
        engine3.stop();
        record(11, 'application-layer restart: state intact & convergent', recA.ok && recB.ok && converge, `reconcileA=${recA.ok} reconcileB=${recB.ok} converge=${converge}`);
      } finally {
        await pg3.end({ timeout: 5 }).catch(() => undefined);
      }
    }

    // -- 12. final financial reconciliation ---------------------------------
    {
      const recA = await reconcileAccountProjection(db, a!.accountId);
      const recB = await reconcileAccountProjection(db, b!.accountId);
      // Money conservation: A still holds its open position (never closed), so
      // realized P&L is 0, and NONE of the reliability machinery since the fill
      // (recovery, duplicate events, corruption+rebuild, kill, restart) moved
      // the authoritative balance by a micro.
      const acctA = await one(pg, a!.accountId);
      const untouched = acctA.balanceMicros === balanceAfterFill && acctA.realizedPnlMicros === 0;
      record(12, 'final reconciliation & money conservation', recA.ok && recB.ok && untouched, `reconcileA=${recA.ok} reconcileB=${recB.ok} balanceUntouched=${untouched} (start=${startingBalanceA} afterFill=${balanceAfterFill} now=${acctA.balanceMicros})`);
    }

    const ok = steps.every((s) => s.pass);
    console.log('\n=== e2e reliability scenario ===');
    console.log(`${steps.filter((s) => s.pass).length}/${steps.length} steps passed`);
    console.log(ok ? 'ALL PASS' : 'FAILURES PRESENT');
    // Cleanup the delayed/manual outbox rows for repeatability.
    await db.delete(outboxEvents).where(eq(outboxEvents.aggregateId, a!.accountId));
    await db.delete(outboxEvents).where(eq(outboxEvents.aggregateId, b!.accountId));
    process.exitCode = ok ? 0 : 1;
  } finally {
    await a?.close().catch(() => undefined);
    await b?.close().catch(() => undefined);
    await pg.end({ timeout: 5 }).catch(() => undefined);
  }
}

// -- small authority readers ------------------------------------------------

async function one(pg: ReturnType<typeof createDb>['sql'], accountId: string): Promise<{ balanceMicros: number; realizedPnlMicros: number }> {
  const rows = await pg`select balance_micros, realized_pnl_micros from accounts where id = ${accountId}`;
  return { balanceMicros: Number(rows[0]!['balance_micros']), realizedPnlMicros: Number(rows[0]!['realized_pnl_micros']) };
}
async function openQty(pg: ReturnType<typeof createDb>['sql'], accountId: string): Promise<number> {
  const rows = await pg`select coalesce(sum(abs(qty)),0)::int as n from positions where account_id = ${accountId} and qty <> 0`;
  return Number(rows[0]!['n']);
}
async function countByClient(pg: ReturnType<typeof createDb>['sql'], accountId: string, coid: string): Promise<number> {
  const rows = await pg`select count(*)::int as n from orders where account_id = ${accountId} and client_order_id = ${coid}`;
  return Number(rows[0]!['n']);
}

main().catch((err) => {
  console.error('e2e reliability harness failed:', err);
  process.exit(1);
});
