/**
 * Deterministic randomized torture harness for account state + event reliability.
 *
 * A seeded pseudo-random stream drives a long sequence of trading and
 * reliability operations against real accounts on a real PostgreSQL, and after
 * EVERY step re-checks the invariants that must never break, however the
 * operations interleave:
 *
 *   I1. the projection reconciles with authority (0 drift) for every account
 *   I2. owner truth == trader truth: valueProjection == engine.valuation to the
 *       micro-dollar (equity, unrealized, remaining drawdown, contracts, balance)
 *       - and unknown is unknown on both sides, never a fabricated zero
 *   I3. state_version is monotonic per account (never rolls backward)
 *   I4. open contracts are never negative and match authority
 *   I5. the balance is always a finite integer number of micro-dollars
 *
 * Operations drawn from the stream: market/limit/stop submit, cancel, modify,
 * flatten, reverse, protective SL/TP, bracket entries, admin holds, account
 * switching, market moves (which cause fills and partials), duplicate events,
 * delayed cross-account events, projection rebuilds, and worker restarts.
 *
 * The seed makes the whole run reproducible: the same seed replays the same
 * sequence and the same fills. A rejected operation (a rule breach, a hold) is
 * a legitimate outcome, not a failure - the harness asserts the INVARIANTS, not
 * that every action is accepted. A single invariant violation prints the seed,
 * step, account and the exact diff, and exits non-zero.
 *
 * Run: TEST_DATABASE_URL=postgres://atlas:atlas@localhost:5432/atlas_test \
 *      pnpm --filter @atlas/server exec tsx scripts/torture-reliability.ts --seed 1 --ops 400
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { requireInstrument, priceToTicks } from '@atlas/instruments';
import { accounts, orders, positions } from '../src/db/schema.js';
import { TradingEngine } from '../src/trading/engine.js';
import { ScriptedMarket, createFixture, settle, type TestFixture } from '../src/trading/harness.js';
import {
  accountOutboxHandler,
  projectAccount,
  readAccountProjection,
  reconcileAccountProjection,
  rebuildAllProjections,
} from '../src/platform/projection.js';
import { enqueueOutbox, OutboxWorker, outboxStats } from '../src/platform/outbox.js';

const URL = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
const SYMBOL = 'NQ';

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? dflt) : dflt;
}

/** mulberry32: a small, fast, fully deterministic PRNG. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Invariant {
  readonly ok: boolean;
  readonly reason: string;
}

async function main(): Promise<void> {
  const seed = Number(arg('seed', '1'));
  const ops = Number(arg('ops', '400'));
  const nAccounts = Number(arg('accounts', '4'));
  const rng = makeRng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

  const spec = requireInstrument(SYMBOL);
  const market = new ScriptedMarket();
  let mark = 20_000;
  await market.quote(SYMBOL, mark);

  const fixtures: TestFixture[] = [];
  const opCounts: Record<string, number> = {};
  const bump = (k: string): void => {
    opCounts[k] = (opCounts[k] ?? 0) + 1;
  };
  let rejections = 0;
  let fills = 0;
  const lastVersion = new Map<string, number>();

  // A single engine and DB across the run (the shared authority).
  let engine: TradingEngine | null = null;

  try {
    for (let i = 0; i < nAccounts; i += 1) {
      fixtures.push(
        await createFixture({
          maxContracts: 50,
          startingBalanceMicros: 100_000 * 1_000_000,
          // Zero latency for deterministic immediate eligibility; a one-contract
          // liquidity cap so multi-lot orders genuinely partial-fill; fees and
          // slippage kept on, so the money math is exercised, not idealised.
          environment: { latencyMs: 0, maxContractsPerFill: 1 },
        }),
      );
    }
    const db = fixtures[0]!.db;
    engine = new TradingEngine(db, market);
    await engine.start();
    for (const f of fixtures) lastVersion.set(f.accountId, -1);

    let seq = 0;
    const coid = (): string => `t-${seed}-${(seq += 1)}`;

    // Drain every account's outbox into its projection, as the consumer does.
    async function drainAll(): Promise<void> {
      for (const f of fixtures) {
        const worker = new OutboxWorker(db, { aggregateId: f.accountId, handler: accountOutboxHandler });
        await worker.runUntilEmpty();
      }
    }

    async function pending(): Promise<number> {
      let n = 0;
      for (const f of fixtures) n += (await outboxStats(db, f.accountId)).pending;
      return n;
    }

    // Wait for the projections to catch up, as an eventually-consistent consumer
    // does. Engine nudges are fire-and-forget (and some, like a high-water-mark
    // advance, change authority WITHOUT bumping seq), so this drains until the
    // outbox is durably empty - settling first to let in-flight enqueues land,
    // and double-checking so a late nudge is not missed. A genuinely MISSING
    // nudge enqueues nothing, so the outbox is empty and this returns at once;
    // the reconcile in the invariant check then catches the drift - which is how
    // this harness surfaced the modify/protect/HWM gaps in the first place.
    async function converge(): Promise<void> {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await settle(25);
        await drainAll();
        if ((await pending()) === 0) {
          await settle(25);
          await drainAll();
          if ((await pending()) === 0) return;
        }
      }
    }

    // The strict invariant check, run after every step for every account.
    async function checkInvariants(step: number, note: string): Promise<Invariant> {
      for (const f of fixtures) {
        const acct = f.accountId;
        // I1: reconcile projection vs authority.
        const rec = await reconcileAccountProjection(db, acct);
        if (!rec.ok) {
          return { ok: false, reason: `I1 drift on ${acct} @${step} (${note}): ${rec.missing ? 'missing' : JSON.stringify(rec.diffs)}` };
        }
        // I2: owner (projection) == trader (engine) valuation.
        const vE = await engine!.valuation(acct);
        const vP = await readAccountProjection(db, market, acct);
        if (!vE || !vP) {
          return { ok: false, reason: `I2 null valuation on ${acct} @${step} (${note}): engine=${!!vE} proj=${!!vP}` };
        }
        if (
          vE.equityMicros !== vP.equityMicros ||
          vE.openPnlMicros !== vP.unrealizedPnlMicros ||
          vE.remainingDrawdownMicros !== vP.remainingLossMicros ||
          vE.openContracts !== vP.openContracts ||
          vE.balanceMicros !== vP.balanceMicros
        ) {
          return {
            ok: false,
            reason: `I2 owner!=trader on ${acct} @${step} (${note}): engine(eq=${vE.equityMicros},up=${vE.openPnlMicros},rem=${vE.remainingDrawdownMicros},oc=${vE.openContracts},bal=${vE.balanceMicros}) proj(eq=${vP.equityMicros},up=${vP.unrealizedPnlMicros},rem=${vP.remainingLossMicros},oc=${vP.openContracts},bal=${vP.balanceMicros})`,
          };
        }
        // I3: state_version monotonic.
        if (vP.stateVersion < (lastVersion.get(acct) ?? -1)) {
          return { ok: false, reason: `I3 version rolled back on ${acct} @${step}: ${vP.stateVersion} < ${lastVersion.get(acct)}` };
        }
        lastVersion.set(acct, vP.stateVersion);
        // I4: contracts non-negative.
        if (vP.openContracts < 0) return { ok: false, reason: `I4 negative contracts on ${acct} @${step}: ${vP.openContracts}` };
        // I5: balance is a finite integer.
        if (!Number.isInteger(vP.balanceMicros)) return { ok: false, reason: `I5 non-integer balance on ${acct} @${step}: ${vP.balanceMicros}` };
      }
      return { ok: true, reason: '' };
    }

    const OPERATIONS = [
      'market', 'limit', 'stop', 'cancel', 'modify', 'flatten', 'reverse',
      'protect', 'bracket', 'hold', 'move', 'dup-event', 'delayed-event',
      'rebuild', 'worker-restart',
    ] as const;

    // Seed the initial projection for each fresh account (the consumer's first
    // recompute), then assert the invariants hold from a clean start.
    for (const f of fixtures) await projectAccount(db, f.accountId);
    const startInvariant = await checkInvariants(0, 'start');
    if (!startInvariant.ok) throw new Error(startInvariant.reason);

    for (let step = 1; step <= ops; step += 1) {
      const f = pick(fixtures); // account switching is inherent: each step picks one
      const acct = f.accountId;
      const user = f.userId;
      const op = pick(OPERATIONS);
      bump(op);
      try {
        switch (op) {
          case 'market': {
            const before = await openQty(db, acct);
            await engine.submitOrder({ accountId: acct, userId: user, clientOrderId: coid(), symbol: SYMBOL, side: pick(['BUY', 'SELL'] as const), qty: int(1, 3), type: 'MARKET' });
            await settle(70);
            const after = await openQty(db, acct);
            if (after !== before) fills += 1;
            break;
          }
          case 'limit': {
            const away = int(2, 20);
            const side = pick(['BUY', 'SELL'] as const);
            const px = side === 'BUY' ? mark - away * 0.25 : mark + away * 0.25;
            await engine.submitOrder({ accountId: acct, userId: user, clientOrderId: coid(), symbol: SYMBOL, side, qty: int(1, 3), type: 'LIMIT', limitTicks: priceToTicks(spec, px) });
            break;
          }
          case 'stop': {
            const away = int(2, 20);
            const side = pick(['BUY', 'SELL'] as const);
            const px = side === 'BUY' ? mark + away * 0.25 : mark - away * 0.25;
            await engine.submitOrder({ accountId: acct, userId: user, clientOrderId: coid(), symbol: SYMBOL, side, qty: int(1, 3), type: 'STOP_MARKET', stopTicks: priceToTicks(spec, px) });
            break;
          }
          case 'cancel': {
            const o = await someWorkingOrder(db, acct, rng);
            if (o) await engine.cancelOrder(acct, o);
            break;
          }
          case 'modify': {
            const o = await someWorkingOrder(db, acct, rng);
            if (o) await engine.modifyOrder(acct, o, { qty: int(1, 4) });
            break;
          }
          case 'flatten':
            await engine.flatten(acct, user, SYMBOL);
            await settle(70);
            break;
          case 'reverse':
            await engine.reverse(acct, user, SYMBOL);
            await settle(70);
            break;
          case 'protect':
            await engine.setProtection(acct, user, SYMBOL, { stopTicks: priceToTicks(spec, mark - int(5, 30) * 0.25), targetTicks: priceToTicks(spec, mark + int(5, 30) * 0.25) });
            break;
          case 'bracket':
            await engine.submitOrder({ accountId: acct, userId: user, clientOrderId: coid(), symbol: SYMBOL, side: pick(['BUY', 'SELL'] as const), qty: int(1, 2), type: 'MARKET', bracket: { stopLossTicks: int(8, 40), takeProfitTicks: int(8, 40) } });
            await settle(70);
            break;
          case 'hold': {
            // Toggle an admin hold directly on authority, then let the change
            // flow to the projection. Ends unheld so trading can continue.
            const held = pick([true, false]);
            await db.update(accounts).set({ adminHold: held ? 'MANUAL' : null }).where(eq(accounts.id, acct));
            await enqueueOutbox(db, { aggregateId: acct, type: 'account.changed', payload: { reason: 'hold' } });
            break;
          }
          case 'move': {
            mark += pick([-1, 1]) * int(0, 12) * 0.25;
            if (mark < 100) mark = 100;
            await market.quote(SYMBOL, mark);
            await settle(70); // let any resting/stop orders trigger and fill
            break;
          }
          case 'dup-event':
            await enqueueOutbox(db, { aggregateId: acct, type: 'account.changed' });
            await enqueueOutbox(db, { aggregateId: acct, type: 'account.changed' });
            break;
          case 'delayed-event': {
            // A stale event for a DIFFERENT account than the one just acted on.
            const other = pick(fixtures).accountId;
            await enqueueOutbox(db, { aggregateId: other, type: 'account.changed', payload: { reason: 'delayed' } });
            break;
          }
          case 'rebuild':
            await rebuildAllProjections(db, {});
            break;
          case 'worker-restart':
            // A fresh worker instance drains from scratch (as a restart would).
            await new OutboxWorker(db, { aggregateId: acct, handler: accountOutboxHandler }).runUntilEmpty();
            break;
        }
      } catch (err) {
        // A rejected operation (rule breach, not-modifiable, hold, etc.) is a
        // valid outcome. The invariants below still must hold.
        rejections += 1;
        void err;
      }

      // The consumer keeps up (bounded, eventually-consistent), then the
      // invariants are re-verified.
      await converge();
      const inv = await checkInvariants(step, op);
      if (!inv.ok) {
        console.error(`\nINVARIANT VIOLATION (seed=${seed}, step=${step}/${ops}, op=${op}):`);
        console.error('  ' + inv.reason);
        console.error('  reproduce: --seed ' + seed + ' --ops ' + step + ' --accounts ' + nAccounts);
        process.exitCode = 1;
        return;
      }
    }

    console.log(`\n=== torture harness (seed=${seed}, ops=${ops}, accounts=${nAccounts}) ===`);
    console.log('operations: ' + Object.entries(opCounts).map(([k, v]) => `${k}=${v}`).join(' '));
    console.log(`fills observed: ${fills}   rejected ops (legitimate): ${rejections}`);
    console.log(`invariant checks: ${ops + 1} steps x ${nAccounts} accounts x 5 invariants = ${(ops + 1) * nAccounts * 5} assertions, 0 violations`);
    console.log('ALL INVARIANTS HELD');
  } finally {
    engine?.stop();
    for (const f of fixtures) await f.close().catch(() => undefined);
  }
}

const WORKING = ['PENDING', 'ACCEPTED', 'WORKING', 'PARTIALLY_FILLED'];

async function openQty(db: TestFixture['db'], accountId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`coalesce(sum(abs(${positions.qty})),0)::int` })
    .from(positions)
    .where(and(eq(positions.accountId, accountId), sql`${positions.qty} <> 0`));
  return Number(rows[0]?.n ?? 0);
}

async function someWorkingOrder(db: TestFixture['db'], accountId: string, rng: () => number): Promise<string | null> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.accountId, accountId), inArray(orders.status, WORKING)));
  if (!rows.length) return null;
  return rows[Math.floor(rng() * rows.length)]!.id;
}

main().catch((err) => {
  console.error('torture harness failed:', err);
  process.exit(1);
});
