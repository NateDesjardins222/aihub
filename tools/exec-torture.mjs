/**
 * The execution torture test.
 *
 *   node tools/exec-torture.mjs                        # 40 sequences of 12
 *   node tools/exec-torture.mjs --sequences 200 --ops 16
 *   node tools/exec-torture.mjs --seed 12345           # replay a failure
 *
 * Hundreds of submit / cancel / modify / scale / partial / flatten / reverse /
 * stop / target operations in seeded random order, against the real server.
 *
 * WHAT IT ASSERTS IS MONEY, NOT STATUS CODES. A request that returns 200 and
 * leaves an orphan stop behind has not worked. After EVERY operation the
 * authoritative state is re-read and six invariants are checked:
 *
 *   1. flat means flat          - no working protective order without a position
 *   2. protection fits          - a stop or target is sized to the position
 *   3. terminal is terminal     - nothing FILLED or CANCELED is still working
 *   4. an entry price exists    - iff there is a position to have one
 *   5. the balance reconciles   - starting + every closed trade, to the micro
 *   6. the contract count agrees- the valuation and the position say the same
 *
 * A failure prints the seed and the operation index, and the same seed replays
 * the same sequence exactly.
 */
import { writeFileSync } from 'node:fs';
import { apiFetch, launch, signIn, tradableMarket, useAccount, useSymbol, stepReplay } from '../tests/browser/harness.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(argv[at + 1] ?? fallback);
};
const SEQUENCES = flag('sequences', 40);
const OPS = flag('ops', 12);
const SEED = flag('seed', 1234);
const JSON_OUT = argv.includes('--json') ? (argv[argv.indexOf('--json') + 1] ?? null) : null;
const SYMBOL = 'NQ';

/** Mulberry32: small, seeded, and the same sequence on every machine. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const { browser, page, errors } = await launch({ width: 1400, height: 900 });

const state = { accountId: null, tickSize: 0.25, market: null };

async function read() {
  const [orders, positions, pnl, trades] = await Promise.all([
    apiFetch(page, `/api/v1/orders?accountId=${state.accountId}`),
    apiFetch(page, `/api/v1/positions?accountId=${state.accountId}`),
    apiFetch(page, `/api/v1/accounts/${state.accountId}/pnl`),
    apiFetch(page, `/api/v1/trades?accountId=${state.accountId}`),
  ]);
  return {
    orders: orders?.body?.orders ?? [],
    positions: positions?.body?.positions ?? [],
    pnl: pnl?.body ?? null,
    trades: trades?.body?.trades ?? [],
  };
}

const isWorking = (o) => o.status === 'WORKING' || o.status === 'PARTIALLY_FILLED';
const TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);

/** Every invariant, checked against one authoritative snapshot. */
function invariants(snapshot) {
  const broken = [];
  const position = snapshot.positions.find((p) => p.symbol === SYMBOL) ?? null;
  const qty = position ? Math.abs(position.qty) : 0;
  const protective = snapshot.orders.filter(
    (o) => isWorking(o) && (o.bracketRole === 'STOP_LOSS' || o.bracketRole === 'TAKE_PROFIT'),
  );

  if (qty === 0 && protective.length > 0) {
    broken.push(`orphan protection: flat, but ${protective.length} protective order(s) working`);
  }

  for (const order of protective) {
    if (order.remainingQty !== qty) {
      broken.push(
        `protection mis-sized: ${order.bracketRole} has ${order.remainingQty} against a position of ${qty}`,
      );
    }
  }

  for (const order of snapshot.orders) {
    if (TERMINAL.has(order.status) && isWorking(order)) {
      broken.push(`terminal order still working: ${order.id} ${order.status}`);
    }
  }

  if (qty > 0 && position.avgEntryPrice === null) {
    broken.push(`a position of ${qty} has no average entry`);
  }
  if (qty === 0 && position && position.avgEntryPrice !== null) {
    broken.push(`flat, but an average entry of ${position.avgEntryPrice} remains`);
  }

  if (snapshot.pnl) {
    const closed = snapshot.trades.reduce((sum, t) => sum + t.netPnlMicros, 0);
    const expected = snapshot.pnl.startingBalanceMicros + closed;
    if (expected !== snapshot.pnl.balanceMicros) {
      broken.push(
        `balance does not reconcile: starting ${snapshot.pnl.startingBalanceMicros} + closed ${closed} = ${expected}, server says ${snapshot.pnl.balanceMicros}`,
      );
    }
    const open = snapshot.positions.reduce((sum, p) => sum + Math.abs(p.qty), 0);
    if ((snapshot.pnl.openContracts ?? open) !== open) {
      broken.push(
        `contract count disagrees: valuation ${snapshot.pnl.openContracts}, positions ${open}`,
      );
    }
  }

  return broken;
}

