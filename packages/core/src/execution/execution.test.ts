import { describe, expect, it } from 'vitest';
import { requireInstrument, priceToTicks, MICROS } from '@atlas/instruments';
import { flatPosition, avgEntryTicks, type PositionState } from '../position/position.js';
import {
  DEFAULT_ENVIRONMENT,
  FRICTIONLESS_ENVIRONMENT,
  normalizeEnvironment,
  type SimulationEnvironment,
} from './environment.js';
import { createOrder, modifyOrder, expiresOnTradingDate } from './orders.js';
import { matchOrders, type MatchContext } from './matching.js';
import { avgFillTicks, type EngineOrder, type MarketSnapshot } from './types.js';

const NQ = requireInstrument('NQ');
const T0 = 1_700_000_000_000;
const px = (p: number): number => priceToTicks(NQ, p);

let counter = 0;
function order(partial: Partial<Parameters<typeof createOrder>[0]> = {}, env = FRICTIONLESS_ENVIRONMENT): EngineOrder {
  counter += 1;
  return createOrder(
    {
      id: `o${counter}`,
      accountId: 'acct',
      clientOrderId: `c${counter}`,
      symbol: 'NQ',
      side: 'BUY',
      qty: 1,
      type: 'MARKET',
      now: T0,
      ...partial,
    },
    env,
  );
}

function quote(last: number, ts = T0): MarketSnapshot {
  return { symbol: 'NQ', exchangeTs: ts, lastTicks: px(last), bidTicks: null, askTicks: null, bar: null };
}

function barSnap(o: number, h: number, l: number, c: number, ts = T0, volume = 100): MarketSnapshot {
  return {
    symbol: 'NQ',
    exchangeTs: ts,
    lastTicks: px(c),
    bidTicks: null,
    askTicks: null,
    bar: {
      startTs: ts,
      endTs: ts + 60_000,
      openTicks: px(o),
      highTicks: px(h),
      lowTicks: px(l),
      closeTicks: px(c),
      volume,
    },
  };
}

/**
 * An order that was already working when the bar in question opened.
 *
 * A bar may only fill an order that existed before it, so a test that hands a
 * freshly created order straight to a bar has to say when that order started
 * working - exactly as the engine does on the pass before.
 */
function resting(o: EngineOrder, since = T0): EngineOrder {
  return { ...o, restedMarketTs: since };
}

function ctx(market: MarketSnapshot, env: SimulationEnvironment = FRICTIONLESS_ENVIRONMENT): MatchContext {
  return { spec: NQ, env, market, now: market.exchangeTs };
}

function run(
  orders: EngineOrder[],
  market: MarketSnapshot,
  env: SimulationEnvironment = FRICTIONLESS_ENVIRONMENT,
  position: PositionState = flatPosition('NQ'),
) {
  return matchOrders(ctx(market, env), orders, position);
}

// ---------------------------------------------------------------- market ---

describe('market orders', () => {
  it('fills at the available price', () => {
    const r = run([order({ type: 'MARKET', qty: 2 })], quote(20_000));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.priceTicks).toBe(px(20_000));
    expect(r.position.qty).toBe(2);
    expect(r.orders[0]!.status).toBe('FILLED');
  });

  it('does NOT fill when no market price is known', () => {
    const blank: MarketSnapshot = {
      symbol: 'NQ', exchangeTs: T0, lastTicks: null, bidTicks: null, askTicks: null, bar: null,
    };
    const r = run([order({ type: 'MARKET' })], blank);
    expect(r.fills).toHaveLength(0);
    expect(r.orders[0]!.status).toBe('WORKING');
  });

  it('crosses the spread when a book exists', () => {
    const withBook: MarketSnapshot = {
      symbol: 'NQ', exchangeTs: T0, lastTicks: px(20_000),
      bidTicks: px(19_999.75), askTicks: px(20_000.25), bar: null,
    };
    const buy = run([order({ side: 'BUY' })], withBook);
    expect(buy.fills[0]!.priceTicks).toBe(px(20_000.25));
    const sell = run([order({ side: 'SELL' })], withBook);
    expect(sell.fills[0]!.priceTicks).toBe(px(19_999.75));
  });

  it('applies slippage against the order under the advanced model', () => {
    const env = { ...DEFAULT_ENVIRONMENT, latencyMs: 0, marketSlippageTicks: 2 };
    const buy = run([order({ side: 'BUY' }, env)], quote(20_000), env);
    expect(buy.fills[0]!.priceTicks).toBe(px(20_000) + 2);
    const sell = run([order({ side: 'SELL' }, env)], quote(20_000), env);
    expect(sell.fills[0]!.priceTicks).toBe(px(20_000) - 2);
  });

  it('holds an order until its latency has elapsed', () => {
    const env = { ...DEFAULT_ENVIRONMENT, latencyMs: 500, marketSlippageTicks: 0 };
    const o = order({ type: 'MARKET' }, env);
    const early = matchOrders({ spec: NQ, env, market: quote(20_000, T0 + 100), now: T0 + 100 }, [o], flatPosition('NQ'));
    expect(early.fills).toHaveLength(0);
    const late = matchOrders({ spec: NQ, env, market: quote(20_000, T0 + 600), now: T0 + 600 }, [o], flatPosition('NQ'));
    expect(late.fills).toHaveLength(1);
  });
});

