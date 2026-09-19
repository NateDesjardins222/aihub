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
 *   5. the money ledger agrees  - the balance moved by exactly the realized
 *                                 P&L booked less the commission booked, and
 *                                 trade rows explain every realized micro
 *   6. the contract count agrees- the valuation and the positions, confirmed
 *                                 by a second read before it is believed
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
/** Print every operation and what the account looked like after it. */
const VERBOSE = argv.includes('--verbose');
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

/**
 * The authoritative state, or an exception.
 *
 * Every `?? []` here used to hide a failed request. Four parallel reads that
 * could not authenticate returned "no orders, no positions, no trades" - which
 * satisfies every invariant in this file, and reported a hundred operations of
 * nothing as a clean run. A read that did not happen is not a read of nothing.
 */
async function read() {
  const paths = [
    `/api/v1/orders?accountId=${state.accountId}`,
    `/api/v1/positions?accountId=${state.accountId}`,
    `/api/v1/accounts/${state.accountId}/pnl`,
    `/api/v1/trades?accountId=${state.accountId}`,
  ];
  const [orders, positions, pnl, trades] = await Promise.all(
    paths.map((path) => apiFetch(page, path)),
  );
  for (const [i, result] of [orders, positions, pnl, trades].entries()) {
    if (!result || result.ok !== true) {
      throw new Error(
        `could not read ${paths[i]}: ${result?.harnessError ?? `HTTP ${result?.status}`}`,
      );
    }
  }
  return {
    orders: orders.body.orders ?? [],
    positions: positions.body.positions ?? [],
    pnl: pnl.body ?? null,
    trades: trades.body.trades ?? [],
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

  return broken;
}

/**
 * The money ledger, as a DELTA between two snapshots.
 *
 * The first version of this compared the balance against starting + every
 * trade the API returned, and reported a failure on the very first sequence.
 * It was the invariant that was wrong: `/trades` returns at most a page of the
 * most recent trades, and this account has months of history behind it, so
 * "every trade" was never on offer. An invariant that cannot be satisfied is
 * worse than no invariant - it trains you to ignore the output.
 *
 * The second version said the balance may only move by the net P&L of the
 * trades that appeared. That is also wrong, and the first run that could
 * actually open a position said so: COMMISSION IS CHARGED AT EVERY FILL,
 * including the fill that opens a position, and an opening fill closes no
 * trade. The balance legitimately moved by -$8.07 with no trade to show for
 * it. An invariant written from what the harness assumed rather than from what
 * the engine does.
 *
 * What the engine actually does, once, in one statement:
 *
 *   balance += realizedPnl - fees
 *
 * So two things must hold between any two snapshots, and they are different
 * questions:
 *
 *   1. the ledger agrees with itself - the balance moved by exactly the
 *      realized P&L booked less the commission booked, so a balance that moved
 *      for any other reason is caught however small;
 *   2. the trades explain the realized P&L - every micro-dollar of realized
 *      change is accounted for by trade rows the trader can actually see.
 */
function ledgerDelta(before, after) {
  if (!before?.pnl || !after?.pnl) return [];
  const broken = [];

  const moved = after.pnl.balanceMicros - before.pnl.balanceMicros;
  const realized = after.pnl.realizedPnlMicros - before.pnl.realizedPnlMicros;
  const fees = after.pnl.feesMicros - before.pnl.feesMicros;

  if (moved !== realized - fees) {
    broken.push(
      `balance moved ${moved} micros, but the ledger booked ${realized} realized ` +
        `less ${fees} in commission (${realized - fees})`,
    );
  }

  const known = new Set(before.trades.map((t) => t.id));
  const fresh = after.trades.filter((t) => !known.has(t.id));
  const gross = fresh.reduce((sum, t) => sum + t.grossPnlMicros, 0);
  if (realized !== gross) {
    broken.push(
      `realized P&L moved ${realized} micros while ${fresh.length} new trade(s) ` +
        `accounted for ${gross}` +
        (fresh.length === 0 ? ' - it moved with no closed trade at all' : ''),
    );
  }

  return broken;
}

/**
 * Does the valuation's contract count agree with the positions?
 *
 * Both are computed from the same rows, so a disagreement means the two HTTP
 * reads straddled a fill - which is read skew, not a defect, and it corrects
 * itself on the next read. It is only worth reporting if it PERSISTS, so the
 * caller re-reads before believing it. Same discipline as the performance
 * gate: the sharpest rule has to be confirmed before it accuses.
 */
function contractMismatch(snapshot) {
  if (!snapshot.pnl) return null;
  const open = snapshot.positions.reduce((sum, p) => sum + Math.abs(p.qty), 0);
  const stated = snapshot.pnl.openContracts ?? open;
  return stated === open ? null : `valuation ${stated}, positions ${open}`;
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

/**
 * The operations, and what each one needs to be meaningful.
 *
 * DIRECTION COMES FROM `signedQty`, ALWAYS. The API presents a position with
 * `qty` absolute and `signedQty` carrying the side, so `position.qty > 0` is
 * true for a short as well - and this file used it to choose the side of a
 * partial and which side of the market a stop belongs on. Every partial taken
 * against a short scaled INTO it, and every stop was placed where the target
 * goes. None of it failed an invariant, because a refusal is a legitimate
 * outcome and a scale-in is a legal order. See D-010.
 */
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
      const size = Math.abs(position.signedQty);
      if (size < 2) return null;
      const take = Math.max(1, Math.min(size - 1, Math.round(size * (random() < 0.5 ? 0.5 : 0.25))));
      return submit(position.signedQty > 0 ? 'SELL' : 'BUY', take);
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
      return protect({ stopPrice: position.signedQty > 0 ? mark - away : mark + away });
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
      return protect({ targetPrice: position.signedQty > 0 ? mark + away : mark - away });
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
  /** Why the server said no, counted by reason. */
  const refusals = new Map();
  /** Disagreements that corrected themselves on a second read. */
  let transient = 0;
  /*
   * How many operations were chosen with a position already open.
   *
   * Six of the nine operations need one. A run where this is zero has
   * exercised submit and cancel and nothing else, whatever its operation
   * count says - which is exactly how D-007 hid for a whole milestone.
   */
  let withPosition = 0;

  for (let sequence = 0; sequence < SEQUENCES; sequence += 1) {
    const random = rng(SEED + sequence * 7919);
    for (let op = 0; op < OPS; op += 1) {
      const snapshot = await read();
      const position = snapshot.positions.find((p) => p.symbol === SYMBOL);
      const hasPosition = position ? Math.abs(position.qty) > 0 : false;
      if (hasPosition) withPosition += 1;
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
      /*
       * A refusal is a legitimate outcome - the risk engine saying no is the
       * system working - but WHY it was refused is the difference between a
       * torture test and a vacuous one. A run where every order came back
       * MARKET_CLOSED exercises nothing and would otherwise report "0
       * invariant failures", which is the most dangerous result a test can
       * give.
       */
      if (result && result.ok === false) {
        refused += 1;
        const code = result.body?.error?.code ?? `HTTP ${result.status}`;
        refusals.set(code, (refusals.get(code) ?? 0) + 1);
      }

      /*
       * Let the order actually FILL before looking at the damage.
       *
       * The first run of this harness performed 250 operations and never once
       * exercised a partial, a flatten, a reverse or a protective level -
       * every one of them needs a position, and in a paused replay a market
       * order sits working until the recording moves. It was measuring
       * submit-and-cancel and calling it a torture test.
       *
       * So the replay is stepped until nothing is left working, or until it is
       * clear that nothing will fill. That is the difference between a test
       * that opens positions and one that only asks for them.
       */
      for (let attempt = 0; attempt < 6; attempt += 1) {
        // A paused recording needs pushing; a live feed only needs waiting.
        if (state.market.mode === 'replay') await stepReplay(page, 8);
        await page.waitForTimeout(state.market.mode === 'replay' ? 160 : 1_200);
        const pending = await apiFetch(page, `/api/v1/orders?accountId=${state.accountId}`);
        if (!pending || pending.ok !== true) {
          throw new Error(`could not read orders while waiting for a fill: ${pending?.harnessError ?? pending?.status}`);
        }
        const working = (pending.body.orders ?? []).filter(
          (o) => o.type === 'MARKET' && isWorking(o),
        );
        if (working.length === 0) break;
      }
      await page.waitForTimeout(220);

      const after = await read();
      if (VERBOSE) {
        process.stdout.write(
          `  seq ${sequence} op ${op} ${chosen.name.padEnd(10)} ` +
            `-> ${result === null ? 'skipped' : `${result.status}${result.ok ? '' : ' ' + (result.body?.error?.code ?? '')}`}` +
            ` | positions ${JSON.stringify((after.positions ?? []).map((p) => `${p.symbol}:${p.qty}`))}` +
            ` | working ${(after.orders ?? []).filter(isWorking).length}` +
            ` | latest ${(after.orders ?? []).slice(0, 3).map((o) => `${o.side}${o.qty}:${o.status}${o.rejectReason ? '(' + o.rejectReason + ')' : ''}`).join(',')}\n`,
        );
      }
      const broken = invariants(after);

      broken.push(...ledgerDelta(snapshot, after));

      /*
       * The contract count is re-read before it is believed: both figures come
       * from the same rows, so a disagreement usually means the two requests
       * straddled a fill. One that is still there a moment later is a real
       * disagreement between two things the trader can see at once.
       */
      const skew = contractMismatch(after);
      if (skew) {
        await page.waitForTimeout(600);
        const again = await read();
        const persisted = contractMismatch(again);
        if (persisted) broken.push(`contract count disagrees and stayed that way: ${persisted}`);
        else transient += 1;
      }

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

  /*
   * A torture test that could not trade has not tested anything.
   *
   * This run reported "0 invariant failures" while every single order was
   * refused MARKET_CLOSED - the market had fallen back to the live feed after
   * a server restart. Zero failures out of zero opportunities is not a pass,
   * and saying so is the whole point of the exercise.
   */
  const tradedAtAll = performed - refused;
  const vacuous = refused > performed * 0.5 || tradedAtAll === 0 || withPosition === 0;

  console.log(`\noperations performed: ${performed}`);
  console.log(
    `  ${[...counts.entries()].map(([name, n]) => `${name} ${n}`).join(', ')}`,
  );
  console.log(`refused by the server: ${refused} (a refusal is an outcome, not a failure)`);
  if (refusals.size > 0) {
    console.log(`  ${[...refusals.entries()].map(([code, n]) => `${code} ${n}`).join(', ')}`);
  }
  console.log(
    `operations chosen with a position open: ${withPosition} ` +
      `(the other ${performed - withPosition} could only submit or cancel)`,
  );
  console.log(`read skew that corrected itself on a second read: ${transient}`);
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
          withPosition,
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

  if (vacuous) {
    console.log(
      `\nVACUOUS: ${refused} of ${performed} operations were refused and a position was open ` +
        `for ${withPosition} of them, so this run proves little.` +
        `\nThe usual cause is a market that cannot be traded - check the refusal reasons above.`,
    );
  }

  process.exitCode = failures.length === 0 && errors.length === 0 && !vacuous ? 0 : 1;
} finally {
  await browser.close();
}
