/**
 * Trading on the chart.
 *
 * Working orders, bracket legs and the open position are drawn over the chart
 * and can be dragged, canceled and closed from it. Every one of those actions
 * goes to the SAME authoritative endpoints the order ticket uses: this overlay
 * has no idea what a fill is and never changes account state. It renders what
 * the server says exists, and asks the server to change it.
 *
 * Positioning is done outside React. Prices move and the chart pans on every
 * frame, so the lines are placed by writing `transform` in an animation frame
 * rather than by re-rendering - the same discipline the price stream uses.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { ChartAdapter } from './ChartAdapter';
import { newClientOrderId, tradingApi, type ApiOrder } from '../trading/api';
import { useTrading } from '../trading/store';
import { MASK, useTraining } from '../state/training';
import { useSession } from '../state/session';
import { useReplayStatus } from '../state/replay-status';
import './ChartTrading.css';

export interface ChartTradingProps {
  readonly adapterRef: React.RefObject<ChartAdapter | null>;
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly symbol: string;
  readonly tickSize: number;
  readonly pricePrecision: number;
  /** Flipped by the panel once the chart is mounted and has data. */
  readonly ready: boolean;
}

type PendingOrderKind = 'LIMIT' | 'STOP';

interface MenuState {
  readonly x: number;
  readonly y: number;
  readonly price: number;
}

interface DragState {
  readonly orderId: string;
  readonly field: 'limitPrice' | 'stopPrice';
  readonly version: number;
  readonly startPrice: number;
  price: number;
}

/** Round a price to the instrument's tick grid. Orders off the grid are rejected. */
function snap(price: number, tickSize: number): number {
  const ticks = Math.round(price / tickSize);
  return Number((ticks * tickSize).toFixed(10));
}

function orderLinePrice(order: ApiOrder): { price: number; field: DragState['field'] } | null {
  // A stop-limit shows where it will REST once elected, which is the limit; the
  // stop that elects it is drawn as its own line.
  if (order.type === 'STOP_LIMIT' && order.stopTriggered && order.limitPrice !== null) {
    return { price: order.limitPrice, field: 'limitPrice' };
  }
  if (order.stopPrice !== null) return { price: order.stopPrice, field: 'stopPrice' };
  if (order.limitPrice !== null) return { price: order.limitPrice, field: 'limitPrice' };
  return null;
}

function roleOf(order: ApiOrder): 'STOP' | 'TARGET' | 'ENTRY' {
  if (order.bracketRole === 'STOP_LOSS') return 'STOP';
  if (order.bracketRole === 'TAKE_PROFIT') return 'TARGET';
  return 'ENTRY';
}