// ----------------------------------------------------------------- limit ---

describe('limit orders', () => {
  it('fills at the market price when marketable on arrival', () => {
    // A buy limit at 20010 with the market at 20000 is marketable: it should
    // pay 20000, not 20010.
    const r = run([order({ type: 'LIMIT', side: 'BUY', limitTicks: px(20_010) })], quote(20_000));
    expect(r.fills[0]!.priceTicks).toBe(px(20_000));
    expect(r.fills[0]!.liquidity).toBe('TAKER');
  });

  it('rests when the market is away, and fills at its own price later', () => {
    const env = { ...FRICTIONLESS_ENVIRONMENT, requireThroughTradeForLimit: false };
    const o = order({ type: 'LIMIT', side: 'BUY', limitTicks: px(19_990) }, env);
    const first = run([o], quote(20_000), env);
    expect(first.fills).toHaveLength(0);
    expect(first.orders[0]!.hasRested).toBe(true);

    const second = run(first.orders as EngineOrder[], quote(19_990), env);
    expect(second.fills).toHaveLength(1);
    expect(second.fills[0]!.priceTicks).toBe(px(19_990));
    expect(second.fills[0]!.liquidity).toBe('MAKER');
  });

  /**
   * The regression that matters: a limit that has been resting must not be
   * handed the market price when the market runs past it.
   */
  it('does not award a resting limit the market price when price runs past it', () => {
    const env = { ...FRICTIONLESS_ENVIRONMENT, requireThroughTradeForLimit: false };
    const o = order({ type: 'LIMIT', side: 'BUY', limitTicks: px(20_000) }, env);
    const rested = run([o], quote(20_050), env);
    expect(rested.fills).toHaveLength(0);

    // Price collapses well below the limit on a QUOTE (no bar, so no gap logic).
    const filled = run(rested.orders as EngineOrder[], quote(19_900), env);
    expect(filled.fills).toHaveLength(1);
    // It fills at 20000 — the price it asked for — not at 19900.
    expect(filled.fills[0]!.priceTicks).toBe(px(20_000));
  });

  it('requires a trade through the limit by default', () => {
    const env = { ...DEFAULT_ENVIRONMENT, latencyMs: 0 };
    const o = order({ type: 'LIMIT', side: 'BUY', limitTicks: px(20_000) }, env);
    const rested = run([o], quote(20_050), env);
    // Touching exactly is not enough under the conservative default: the queue
    // at that price may have absorbed everything.
    const touched = run(rested.orders as EngineOrder[], barSnap(20_010, 20_010, 20_000, 20_005), env);
    expect(touched.fills).toHaveLength(0);
    // Trading through it is.
    const through = run(rested.orders as EngineOrder[], barSnap(20_010, 20_010, 19_999.75, 20_005), env);
    expect(through.fills).toHaveLength(1);
  });

  it('gives a resting limit the open when the market gaps through it', () => {
    // Buy limit at 20000; the bar opens at 19950 — the exchange fills at 19950.
    const o = order({ type: 'LIMIT', side: 'BUY', limitTicks: px(20_000) });
    const rested = run([o], quote(20_050));
    const gapped = run(rested.orders as EngineOrder[], barSnap(19_950, 19_960, 19_940, 19_955));
    expect(gapped.fills[0]!.priceTicks).toBe(px(19_950));
    expect(gapped.fills[0]!.reason).toBe('limit gapped through');
  });

  it('never fills a sell limit below its price', () => {
    const o = order({ type: 'LIMIT', side: 'SELL', limitTicks: px(20_100) });
    const rested = run([o], quote(20_000));
    const r = run(rested.orders as EngineOrder[], barSnap(20_010, 20_090, 20_005, 20_080));
    expect(r.fills).toHaveLength(0);
  });
});

