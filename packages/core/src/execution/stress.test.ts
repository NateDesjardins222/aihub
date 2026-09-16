import { describe, expect, it } from 'vitest';
import { requireInstrument, priceToTicks } from '@atlas/instruments';
import type { InstrumentSpec } from '@atlas/contracts';
import { applyFill, flatPosition, type PositionState } from '../position/position.js';
import { DEFAULT_ENVIRONMENT, FRICTIONLESS_ENVIRONMENT, type SimulationEnvironment } from './environment.js';
import { createOrder } from './orders.js';
import { matchOrders } from './matching.js';
import { remainingQty, type EngineOrder, type MarketSnapshot } from './types.js';

/**
 * Adversarial stress tests.
 *
 * These do not check that the engine produces a particular fill. They check
 * that whatever it produces cannot be impossible. Every invariant below
 * describes something that, if violated, would mean the simulator is inventing
 * profit — the single failure mode that makes a trading simulator worthless.
 *
 * The price paths are deterministic pseudo-random walks. Determinism matters
 * more than variety here: a failing seed must be reproducible, and the
 * repository's fabrication guard forbids Math.random outright.
 */

const INSTRUMENTS = ['NQ', 'ES', 'GC', 'CL', 'MNQ'].map((r) => requireInstrument(r));
const T0 = 1_700_000_000_000;

/** Linear congruential generator: reproducible, and not a market data source. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface Observation {
  readonly snapshot: MarketSnapshot;
  /** Every price the market is known to have reached in this observation. */
  readonly lowTicks: number;
  readonly highTicks: number;
}

/**
 * Build a price path of alternating quote and bar observations, so both code
 * paths are exercised and the bar's extremes are genuinely outside the sampled
 * quotes — exactly the situation that tempts a simulator into a bad fill.
 */
function buildPath(spec: InstrumentSpec, seed: number, steps: number): Observation[] {
  const next = rng(seed);
  let priceTicks = priceToTicks(spec, 100) * 100;
  const out: Observation[] = [];

  for (let i = 0; i < steps; i += 1) {
    const drift = Math.round((next() - 0.5) * 30);
    const open = priceTicks;
    const close = Math.max(1, open + drift);
    const spread = Math.abs(Math.round((next() - 0.5) * 40)) + 1;
    const high = Math.max(open, close) + spread;
    const low = Math.max(1, Math.min(open, close) - spread);
    priceTicks = close;

    const ts = T0 + i * 60_000;
    if (i % 2 === 0) {
      out.push({
        snapshot: {
          symbol: spec.root,
          exchangeTs: ts,
          lastTicks: close,
          bidTicks: null,
          askTicks: null,
          bar: {
            startTs: ts,
            endTs: ts + 60_000,
            openTicks: open,
            highTicks: high,
            lowTicks: low,
            closeTicks: close,
            volume: 100,
          },
        },
        lowTicks: Math.min(low, close),
        highTicks: Math.max(high, close),
      });
    } else {
      out.push({
        snapshot: {
          symbol: spec.root,
          exchangeTs: ts,
          lastTicks: close,
          bidTicks: null,
          askTicks: null,
          bar: null,
        },
        lowTicks: close,
        highTicks: close,
      });
    }
  }
  return out;
}

interface Scenario {
  readonly spec: InstrumentSpec;
  readonly env: SimulationEnvironment;
  readonly orders: EngineOrder[];
  readonly path: Observation[];
}