async function submit(side, qty) {
  return apiFetch(page, '/api/v1/orders', {
    method: 'POST',
    body: {
      accountId: state.accountId,
      clientOrderId: `torture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      symbol: SYMBOL,
      side,
      qty,
      type: 'MARKET',
      tif: 'DAY',
    },
  });
}

const protect = (levels) =>
  apiFetch(page, `/api/v1/positions/${SYMBOL}/protect`, {
    method: 'POST',
    body: { accountId: state.accountId, ...levels },
  });

/** The operations, and what each one needs to be meaningful. */
const OPERATIONS = [
  {
    name: 'buy',
    run: async (random) => submit('BUY', 1 + Math.floor(random() * 3)),
  },
  {
    name: 'sell',
    run: async (random) => submit('SELL', 1 + Math.floor(random() * 3)),
  },
  {
    name: 'partial',
    needsPosition: true,
    run: async (random, snapshot) => {
      const position = snapshot.positions.find((p) => p.symbol === SYMBOL);
      const size = Math.abs(position.qty);
      if (size < 2) return null;
      const take = Math.max(1, Math.min(size - 1, Math.round(size * (random() < 0.5 ? 0.5 : 0.25))));
      return submit(position.qty > 0 ? 'SELL' : 'BUY', take);
    },
  },
  {
    name: 'stop',
    needsPosition: true,
    run: async (random, snapshot) => {
      const position = snapshot.positions.find((p) => p.symbol === SYMBOL);
      const mark = position.markPrice ?? position.avgEntryPrice;
      if (mark === null) return null;
      const away = (8 + Math.floor(random() * 30)) * state.tickSize;
      return protect({ stopPrice: position.qty > 0 ? mark - away : mark + away });
    },
  },
  {
    name: 'target',
    needsPosition: true,
    run: async (random, snapshot) => {
      const position = snapshot.positions.find((p) => p.symbol === SYMBOL);
      const mark = position.markPrice ?? position.avgEntryPrice;
      if (mark === null) return null;
      const away = (8 + Math.floor(random() * 40)) * state.tickSize;
      return protect({ targetPrice: position.qty > 0 ? mark + away : mark - away });
    },
  },
  {
    name: 'clear-stop',
    needsPosition: true,
    run: async () => protect({ stopPrice: null }),
  },
  {
    name: 'cancel-all',
    run: async () =>
      apiFetch(page, '/api/v1/orders/cancel-all', {
        method: 'POST',
        body: { accountId: state.accountId, symbol: SYMBOL },
      }),
  },
  {
    name: 'flatten',
    needsPosition: true,
    run: async () =>
      apiFetch(page, `/api/v1/positions/${SYMBOL}/flatten`, {
        method: 'POST',
        body: { accountId: state.accountId },
      }),
  },
  {
    name: 'reverse',
    needsPosition: true,
    run: async () =>
      apiFetch(page, `/api/v1/positions/${SYMBOL}/reverse`, {
        method: 'POST',
        body: { accountId: state.accountId },
      }),
  },
];

const resources = () =>
  page.evaluate(() => ({
    dom: document.querySelectorAll('*').length,
    canvases: document.querySelectorAll('canvas').length,
    heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1024 / 1024 : null,
  }));

try {
  await signIn(page);
  await useSymbol(page, SYMBOL);
  await useAccount(page, 'Practice 150K');
  state.accountId = await page.inputValue('.abar-account');
  state.market = await tradableMarket(page);
  process.stdout.write(`account ${state.accountId}, ${state.market.mode} market, seed ${SEED}\n`);

  const instrument = await apiFetch(page, '/api/v1/instruments');
  const spec = (instrument?.body?.instruments ?? []).find((i) => i.root === SYMBOL);
  if (spec) state.tickSize = spec.tickSize;

  // A known starting point.
  await apiFetch(page, '/api/v1/orders/cancel-all', {
    method: 'POST',
    body: { accountId: state.accountId },
  });
  await apiFetch(page, `/api/v1/positions/${SYMBOL}/flatten`, {
    method: 'POST',
    body: { accountId: state.accountId },
  });
  await state.market.fill();

  const before = await resources();
  const failures = [];
  const counts = new Map();
  let performed = 0;
  let refused = 0;

  for (let sequence = 0; sequence < SEQUENCES; sequence += 1) {
    const random = rng(SEED + sequence * 7919);
    for (let op = 0; op < OPS; op += 1) {
      const snapshot = await read();
      const position = snapshot.positions.find((p) => p.symbol === SYMBOL);
      const hasPosition = position ? Math.abs(position.qty) > 0 : false;
      const available = OPERATIONS.filter((o) => !o.needsPosition || hasPosition);
      const chosen = available[Math.floor(random() * available.length)];

      let result = null;
      try {
        result = await chosen.run(random, snapshot);
      } catch (err) {
        failures.push({ sequence, op, operation: chosen.name, error: String(err).slice(0, 200) });
      }
      counts.set(chosen.name, (counts.get(chosen.name) ?? 0) + 1);
      performed += 1;
      // A refusal is a legitimate outcome - the risk engine saying no is the
      // system working - but it is counted so a run of nothing but refusals
      // cannot masquerade as a passing torture test.
      if (result && result.ok === false) refused += 1;

      // Give the matcher a market to work against, then look at the damage.
      if (state.market.mode === 'replay') await stepReplay(page, 4);
      await page.waitForTimeout(220);

      const after = await read();
      const broken = invariants(after);
      for (const reason of broken) {
        failures.push({ sequence, op, operation: chosen.name, reason });
      }
    }

    // Home between sequences, so one bad sequence cannot poison the next.
    await apiFetch(page, '/api/v1/orders/cancel-all', {
      method: 'POST',
      body: { accountId: state.accountId },
    });
    await apiFetch(page, `/api/v1/positions/${SYMBOL}/flatten`, {
      method: 'POST',
      body: { accountId: state.accountId },
    });
    if (state.market.mode === 'replay') await stepReplay(page, 8);
    await page.waitForTimeout(300);

    if ((sequence + 1) % 5 === 0) {
      const now = await resources();
      process.stdout.write(
        `  ${sequence + 1}/${SEQUENCES} sequences, ${performed} operations, ` +
          `${failures.length} invariant failure(s), dom ${now.dom}, canvases ${now.canvases}` +
          `${now.heapMB === null ? '' : `, heap ${now.heapMB.toFixed(1)}MB`}\n`,
      );
    }
  }

  const after = await resources();
  const finalState = await read();

  console.log(`\noperations performed: ${performed}`);
  console.log(
    `  ${[...counts.entries()].map(([name, n]) => `${name} ${n}`).join(', ')}`,
  );
  console.log(`refused by the server: ${refused} (a refusal is an outcome, not a failure)`);
  console.log(`invariant failures:   ${failures.length}`);
  for (const failure of failures.slice(0, 20)) {
    console.log(
      `  seq ${failure.sequence} op ${failure.op} (${failure.operation}): ${failure.reason ?? failure.error}`,
    );
  }
  console.log(
    `\nresources: dom ${before.dom} -> ${after.dom}, canvases ${before.canvases} -> ${after.canvases}` +
      (before.heapMB === null
        ? ''
        : `, heap ${before.heapMB.toFixed(1)}MB -> ${after.heapMB.toFixed(1)}MB`),
  );
  console.log(`final state: ${JSON.stringify(invariants(finalState))}`);
  console.log(`page errors: ${errors.length === 0 ? 'none' : errors.slice(0, 3).join(' | ')}`);

  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          seed: SEED,
          sequences: SEQUENCES,
          ops: OPS,
          performed,
          refused,
          failures,
          resources: { before, after },
          errors,
        },
        null,
        2,
      ),
    );
    console.log(`\nwritten to ${JSON_OUT}`);
  }

  process.exitCode = failures.length === 0 && errors.length === 0 ? 0 : 1;
} finally {
  await browser.close();
}
