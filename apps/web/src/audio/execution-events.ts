/**
 * Which authoritative changes are worth saying out loud.
 *
 * This is the only place that decides a trading sound, and it decides from
 * SERVER STATE ALONE: the previous authoritative snapshot against the one that
 * just arrived. There is no path from a click to a sound - that is the whole
 * point of putting the decision here rather than in the button that sent the
 * order.
 *
 * The rules:
 *
 *   an order reaching FILLED           -> "order filled"
 *   ...unless it is a protective leg   -> "target filled" / "stop loss filled"
 *   a position going to zero           -> "position closed"
 *   an order reaching REJECTED         -> "order rejected"
 *
 * A partially filled order says nothing until it is done. A position that
 * merely got smaller says nothing - it is still open, and a trader taking a
 * partial knows they took it.
 */
import type { ApiOrder, ApiPosition } from '../trading/api';
import type { TradingSound } from './trading-audio';

export interface ExecutionSnapshot {
  /** Order id to status, as the server last reported it. */
  readonly orders: ReadonlyMap<string, string>;
  /** Symbol to absolute quantity. */
  readonly positions: ReadonlyMap<string, number>;
}

export const EMPTY_SNAPSHOT: ExecutionSnapshot = {
  orders: new Map(),
  positions: new Map(),
};

export function snapshotOf(
  orders: readonly ApiOrder[],
  positions: readonly ApiPosition[],
): ExecutionSnapshot {
  return {
    orders: new Map(orders.map((o) => [o.id, o.status])),
    positions: new Map(positions.map((p) => [p.symbol, Math.abs(p.qty)])),
  };
}

/**
 * The sounds this change earns.
 *
 * `previous` being empty means this is the first authoritative read of the
 * session - a reload, or an account just selected - and nothing is announced
 * then. Everything in that snapshot already happened, possibly hours ago, and
 * a terminal that greets a trader by replaying yesterday's fills is broken.
 */
export function soundsFor(
  previous: ExecutionSnapshot,
  orders: readonly ApiOrder[],
  positions: readonly ApiPosition[],
): readonly TradingSound[] {
  if (previous.orders.size === 0 && previous.positions.size === 0) return [];

  const out: TradingSound[] = [];

  for (const order of orders) {
    const before = previous.orders.get(order.id);
    // Unknown orders are not new events: an order that appears already FILLED
    // was filled while this tab was not looking, which the blotter shows and
    // the speaker should not.
    if (before === undefined) continue;
    if (before === order.status) continue;

    if (order.status === 'FILLED') {
      if (order.bracketRole === 'TAKE_PROFIT') out.push('TARGET_FILLED');
      else if (order.bracketRole === 'STOP_LOSS') out.push('STOP_FILLED');
      else out.push('ORDER_FILLED');
    } else if (order.status === 'REJECTED') {
      out.push('ORDER_REJECTED');
    }
  }

  for (const position of positions) {
    const before = previous.positions.get(position.symbol) ?? 0;
    const now = Math.abs(position.qty);
    if (before > 0 && now === 0) out.push('POSITION_CLOSED');
  }
  // A symbol that vanished from the list entirely is also flat.
  for (const [symbol, qty] of previous.positions) {
    if (qty > 0 && !positions.some((p) => p.symbol === symbol)) out.push('POSITION_CLOSED');
  }

  /*
   * A protective fill closes a position, and both facts are true - but they
   * are one event to a trader, and the more specific one is the one worth
   * hearing. "Stop loss filled" says everything "position closed" would.
   */
  if (out.includes('STOP_FILLED') || out.includes('TARGET_FILLED')) {
    return out.filter((sound) => sound !== 'POSITION_CLOSED' && sound !== 'ORDER_FILLED');
  }

  // And the entry that closed a position - a flatten - is one event too.
  if (out.includes('POSITION_CLOSED')) {
    return out.filter((sound) => sound !== 'ORDER_FILLED');
  }

  return out;
}