// ------------------------------------------------------- bar eligibility ---

describe('bars may only fill orders that existed before them', () => {
  it('refuses a bar that opened before the order started resting', () => {
    // The order rests at 10:01:00 of market time. The bar on offer opened a
    // minute earlier: its low is a price that traded before the order was sent.
    const o = order({ type: 'LIMIT', side: 'BUY', limitTicks: px(20_000) });
    const rested = run([o], quote(20_050, T0 + 60_000));
    expect((rested.orders[0] as EngineOrder).restedMarketTs).toBe(T0 + 60_000);

    const stale = run(rested.orders as EngineOrder[], barSnap(20_010, 20_010, 19_900, 20_005, T0));
    expect(stale.fills).toHaveLength(0);
  });

  it('accepts a bar that opened once the order was already working', () => {
    const o = order({ type: 'LIMIT', side: 'BUY', limitTicks: px(20_000) });
    const rested = run([o], quote(20_050, T0));
    const fresh = run(
      rested.orders as EngineOrder[],
      barSnap(20_010, 20_010, 19_900, 20_005, T0 + 60_000),
    );
    expect(fresh.fills).toHaveLength(1);
    expect(fresh.fills[0]!.priceTicks).toBe(px(20_000));
  });

  it('does not let a stale bar elect a stop', () => {
    const o = order({ type: 'STOP_MARKET', side: 'SELL', stopTicks: px(19_990) });
    // Resting at T0+60s; the bar that follows belongs to the minute before it.
    const rested = run([o], quote(20_050, T0 + 60_000));
    const stale = run(rested.orders as EngineOrder[], barSnap(20_010, 20_010, 19_900, 20_005, T0));
    expect(stale.fills).toHaveLength(0);
    expect(stale.orders[0]!.status).toBe('WORKING');
  });

  it('an order created into the market it can see keeps its own timestamp', () => {
    // A bracket leg is born at the moment its entry filled, and the bar that
    // opens at that same instant is one it was live for.
    const o = { ...order({ type: 'LIMIT', side: 'SELL', limitTicks: px(20_100) }), restedMarketTs: T0 };
    const r = run([o], barSnap(20_050, 20_150, 20_040, 20_060, T0));
    expect(r.fills).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ stop ---

describe('stop orders', () => {
  it('a sell stop triggers when price trades down to it', () => {
    const o = order({ type: 'STOP_MARKET', side: 'SELL', stopTicks: px(19_990) });
    const above = run([o], quote(20_000));
    expect(above.fills).toHaveLength(0);
    const hit = run(above.orders as EngineOrder[], quote(19_990));
    expect(hit.fills).toHaveLength(1);
    expect(hit.fills[0]!.priceTicks).toBe(px(19_990));
  });

  it('a buy stop triggers above the market', () => {
    const o = order({ type: 'STOP_MARKET', side: 'BUY', stopTicks: px(20_010) });
    expect(run([o], quote(20_000)).fills).toHaveLength(0);
    expect(run([o], quote(20_010)).fills).toHaveLength(1);
  });

  /** A stop that gaps must fill at the gap, not at the stop price. */
  it('fills a gapped sell stop at the open, not at the stop', () => {
    const o = order({ type: 'STOP_MARKET', side: 'SELL', stopTicks: px(19_990) });
    const rested = run([o], quote(20_000));
    // Next bar opens far below the stop.
    const gapped = run(rested.orders as EngineOrder[], barSnap(19_900, 19_910, 19_880, 19_905));
    expect(gapped.fills[0]!.priceTicks).toBe(px(19_900));
  });

  it('fills at the stop when the bar merely traded through it', () => {
    const o = order({ type: 'STOP_MARKET', side: 'SELL', stopTicks: px(19_990) });
    const rested = run([o], quote(20_000));
    // Opened above the stop, dipped through, closed well below: election is at
    // the stop, not at the bar close.
    const traversed = run(rested.orders as EngineOrder[], barSnap(20_000, 20_005, 19_950, 19_960));
    expect(traversed.fills[0]!.priceTicks).toBe(px(19_990));
  });

  it('adds stop slippage under the advanced model', () => {
    const env = { ...DEFAULT_ENVIRONMENT, latencyMs: 0, stopSlippageTicks: 3 };
    const o = order({ type: 'STOP_MARKET', side: 'SELL', stopTicks: px(19_990) }, env);
    const r = run([o], quote(19_990), env);
    expect(r.fills[0]!.priceTicks).toBe(px(19_990) - 3);
  });

  it('a stop-limit elected mid-bar fills at its limit, never at the bar open', () => {
    // The bar opens at 19,995 — ABOVE the 19,990 stop — so the order was still
    // a dormant stop at the open. It elects as price falls through 19,990 and
    // then trades through the 19,985 limit, so the limit is where it fills.
    const env = { ...FRICTIONLESS_ENVIRONMENT, requireThroughTradeForLimit: false };
    const o = order(
      { type: 'STOP_LIMIT', side: 'SELL', stopTicks: px(19_990), limitTicks: px(19_985) },
      env,
    );
    const r = run([resting(o)], barSnap(19_995, 19_995, 19_960, 19_965), env);
    expect(r.orders[0]!.stopTriggered).toBe(true);
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.priceTicks).toBe(px(19_985));
    expect(r.fills[0]!.priceTicks).not.toBe(px(19_995));
  });

  it('a stop-limit whose limit is unreachable in the election bar waits', () => {
    const env = { ...FRICTIONLESS_ENVIRONMENT, requireThroughTradeForLimit: false };
    // Limit ABOVE the stop: sell no lower than 19,995 once 19,990 trades. The
    // election bar never returns that high, so nothing fills yet.
    const o = order(
      { type: 'STOP_LIMIT', side: 'SELL', stopTicks: px(19_990), limitTicks: px(19_995) },
      env,
    );
    const elected = run([resting(o)], barSnap(19_992, 19_993, 19_960, 19_965), env);
    expect(elected.orders[0]!.stopTriggered).toBe(true);
    expect(elected.fills).toHaveLength(0);

    // A later bounce back to the limit does fill it: the bound applied only to
    // the observation in which election happened.
    const bounced = run(elected.orders as EngineOrder[], quote(19_995), env);
    expect(bounced.fills).toHaveLength(1);
    expect(bounced.fills[0]!.priceTicks).toBe(px(19_995));
  });

  it('a stop-limit that gaps past its limit does not fill', () => {
    // This is the whole point of a stop-limit: protection from a bad fill, at
    // the cost of possibly no fill at all.
    const o = order({ type: 'STOP_LIMIT', side: 'SELL', stopTicks: px(19_990), limitTicks: px(19_985) });
    const gapped = run([resting(o)], barSnap(19_900, 19_905, 19_890, 19_895));
    expect(gapped.orders[0]!.stopTriggered).toBe(true);
    expect(gapped.fills).toHaveLength(0);
    expect(gapped.orders[0]!.status).toBe('WORKING');
  });
});

// -------------------------------------------------------- trailing stops ---

describe('trailing stops', () => {
  it('follows the high and fills when price retraces by the trail distance', () => {
    const o = order({ type: 'TRAILING_STOP', side: 'SELL', trailTicks: 20 });
    let orders = run([o], quote(20_000)).orders as EngineOrder[];
    expect(orders[0]!.trailAnchorTicks).toBe(px(20_000));

    // Price rallies: the anchor follows, the stop rises with it.
    orders = run(orders, quote(20_010)).orders as EngineOrder[];
    expect(orders[0]!.trailAnchorTicks).toBe(px(20_010));
    expect(orders[0]!.stopTicks).toBe(px(20_010) - 20);

    // A small pullback that does not reach the stop leaves it alone.
    const shallow = run(orders, quote(20_008));
    expect(shallow.fills).toHaveLength(0);
    expect((shallow.orders[0] as EngineOrder).trailAnchorTicks).toBe(px(20_010));

    // A pullback of the full distance fills.
    const deep = run(shallow.orders as EngineOrder[], quote(20_005));
    expect(deep.fills).toHaveLength(1);
  });

  it('never trails backwards', () => {
    const o = order({ type: 'TRAILING_STOP', side: 'SELL', trailTicks: 40 });
    let orders = run([o], quote(20_020)).orders as EngineOrder[];
    orders = run(orders, quote(20_000)).orders as EngineOrder[];
    // Anchor stays at the high even though price fell.
    expect(orders[0]!.trailAnchorTicks).toBe(px(20_020));
  });

  it('re-anchors when the trail distance is modified', () => {
    const o = order({ type: 'TRAILING_STOP', side: 'SELL', trailTicks: 20 });
    const orders = run([o], quote(20_000)).orders as EngineOrder[];
    const modified = modifyOrder(orders[0]!, { trailTicks: 40 }, T0);
    expect(modified.ok).toBe(true);
    expect(modified.order.trailAnchorTicks).toBeNull();
  });
});

// -------------------------------------------------------------- brackets ---

describe('OCO and brackets', () => {
  function bracketPair(env = FRICTIONLESS_ENVIRONMENT) {
    const stop = order(
      { type: 'STOP_MARKET', side: 'SELL', qty: 2, stopTicks: px(19_980), ocoGroupId: 'g1', bracketRole: 'STOP_LOSS' },
      env,
    );
    const target = order(
      { type: 'LIMIT', side: 'SELL', qty: 2, limitTicks: px(20_040), ocoGroupId: 'g1', bracketRole: 'TAKE_PROFIT' },
      env,
    );
    return [stop, target];
  }

  it('cancels the target when the stop fills', () => {
    const position = { ...flatPosition('NQ'), qty: 2, costBasisMicros: px(20_000) * 2 * NQ.tickValueMicros };
    const r = run(bracketPair(), quote(19_980), FRICTIONLESS_ENVIRONMENT, position);
    expect(r.fills).toHaveLength(1);
    expect(r.canceledByOco).toHaveLength(1);
    const target = r.orders.find((o) => o.bracketRole === 'TAKE_PROFIT')!;
    expect(target.status).toBe('CANCELED');
    expect(r.position.qty).toBe(0);
  });

  it('cancels the stop when the target fills', () => {
    const position = { ...flatPosition('NQ'), qty: 2, costBasisMicros: px(20_000) * 2 * NQ.tickValueMicros };
    const orders = bracketPair();
    const rested = run(orders, quote(20_000), FRICTIONLESS_ENVIRONMENT, position);
    const r = run(rested.orders as EngineOrder[], quote(20_050), FRICTIONLESS_ENVIRONMENT, position);
    expect(r.fills).toHaveLength(1);
    const stop = r.orders.find((o) => o.bracketRole === 'STOP_LOSS')!;
    expect(stop.status).toBe('CANCELED');
  });

  /**
   * The ambiguity case. One bar's range contains BOTH the stop and the target.
   * The sequence is unknowable, so the engine must take the loss.
   */
  it('takes the stop when one bar spans both the stop and the target', () => {
    const position = { ...flatPosition('NQ'), qty: 2, costBasisMicros: px(20_000) * 2 * NQ.tickValueMicros };
    const orders = bracketPair();
    const rested = run(orders, quote(20_000), FRICTIONLESS_ENVIRONMENT, position);

    // A wild bar: low 19960 (below the stop), high 20060 (above the target).
    const r = run(rested.orders as EngineOrder[], barSnap(20_000, 20_060, 19_960, 20_050), FRICTIONLESS_ENVIRONMENT, position);

    expect(r.fills).toHaveLength(1);
    const filledOrder = r.orders.find((o) => o.id === r.fills[0]!.orderId)!;
    expect(filledOrder.bracketRole).toBe('STOP_LOSS');
    expect(r.realizedPnlMicros).toBeLessThan(0);
  });

  it('never lets both sides of an OCO fill on the same observation', () => {
    const position = { ...flatPosition('NQ'), qty: 2, costBasisMicros: px(20_000) * 2 * NQ.tickValueMicros };
    const rested = run(bracketPair(), quote(20_000), FRICTIONLESS_ENVIRONMENT, position);
    const r = run(rested.orders as EngineOrder[], barSnap(20_000, 20_060, 19_960, 20_050), FRICTIONLESS_ENVIRONMENT, position);
    const filledCount = r.orders.filter((o) => o.status === 'FILLED').length;
    expect(filledCount).toBe(1);
    // ...and the position cannot go short through a double exit.
    expect(r.position.qty).toBe(0);
  });
});

// -------------------------------------------------------- partial fills ----

describe('partial fills', () => {
  it('fills up to the configured liquidity cap and stays working', () => {
    const env = { ...FRICTIONLESS_ENVIRONMENT, maxContractsPerFill: 2 };
    const o = order({ type: 'MARKET', qty: 5 }, env);
    const first = run([o], quote(20_000), env);
    expect(first.fills[0]!.qty).toBe(2);
    expect(first.orders[0]!.status).toBe('PARTIALLY_FILLED');
    expect(first.orders[0]!.filledQty).toBe(2);
    expect(first.position.qty).toBe(2);

    const second = run(first.orders as EngineOrder[], quote(20_001), env);
    expect(second.orders[0]!.filledQty).toBe(4);
    const third = run(second.orders as EngineOrder[], quote(20_002), env);
    expect(third.orders[0]!.status).toBe('FILLED');
    expect(third.orders[0]!.filledQty).toBe(5);
  });

  it('tracks a weighted average fill price across partials', () => {
    const env = { ...FRICTIONLESS_ENVIRONMENT, maxContractsPerFill: 1 };
    let orders = [order({ type: 'MARKET', qty: 2 }, env)];
    let position = flatPosition('NQ');
    const r1 = run(orders, quote(20_000), env, position);
    orders = r1.orders as EngineOrder[];
    position = r1.position;
    const r2 = run(orders, quote(20_010), env, position);

    const done = r2.orders[0]!;
    expect(done.status).toBe('FILLED');
    const avg = avgFillTicks(done, NQ.tickValueMicros)!;
    expect(avg).toBeCloseTo((px(20_000) + px(20_010)) / 2, 9);
  });
});

// --------------------------------------------------------------- modify ----

describe('modification', () => {
  it('moves a resting limit and resets its queue position', () => {
    const o = order({ type: 'LIMIT', side: 'BUY', limitTicks: px(19_990) });
    const rested = run([o], quote(20_000)).orders[0] as EngineOrder;
    expect(rested.hasRested).toBe(true);
    const m = modifyOrder(rested, { limitTicks: px(19_995) }, T0 + 1);
    expect(m.ok).toBe(true);
    expect(m.order.limitTicks).toBe(px(19_995));
    expect(m.order.hasRested).toBe(false);
    expect(m.order.version).toBe(rested.version + 1);
  });

  it('refuses to shrink an order below what has already filled', () => {
    const env = { ...FRICTIONLESS_ENVIRONMENT, maxContractsPerFill: 2 };
    const o = order({ type: 'MARKET', qty: 5 }, env);
    const partial = run([o], quote(20_000), env).orders[0] as EngineOrder;
    expect(partial.filledQty).toBe(2);
    const m = modifyOrder(partial, { qty: 1 }, T0 + 1);
    expect(m.ok).toBe(false);
    expect(m.reason).toBe('QUANTITY_BELOW_FILLED');
  });

  it('refuses to modify a filled order', () => {
    const filled = run([order({ type: 'MARKET' })], quote(20_000)).orders[0] as EngineOrder;
    expect(modifyOrder(filled, { qty: 3 }, T0).ok).toBe(false);
  });

  it('un-triggers a stop-limit when its stop is moved', () => {
    // Limit above the stop, so election alone does not fill it and the order
    // survives to be modified.
    const o = order({ type: 'STOP_LIMIT', side: 'SELL', stopTicks: px(19_990), limitTicks: px(20_050) });
    const triggered = run([resting(o)], barSnap(19_992, 19_993, 19_985, 19_986)).orders[0] as EngineOrder;
    expect(triggered.stopTriggered).toBe(true);
    expect(triggered.status).toBe('WORKING');
    const m = modifyOrder(triggered, { stopTicks: px(19_900) }, T0 + 1);
    expect(m.ok).toBe(true);
    expect(m.order.stopTriggered).toBe(false);
  });
});

describe('time in force', () => {
  it('expires a DAY order on the next trading date', () => {
    const o = order({ type: 'LIMIT', limitTicks: px(1), tif: 'DAY', tradingDate: '2026-09-15' });
    expect(expiresOnTradingDate(o, '2026-09-15')).toBe(false);
    expect(expiresOnTradingDate(o, '2026-09-16')).toBe(true);
  });

  it('leaves a GTC order alone across dates', () => {
    const o = order({ type: 'LIMIT', limitTicks: px(1), tif: 'GTC', tradingDate: '2026-09-15' });
    expect(expiresOnTradingDate(o, '2026-09-30')).toBe(false);
  });
});

describe('environment settings', () => {
  it('clamps nonsense into a usable range', () => {
    const env = normalizeEnvironment({ latencyMs: -5, marketSlippageTicks: 9_999, maxContractsPerFill: 0.4 });
    expect(env.latencyMs).toBe(0);
    expect(env.marketSlippageTicks).toBe(100);
    expect(env.maxContractsPerFill).toBe(1);
  });

  it('survives a nonsense numeric without becoming NaN', () => {
    const env = normalizeEnvironment({ latencyMs: Number.NaN });
    expect(env.latencyMs).toBe(0);
  });

  it('charges the registry fee per side unless overridden', () => {
    const env = { ...FRICTIONLESS_ENVIRONMENT, feesEnabled: true };
    const r = run([order({ type: 'MARKET', qty: 2 }, env)], quote(20_000), env);
    const expected = 2 * (NQ.commissionPerSideMicros + NQ.exchangeFeesPerSideMicros);
    expect(r.feesMicros).toBe(expected);

    const overridden = { ...env, commissionPerSideMicrosOverride: 0 };
    const r2 = run([order({ type: 'MARKET', qty: 2 }, overridden)], quote(20_000), overridden);
    expect(r2.feesMicros).toBe(2 * NQ.exchangeFeesPerSideMicros);
  });

  it('charges no fees when they are disabled', () => {
    const r = run([order({ type: 'MARKET', qty: 3 })], quote(20_000));
    expect(r.feesMicros).toBe(0);
  });
});

describe('position integration', () => {
  it('builds, reduces and reverses a position through the engine', () => {
    let position = flatPosition('NQ');
    let r = run([order({ type: 'MARKET', side: 'BUY', qty: 2 })], quote(20_000), FRICTIONLESS_ENVIRONMENT, position);
    position = r.position;
    expect(position.qty).toBe(2);

    r = run([order({ type: 'MARKET', side: 'BUY', qty: 1 })], quote(20_010), FRICTIONLESS_ENVIRONMENT, position);
    position = r.position;
    expect(position.qty).toBe(3);
    expect(avgEntryTicks(NQ, position)).toBeCloseTo((px(20_000) * 2 + px(20_010)) / 3, 9);

    r = run([order({ type: 'MARKET', side: 'SELL', qty: 5 })], quote(20_020), FRICTIONLESS_ENVIRONMENT, position);
    position = r.position;
    expect(position.qty).toBe(-2);
    expect(r.closedLots).toHaveLength(1);
    expect(r.closedLots[0]!.qty).toBe(3);
    expect(r.realizedPnlMicros).toBeGreaterThan(0);
  });

  it('reports realized P&L in dollars matching the contract spec', () => {
    const position = { ...flatPosition('NQ'), qty: 1, costBasisMicros: px(20_000) * 1 * NQ.tickValueMicros, openedAt: T0 };
    const r = run([order({ type: 'MARKET', side: 'SELL', qty: 1 })], quote(20_015), FRICTIONLESS_ENVIRONMENT, position);
    // 15 points = 60 ticks * $5 = $300
    expect(r.realizedPnlMicros).toBe(300 * MICROS);
  });
});