function buildScenario(seed: number): Scenario {
  const next = rng(seed * 7919 + 13);
  const spec = INSTRUMENTS[Math.floor(next() * INSTRUMENTS.length)]!;
  const path = buildPath(spec, seed, 40);
  const start = path[0]!.snapshot.lastTicks!;

  const env: SimulationEnvironment = {
    ...(next() > 0.5 ? DEFAULT_ENVIRONMENT : FRICTIONLESS_ENVIRONMENT),
    latencyMs: 0,
    useBarRange: next() > 0.2,
    requireThroughTradeForLimit: next() > 0.5,
    maxContractsPerFill: next() > 0.6 ? 1 + Math.floor(next() * 3) : null,
    marketSlippageTicks: Math.floor(next() * 3),
    stopSlippageTicks: Math.floor(next() * 3),
    feesEnabled: next() > 0.5,
  };

  const types = ['MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT', 'TRAILING_STOP'] as const;
  const orders: EngineOrder[] = [];
  const count = 1 + Math.floor(next() * 4);

  for (let i = 0; i < count; i += 1) {
    const type = types[Math.floor(next() * types.length)]!;
    const side = next() > 0.5 ? 'BUY' : 'SELL';
    const offset = Math.round((next() - 0.5) * 120);
    const qty = 1 + Math.floor(next() * 4);

    orders.push(
      createOrder(
        {
          id: `s${seed}-${i}`,
          accountId: 'acct',
          clientOrderId: `s${seed}-${i}`,
          symbol: spec.root,
          side,
          qty,
          type,
          limitTicks: type === 'LIMIT' || type === 'STOP_LIMIT' ? start + offset : null,
          stopTicks: type === 'STOP_MARKET' || type === 'STOP_LIMIT' ? start + offset : null,
          trailTicks: type === 'TRAILING_STOP' ? 1 + Math.floor(next() * 40) : null,
          ocoGroupId: count > 1 && next() > 0.5 ? `g${seed}` : null,
          now: T0,
        },
        env,
      ),
    );
  }

  return { spec, env, orders, path };
}

interface Violation {
  readonly seed: number;
  readonly message: string;
}