export function ChartTrading({
  adapterRef,
  containerRef,
  symbol,
  tickSize,
  pricePrecision,
  ready,
}: ChartTradingProps): JSX.Element | null {
  const accountId = useTrading((s) => s.accountId);
  const orders = useTrading((s) => s.orders);
  const positions = useTrading((s) => s.positions);
  const canTrade = useTrading((s) => s.rules?.canTrade ?? true);
  const rejection = useTrading((s) => s.lastRejection);
  const showPnl = useTraining((s) => s.visibility.pnl);
  const focus = useSession((s) => s.chartFocus);
  const replayPaused = useReplayStatus((s) => s.isReplay && s.replayPaused);
  const clearFocus = useSession((s) => s.focusTrade);
  const setRejection = useTrading((s) => s.setRejection);
  const refresh = useTrading((s) => s.refresh);

  const [qty, setQty] = useState(1);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const nodesRef = useRef(new Map<string, HTMLElement>());

  const symbolOrders = useMemo(
    () =>
      orders.filter(
        (o) =>
          o.symbol === symbol &&
          (o.status === 'WORKING' || o.status === 'PARTIALLY_FILLED' || o.status === 'CANCEL_PENDING'),
      ),
    [orders, symbol],
  );
  const position = useMemo(
    () => positions.find((p) => p.symbol === symbol && p.qty !== 0) ?? null,
    [positions, symbol],
  );

  const act = useCallback(
    async (run: () => Promise<unknown>): Promise<void> => {
      setBusy(true);
      try {
        await run();
        setRejection(null);
        await refresh();
      } catch (err) {
        const detail = err as { code?: string; message?: string };
        setRejection({
          code: detail.code ?? 'ERROR',
          message: detail.message ?? 'The order was not accepted.',
        });
      } finally {
        setBusy(false);
      }
    },
    [refresh, setRejection],
  );

  // --- placing ------------------------------------------------------------

  const submitAt = useCallback(
    (side: 'BUY' | 'SELL', kind: PendingOrderKind, price: number) => {
      if (!accountId) return;
      void act(() =>
        tradingApi.submit({
          accountId,
          clientOrderId: newClientOrderId('chart'),
          symbol,
          side,
          qty,
          type: kind === 'LIMIT' ? 'LIMIT' : 'STOP_MARKET',
          limitPrice: kind === 'LIMIT' ? snap(price, tickSize) : null,
          stopPrice: kind === 'STOP' ? snap(price, tickSize) : null,
          tif: 'DAY',
        }),
      );
      setMenu(null);
    },
    [accountId, act, qty, symbol, tickSize],
  );

  const submitMarket = useCallback(
    (side: 'BUY' | 'SELL') => {
      if (!accountId) return;
      void act(() =>
        tradingApi.submit({
          accountId,
          clientOrderId: newClientOrderId('chart'),
          symbol,
          side,
          qty,
          type: 'MARKET',
          tif: 'DAY',
        }),
      );
      setMenu(null);
    },
    [accountId, act, qty, symbol],
  );

  // --- the context menu ---------------------------------------------------

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ready) return;

    const onContextMenu = (event: MouseEvent): void => {
      const adapter = adapterRef.current;
      if (!adapter) return;
      const rect = container.getBoundingClientRect();
      const price = adapter.yToPrice(event.clientY - rect.top);
      if (price === null) return;
      event.preventDefault();
      setMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top, price: snap(price, tickSize) });
    };

    container.addEventListener('contextmenu', onContextMenu);
    return () => container.removeEventListener('contextmenu', onContextMenu);
  }, [adapterRef, containerRef, ready, tickSize]);

  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [menu]);

  // --- dragging -----------------------------------------------------------

  const beginDrag = useCallback(
    (event: React.PointerEvent, order: ApiOrder): void => {
      const line = orderLinePrice(order);
      if (!line) return;
      event.preventDefault();
      event.stopPropagation();
      dragRef.current = {
        orderId: order.id,
        field: line.field,
        version: order.version,
        startPrice: line.price,
        price: line.price,
      };
      setDragging(order.id);
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    },
    [],
  );

  useEffect(() => {
    if (!dragging) return;
    const container = containerRef.current;
    if (!container) return;

    const onMove = (event: PointerEvent): void => {
      const drag = dragRef.current;
      const adapter = adapterRef.current;
      if (!drag || !adapter) return;
      const rect = container.getBoundingClientRect();
      const price = adapter.yToPrice(event.clientY - rect.top);
      if (price === null) return;
      drag.price = snap(price, tickSize);
    };

    const onUp = (): void => {
      const drag = dragRef.current;
      dragRef.current = null;
      setDragging(null);
      if (!drag || !accountId) return;
      if (drag.price === drag.startPrice) return;

      void act(() =>
        tradingApi.modify(accountId, drag.orderId, {
          [drag.field]: drag.price,
          // Optimistic concurrency: if the order changed while it was being
          // dragged - a partial fill, a trailing stop moving itself - the
          // server rejects the move rather than applying it to a stale price.
          expectedVersion: drag.version,
        }),
      );
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [accountId, act, adapterRef, containerRef, dragging, tickSize]);

  // --- positioning --------------------------------------------------------

  useEffect(() => {
    if (!ready) return;
    let frame = 0;

    const place = (): void => {
      frame = requestAnimationFrame(place);
      const adapter = adapterRef.current;
      const overlay = overlayRef.current;
      if (!adapter || !overlay) return;

      const drag = dragRef.current;
      for (const [key, node] of nodesRef.current) {
        const price = Number(node.dataset['price']);
        if (!Number.isFinite(price)) continue;
        const shown = drag && drag.orderId === key ? drag.price : price;
        const y = adapter.priceToY(shown);
        if (y === null) {
          node.style.visibility = 'hidden';
          continue;
        }
        node.style.visibility = 'visible';
        node.style.transform = `translateY(${Math.round(y)}px)`;
        const label = node.querySelector<HTMLElement>('[data-price-label]');
        if (label) label.textContent = shown.toFixed(pricePrecision);
      }
    };

    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [adapterRef, pricePrecision, ready]);

  const register = useCallback((key: string, node: HTMLElement | null): void => {
    if (node) nodesRef.current.set(key, node);
    else nodesRef.current.delete(key);
  }, []);

  if (!ready || !accountId) return null;

  return (
    <div className="chart-trading" ref={overlayRef}>
      <div className="ct-toolbar">
        <span className="ct-qty">
          <button
            className="ct-qty-btn"
            onClick={() => setQty((q) => Math.max(1, q - 1))}
            title="Fewer contracts"
          >
            −
          </button>
          <input
            className="ct-qty-input num"
            value={qty}
            onChange={(e) => {
              const next = Number(e.target.value.replace(/[^0-9]/g, ''));
              setQty(Number.isFinite(next) && next > 0 ? Math.min(999, next) : 1);
            }}
            aria-label="Contracts"
          />
          <button
            className="ct-qty-btn"
            onClick={() => setQty((q) => Math.min(999, q + 1))}
            title="More contracts"
          >
            +
          </button>
        </span>
        <button
          className="ct-btn ct-buy"
          disabled={busy || !canTrade}
          onClick={() => submitMarket('BUY')}
          title="Buy at market"
        >
          BUY MKT
        </button>
        <button
          className="ct-btn ct-sell"
          disabled={busy || !canTrade}
          onClick={() => submitMarket('SELL')}
          title="Sell at market"
        >
          SELL MKT
        </button>
        <button
          className="ct-btn"
          disabled={busy || !position}
          onClick={() => void act(() => tradingApi.flatten(accountId, symbol))}
          title="Close the position at market"
        >
          FLATTEN
        </button>
        <button
          className="ct-btn"
          disabled={busy || !position || !canTrade}
          onClick={() => void act(() => tradingApi.reverse(accountId, symbol))}
          title="Close and open the same size the other way"
        >
          REVERSE
        </button>
        <button
          className="ct-btn"
          disabled={busy || symbolOrders.length === 0}
          onClick={() => void act(() => tradingApi.cancelAll(accountId, symbol))}
          title="Cancel every working order in this instrument"
        >
          CANCEL ALL
        </button>
        {replayPaused ? (
          <span className="ct-paused" title="The replay is paused: nothing can fill until it moves">
            REPLAY PAUSED
          </span>
        ) : (
          <span className="ct-hint">right-click the chart to place an order at a price</span>
        )}
      </div>

      {position ? (
        <div
          className={`ct-line ct-position ${position.signedQty > 0 ? 'ct-long' : 'ct-short'}`}
          data-price={position.avgEntryPrice ?? 0}
          ref={(node) => register('position', node)}
        >
          <div className="ct-line-rule" />
          <div className="ct-line-tag">
            <span className="ct-tag-kind">{position.side}</span>
            <span className="num">{position.qty}</span>
            <span className="num" data-price-label>
              {position.avgEntryPrice?.toFixed(pricePrecision) ?? '—'}
            </span>
            <span
              className={`num ct-pnl ${showPnl && position.unrealizedPnlMicros >= 0 ? 'up' : showPnl ? 'down' : ''}`}
              title="Open profit and loss, computed by the server"
            >
              {showPnl ? money(position.unrealizedPnlMicros) : MASK}
            </span>
            <button
              className="ct-tag-btn"
              disabled={busy}
              onClick={() => void act(() => tradingApi.flatten(accountId, symbol))}
              title="Close this position"
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}

      {symbolOrders.map((order) => {
        const line = orderLinePrice(order);
        if (!line) return null;
        const role = roleOf(order);
        return (
          <div
            key={order.id}
            className={`ct-line ct-order ct-${role.toLowerCase()} ${
              order.side === 'BUY' ? 'ct-buy-line' : 'ct-sell-line'
            } ${dragging === order.id ? 'ct-dragging' : ''}`}
            data-price={line.price}
            ref={(node) => register(order.id, node)}
          >
            <div className="ct-line-rule" />
            <div
              className="ct-line-tag"
              onPointerDown={(event) => beginDrag(event, order)}
              title="Drag to move this order"
            >
              <span className="ct-tag-kind">{labelFor(order, role)}</span>
              <span className="num">{order.remainingQty}</span>
              <span className="num" data-price-label>
                {line.price.toFixed(pricePrecision)}
              </span>
              <button
                className="ct-tag-btn"
                disabled={busy}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => void act(() => tradingApi.cancel(accountId, order.id))}
                title="Cancel this order"
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}

      {focus && focus.symbol === symbol ? (
        <>
          <div
            className="ct-line ct-review ct-entry"
            data-price={focus.entryPrice}
            ref={(node) => register('focus-entry', node)}
          >
            <div className="ct-line-rule" />
            <div className="ct-line-tag">
              <span className="ct-tag-kind">{focus.side} ENTRY</span>
              <span className="num" data-price-label>
                {focus.entryPrice.toFixed(pricePrecision)}
              </span>
            </div>
          </div>
          <div
            className="ct-line ct-review ct-exit"
            data-price={focus.exitPrice}
            ref={(node) => register('focus-exit', node)}
          >
            <div className="ct-line-rule" />
            <div className="ct-line-tag">
              <span className="ct-tag-kind">EXIT</span>
              <span className="num" data-price-label>
                {focus.exitPrice.toFixed(pricePrecision)}
              </span>
              <button
                className="ct-tag-btn"
                onClick={() => clearFocus(null)}
                title="Stop showing this trade"
              >
                ✕
              </button>
            </div>
          </div>
        </>
      ) : null}

      {rejection ? (
        <div className="ct-reject" role="alert">
          <span className="ct-reject-code">{rejection.code.replace(/_/g, ' ')}</span>
          <span className="ct-reject-message">{rejection.message}</span>
          <button className="ct-tag-btn" onClick={() => setRejection(null)} title="Dismiss">
            ✕
          </button>
        </div>
      ) : null}

      {menu ? (
        <div
          className="ct-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="ct-menu-head">
            <span className="num">{menu.price.toFixed(pricePrecision)}</span>
            <span>{qty} lot</span>
          </div>
          <button onClick={() => submitAt('BUY', 'LIMIT', menu.price)} disabled={!canTrade}>
            Buy limit
          </button>
          <button onClick={() => submitAt('SELL', 'LIMIT', menu.price)} disabled={!canTrade}>
            Sell limit
          </button>
          <button onClick={() => submitAt('BUY', 'STOP', menu.price)} disabled={!canTrade}>
            Buy stop
          </button>
          <button onClick={() => submitAt('SELL', 'STOP', menu.price)} disabled={!canTrade}>
            Sell stop
          </button>
          <div className="ct-menu-sep" />
          <button onClick={() => submitMarket('BUY')} disabled={!canTrade}>
            Buy market
          </button>
          <button onClick={() => submitMarket('SELL')} disabled={!canTrade}>
            Sell market
          </button>
        </div>
      ) : null}
    </div>
  );
}

function labelFor(order: ApiOrder, role: 'STOP' | 'TARGET' | 'ENTRY'): string {
  if (role === 'STOP') return 'STOP LOSS';
  if (role === 'TARGET') return 'TARGET';
  const kind =
    order.type === 'LIMIT'
      ? 'LIMIT'
      : order.type === 'STOP_MARKET'
        ? 'STOP'
        : order.type === 'STOP_LIMIT'
          ? 'STOP LMT'
          : order.type === 'TRAILING_STOP'
            ? 'TRAIL'
            : 'MKT';
  return `${order.side} ${kind}`;
}

function money(micros: number): string {
  const dollars = micros / 1_000_000;
  const sign = dollars > 0 ? '+' : dollars < 0 ? '−' : '';
  return `${sign}$${Math.abs(dollars).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