function runScenario(seed: number): Violation[] {
  const { spec, env, orders, path } = buildScenario(seed);
  const violations: Violation[] = [];
  const fail = (message: string): void => {
    violations.push({ seed, message });
  };

  let current = orders;
  let position: PositionState = flatPosition(spec.root);
  let cashMicros = 0;
  const filledByOco = new Map<string, number>();
  /** Largest single leg in each OCO group: the quantity the group protects. */
  const ocoCover = new Map<string, number>();
  for (const o of orders) {
    if (!o.ocoGroupId) continue;
    ocoCover.set(o.ocoGroupId, Math.max(ocoCover.get(o.ocoGroupId) ?? 0, o.qty));
  }
  const orderTotals = new Map<string, number>();

  let previousLow = path[0]!.lowTicks;
  let previousHigh = path[0]!.highTicks;
  // Running extremes since the orders went live.
  let sessionLow = path[0]!.lowTicks;
  let sessionHigh = path[0]!.highTicks;

  for (const observation of path) {
    // Extend the session range BEFORE evaluating: a fill against this
    // observation is obviously allowed to use this observation's prices.
    sessionLow = Math.min(sessionLow, observation.lowTicks);
    sessionHigh = Math.max(sessionHigh, observation.highTicks);

    const before = new Map(current.map((o) => [o.id, o]));
    const result = matchOrders(
      { spec, env, market: observation.snapshot, now: observation.snapshot.exchangeTs },
      current.filter((o) => o.status === 'WORKING' || o.status === 'PARTIALLY_FILLED'),
      position,
    );

    const slipAllowance = Math.max(env.marketSlippageTicks, env.stopSlippageTicks);

    for (const fill of result.fills) {
      const order = before.get(fill.orderId)!;

      // --- 1. A fill may only happen at a price the market reached ---------
      //
      // Two bounds, because resting and immediate orders are constrained
      // differently:
      //
      //   - ANY fill must lie inside the range the market has covered since the
      //     orders went live. A price never traded is fabrication, full stop.
      //   - An order that executes AGAINST this observation (a market order, or
      //     a stop electing now) is additionally bound to the span between the
      //     previous observation and this one, because it is being filled by
      //     current prices rather than by a price it has been resting at.
      //
      // A resting limit is exempt from the second bound: it can sit at its
      // price through many observations and still fill there, which is exactly
      // what a limit order is.
      const sessionLowBound = sessionLow - slipAllowance;
      const sessionHighBound = sessionHigh + slipAllowance;
      if (fill.priceTicks < sessionLowBound || fill.priceTicks > sessionHighBound) {
        fail(
          `fill for ${order.type} ${order.side} at ${fill.priceTicks} is outside every price ` +
            `traded so far [${sessionLowBound}, ${sessionHighBound}] (${fill.reason})`,
        );
      }

      const immediate = order.type === 'MARKET' || fill.reason === 'stop elected';
      if (immediate) {
        const lowBound = Math.min(previousLow, observation.lowTicks) - slipAllowance;
        const highBound = Math.max(previousHigh, observation.highTicks) + slipAllowance;
        if (fill.priceTicks < lowBound || fill.priceTicks > highBound) {
          fail(
            `immediate fill for ${order.type} ${order.side} at ${fill.priceTicks} is outside the ` +
              `current span [${lowBound}, ${highBound}] (${fill.reason})`,
          );
        }
      }

      // --- 2. A limit never fills worse than its price ---------------------
      if (order.type === 'LIMIT' && order.limitTicks !== null) {
        const worse =
          order.side === 'BUY' ? fill.priceTicks > order.limitTicks : fill.priceTicks < order.limitTicks;
        if (worse) {
          fail(`limit ${order.side} filled at ${fill.priceTicks}, worse than its limit ${order.limitTicks}`);
        }
      }

      // --- 3. A stop-limit never fills worse than its limit either ---------
      if (order.type === 'STOP_LIMIT' && order.limitTicks !== null) {
        const worse =
          order.side === 'BUY' ? fill.priceTicks > order.limitTicks : fill.priceTicks < order.limitTicks;
        if (worse) {
          fail(`stop-limit ${order.side} filled at ${fill.priceTicks}, worse than limit ${order.limitTicks}`);
        }
      }

      // --- 4. Quantities stay inside the order -----------------------------
      const total = (orderTotals.get(order.id) ?? 0) + fill.qty;
      orderTotals.set(order.id, total);
      if (total > order.qty) fail(`order ${order.id} filled ${total} of ${order.qty}`);
      if (fill.qty <= 0) fail(`non-positive fill qty ${fill.qty}`);
      if (!Number.isInteger(fill.qty)) fail(`fractional fill qty ${fill.qty}`);

      // --- 5. Liquidity cap is respected -----------------------------------
      if (env.maxContractsPerFill !== null && fill.qty > env.maxContractsPerFill) {
        fail(`fill qty ${fill.qty} exceeds liquidity cap ${env.maxContractsPerFill}`);
      }

      // --- 6. OCO: the group may never exit more than it covers ------------
      //
      // Not "only one leg may trade": a stop taking 1 of 3 and the target
      // taking the remaining 2 is correct. What must never happen is the group
      // trading MORE than the quantity it was created to protect, which is how
      // a bracket flips an account short.
      if (order.ocoGroupId) {
        const filledSoFar = (filledByOco.get(order.ocoGroupId) ?? 0) + fill.qty;
        filledByOco.set(order.ocoGroupId, filledSoFar);
        const cover = ocoCover.get(order.ocoGroupId) ?? 0;
        if (filledSoFar > cover) {
          fail(`OCO group ${order.ocoGroupId} filled ${filledSoFar}, exceeding its cover of ${cover}`);
        }
      }

      // Independent cash ledger, entirely outside the engine.
      const signed = order.side === 'BUY' ? fill.qty : -fill.qty;
      cashMicros -= fill.priceTicks * signed * spec.tickValueMicros;
      cashMicros -= fill.feesMicros;

      position = applyFill(spec, position, {
        signedQty: signed,
        priceTicks: fill.priceTicks,
        feesMicros: fill.feesMicros,
        exchangeTs: observation.snapshot.exchangeTs,
      }).position;
    }

    // --- 7. An OCO group never has more open exposure than it covers -------
    const groupExposure = new Map<string, number>();
    for (const o of result.orders) {
      if (!o.ocoGroupId) continue;
      const traded = o.filledQty;
      groupExposure.set(o.ocoGroupId, (groupExposure.get(o.ocoGroupId) ?? 0) + traded);
    }
    for (const [group, traded] of groupExposure) {
      const cover = ocoCover.get(group) ?? 0;
      if (traded > cover) fail(`OCO group ${group} has traded ${traded} against a cover of ${cover}`);
    }

    // --- 8. Engine position must agree with the independent replay ---------
    if (result.position.qty !== position.qty) {
      fail(`engine position ${result.position.qty} disagrees with replay ${position.qty}`);
    }

    // --- 9. Order bookkeeping stays coherent -------------------------------
    for (const o of result.orders) {
      if (o.filledQty > o.qty) fail(`order ${o.id} filledQty ${o.filledQty} exceeds qty ${o.qty}`);
      if (o.status === 'FILLED' && o.filledQty !== o.qty) {
        fail(`order ${o.id} is FILLED with ${o.filledQty}/${o.qty}`);
      }
      if (o.status === 'PARTIALLY_FILLED' && remainingQty(o) <= 0) {
        fail(`order ${o.id} is PARTIALLY_FILLED with nothing remaining`);
      }
    }

    position = result.position;
    current = result.orders as EngineOrder[];
    previousLow = observation.lowTicks;
    previousHigh = observation.highTicks;
  }

  // --- 10. Flatten and reconcile against the independent ledger ------------
  const lastPrice = path[path.length - 1]!.snapshot.lastTicks!;
  if (position.qty !== 0) {
    cashMicros -= lastPrice * -position.qty * spec.tickValueMicros;
    position = applyFill(spec, position, {
      signedQty: -position.qty,
      priceTicks: lastPrice,
      feesMicros: 0,
      exchangeTs: T0,
    }).position;
  }
  const engineNet = position.realizedPnlMicros - position.feesMicros;
  if (engineNet !== cashMicros) {
    fail(`net P&L ${engineNet} disagrees with the cash ledger ${cashMicros}`);
  }
  if (position.costBasisMicros !== 0) {
    fail(`flat position retains a cost basis of ${position.costBasisMicros}`);
  }

  return violations;
}

describe('engine stress: no impossible fills', () => {
  it('holds every invariant across 5000 randomized scenarios', () => {
    const violations: Violation[] = [];
    for (let seed = 1; seed <= 5000; seed += 1) {
      violations.push(...runScenario(seed));
    }
    const sample = violations.slice(0, 12).map((v) => `seed ${v.seed}: ${v.message}`);
    expect(violations.length, `\n${sample.join('\n')}\n`).toBe(0);
  });

  it('never fills a buy below the session low or a sell above the session high', () => {
    // A narrower, sharper version of invariant 1, with slippage disabled so the
    // bound is exact.
    const spec = requireInstrument('NQ');
    const env: SimulationEnvironment = { ...FRICTIONLESS_ENVIRONMENT, requireThroughTradeForLimit: false };
    let violations = 0;

    for (let seed = 1; seed <= 150; seed += 1) {
      const path = buildPath(spec, seed, 30);
      const start = path[0]!.snapshot.lastTicks!;
      const sessionLow = Math.min(...path.map((p) => p.lowTicks));
      const sessionHigh = Math.max(...path.map((p) => p.highTicks));

      let orders = [
        createOrder({ id: 'a', accountId: 'x', clientOrderId: 'a', symbol: spec.root, side: 'BUY',
          qty: 2, type: 'LIMIT', limitTicks: start - 30, now: T0 }, env),
        createOrder({ id: 'b', accountId: 'x', clientOrderId: 'b', symbol: spec.root, side: 'SELL',
          qty: 2, type: 'STOP_MARKET', stopTicks: start - 60, now: T0 }, env),
      ];
      let position = flatPosition(spec.root);

      for (const observation of path) {
        const r = matchOrders(
          { spec, env, market: observation.snapshot, now: observation.snapshot.exchangeTs },
          orders.filter((o) => o.status === 'WORKING' || o.status === 'PARTIALLY_FILLED'),
          position,
        );
        for (const fill of r.fills) {
          // Bounded by the whole session, so an inter-sample fill is fine but a
          // price the session never visited is not.
          if (fill.priceTicks < sessionLow || fill.priceTicks > sessionHigh) violations += 1;
        }
        orders = r.orders as EngineOrder[];
        position = r.position;
      }
    }
    expect(violations).toBe(0);
  });

  it('cannot fill an order the market never reached', () => {
    // A limit far outside every price in the path must never fill.
    const spec = requireInstrument('ES');
    const env = { ...FRICTIONLESS_ENVIRONMENT, requireThroughTradeForLimit: false };
    for (let seed = 1; seed <= 100; seed += 1) {
      const path = buildPath(spec, seed, 25);
      const sessionLow = Math.min(...path.map((p) => p.lowTicks));
      let orders = [
        createOrder({ id: 'far', accountId: 'x', clientOrderId: 'far', symbol: spec.root, side: 'BUY',
          qty: 1, type: 'LIMIT', limitTicks: sessionLow - 500, now: T0 }, env),
      ];
      let position = flatPosition(spec.root);
      let fills = 0;
      for (const observation of path) {
        const r = matchOrders(
          { spec, env, market: observation.snapshot, now: observation.snapshot.exchangeTs },
          orders.filter((o) => o.status === 'WORKING'),
          position,
        );
        fills += r.fills.length;
        orders = r.orders as EngineOrder[];
        position = r.position;
      }
      expect(fills, `seed ${seed}`).toBe(0);
    }
  });
});
