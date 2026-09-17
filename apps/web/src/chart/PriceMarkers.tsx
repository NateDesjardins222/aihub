/**
 * Orders and positions, drawn on the chart.
 *
 * Three rules this layer is built on, all of which the previous one broke:
 *
 *   The RULE is always at the true price. Only the LABEL is de-overlapped, with
 *   a visible leader back to its line, so a level read off the chart is the
 *   level the server holds.
 *
 *   Nothing appears because a checkbox is ticked. A protective line exists only
 *   when a protective ORDER exists. Position Bracket in Manual - the default -
 *   gives the position marker "+SL" and "+TP" affordances that create real
 *   server-side OCO orders; Auto places them on the fill; Off places none.
 *
 *   Dragging is not graphical. It ends in a request that modifies the
 *   authoritative order, with the version the client believed it was moving, so
 *   a level that changed underneath the drag is refused rather than clobbered.
 *
 * Positioning happens in an animation frame, not in React. Prices move and the
 * chart pans on every frame; re-rendering for that would be a component tree
 * render per tick.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { ChartAdapter } from './ChartAdapter';
import { newClientOrderId, tradingApi, type ApiOrder, type ApiPosition } from '../trading/api';
import { useTrading } from '../trading/store';
import { MASK, useTraining } from '../state/training';
import { useSession } from '../state/session';
import { useReplayStatus } from '../state/replay-status';
import { layoutMarkers, type MarkerInput } from './marker-layout';
import { Icon } from '../ui/Icon';
import './PriceMarkers.css';

/** How the position's protective orders come into existence. */
export type BracketMode = 'OFF' | 'MANUAL' | 'AUTO';

export interface PriceMarkersProps {
  readonly adapterRef: React.RefObject<ChartAdapter | null>;
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly symbol: string;
  readonly tickSize: number;
  readonly pricePrecision: number;
  readonly ready: boolean;
  /** Default protective distances in ticks, from the order ticket. */
  readonly defaultStopTicks: number;
  readonly defaultTargetTicks: number;
}

type Role = 'POSITION' | 'STOP' | 'TARGET' | 'ORDER' | 'REVIEW_ENTRY' | 'REVIEW_EXIT';

interface Marker {
  readonly key: string;
  readonly role: Role;
  readonly price: number;
  readonly side: 'BUY' | 'SELL' | null;
  readonly label: string;
  readonly qty: number | null;
  /** Drag target: an order to modify, or the position's protective leg. */
  readonly drag:
    | { kind: 'ORDER'; orderId: string; field: 'limitPrice' | 'stopPrice'; version: number }
    | { kind: 'PROTECT'; leg: 'STOP' | 'TARGET' }
    | null;
  readonly cancel: { kind: 'ORDER'; orderId: string } | { kind: 'PROTECT'; leg: 'STOP' | 'TARGET' } | null;
  readonly pnlMicros: number | null;
  readonly priority: number;
}

const LABEL_HEIGHT = 19;

function snap(price: number, tickSize: number): number {
  return Number((Math.round(price / tickSize) * tickSize).toFixed(10));
}

function orderLevel(order: ApiOrder): { price: number; field: 'limitPrice' | 'stopPrice' } | null {
  // A triggered stop-limit shows where it now RESTS, which is its limit.
  if (order.type === 'STOP_LIMIT' && order.stopTriggered && order.limitPrice !== null) {
    return { price: order.limitPrice, field: 'limitPrice' };
  }
  if (order.stopPrice !== null) return { price: order.stopPrice, field: 'stopPrice' };
  if (order.limitPrice !== null) return { price: order.limitPrice, field: 'limitPrice' };
  return null;
}

function entryLabel(order: ApiOrder): string {
  const kind =
    order.type === 'LIMIT'
      ? 'LMT'
      : order.type === 'STOP_MARKET'
        ? 'STP'
        : order.type === 'STOP_LIMIT'
          ? 'STP LMT'
          : order.type === 'TRAILING_STOP'
            ? 'TRAIL'
            : 'MKT';
  return `${order.side === 'BUY' ? 'BUY' : 'SELL'} ${kind}`;
}

export function PriceMarkers({
  adapterRef,
  containerRef,
  symbol,
  tickSize,
  pricePrecision,
  ready,
  defaultStopTicks,
  defaultTargetTicks,
}: PriceMarkersProps): JSX.Element | null {
  const accountId = useTrading((s) => s.accountId);
  const orders = useTrading((s) => s.orders);
  const positions = useTrading((s) => s.positions);
  const refresh = useTrading((s) => s.refresh);
  const setRejection = useTrading((s) => s.setRejection);
  const showPnl = useTraining((s) => s.visibility.pnl);
  const focus = useSession((s) => s.chartFocus);
  const clearFocus = useSession((s) => s.focusTrade);
  const replayPaused = useReplayStatus((s) => s.isReplay && s.replayPaused);

  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);

  const dragRef = useRef<{ key: string; startPrice: number; price: number } | null>(null);
  const nodesRef = useRef(new Map<string, HTMLElement>());
  const overlayRef = useRef<HTMLDivElement>(null);

  const workingOrders = useMemo(
    () =>
      orders.filter(
        (order) =>
          order.symbol === symbol &&
          (order.status === 'WORKING' ||
            order.status === 'PARTIALLY_FILLED' ||
            order.status === 'CANCEL_PENDING'),
      ),
    [orders, symbol],
  );

  const position = useMemo(
    () => positions.find((p) => p.symbol === symbol && p.qty !== 0) ?? null,
    [positions, symbol],
  );

  const stopLeg = useMemo(
    () => workingOrders.find((order) => order.bracketRole === 'STOP_LOSS') ?? null,
    [workingOrders],
  );
  const targetLeg = useMemo(
    () => workingOrders.find((order) => order.bracketRole === 'TAKE_PROFIT') ?? null,
    [workingOrders],
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
          message: detail.message ?? 'The request was not accepted.',
        });
      } finally {
        setBusy(false);
      }
    },
    [refresh, setRejection],
  );

  // --- the marker set -----------------------------------------------------

  const markers = useMemo<Marker[]>(() => {
    const out: Marker[] = [];

    if (position && position.avgEntryPrice !== null) {
      out.push({
        key: 'position',
        role: 'POSITION',
        price: position.avgEntryPrice,
        side: position.signedQty > 0 ? 'BUY' : 'SELL',
        label: position.signedQty > 0 ? 'LONG' : 'SHORT',
        qty: position.qty,
        drag: null,
        cancel: null,
        pnlMicros: position.unrealizedPnlMicros,
        priority: 3,
      });
    }

    for (const order of workingOrders) {
      const level = orderLevel(order);
      if (!level) continue;
      const role: Role =
        order.bracketRole === 'STOP_LOSS'
          ? 'STOP'
          : order.bracketRole === 'TAKE_PROFIT'
            ? 'TARGET'
            : 'ORDER';
      out.push({
        key: order.id,
        role,
        price: level.price,
        side: order.side,
        label: role === 'STOP' ? 'STOP' : role === 'TARGET' ? 'TARGET' : entryLabel(order),
        qty: order.remainingQty,
        drag: {
          kind: 'ORDER',
          orderId: order.id,
          field: level.field,
          version: order.version,
        },
        cancel: { kind: 'ORDER', orderId: order.id },
        pnlMicros: null,
        priority: role === 'ORDER' ? 1 : 2,
      });
    }

    if (focus && focus.symbol === symbol) {
      out.push({
        key: 'review-entry',
        role: 'REVIEW_ENTRY',
        price: focus.entryPrice,
        side: focus.side === 'LONG' ? 'BUY' : 'SELL',
        label: `${focus.side} ENTRY`,
        qty: null,
        drag: null,
        cancel: null,
        pnlMicros: null,
        priority: 0,
      });
      out.push({
        key: 'review-exit',
        role: 'REVIEW_EXIT',
        price: focus.exitPrice,
        side: null,
        label: 'EXIT',
        qty: null,
        drag: null,
        cancel: null,
        pnlMicros: null,
        priority: 0,
      });
    }

    return out;
  }, [position, workingOrders, focus, symbol]);

  // --- dragging -----------------------------------------------------------

  const beginDrag = useCallback((event: React.PointerEvent, marker: Marker): void => {
    if (!marker.drag) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { key: marker.key, startPrice: marker.price, price: marker.price };
    setDragging(marker.key);
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const container = containerRef.current;
    if (!container) return;
    const marker = markers.find((m) => m.key === dragging);
    if (!marker || !marker.drag) return;

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
      const target = marker.drag!;

      if (target.kind === 'ORDER') {
        void act(() =>
          tradingApi.modify(accountId, target.orderId, {
            [target.field]: drag.price,
            // Optimistic concurrency: a partial fill or a trailing stop moving
            // itself during the drag makes the drag stale, and the server
            // refuses it rather than applying it to a price that has changed.
            expectedVersion: target.version,
          }),
        );
      } else {
        void act(() =>
          tradingApi.protect(accountId, symbol, {
            [target.leg === 'STOP' ? 'stopPrice' : 'targetPrice']: drag.price,
          }),
        );
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [accountId, act, adapterRef, containerRef, dragging, markers, symbol, tickSize]);

  // --- placement, off the React tree --------------------------------------

  useEffect(() => {
    if (!ready) return;
    let frame = 0;

    const place = (): void => {
      frame = requestAnimationFrame(place);
      const adapter = adapterRef.current;
      const container = containerRef.current;
      if (!adapter || !container) return;

      const height = container.clientHeight;
      const drag = dragRef.current;

      // Keep the whole layer clear of the price axis, so a label never sits on
      // top of the scale's numbers.
      const overlay = overlayRef.current;
      if (overlay) overlay.style.right = `${Math.round(adapter.priceScaleWidth())}px`;

      const inputs: MarkerInput[] = [];
      const shown = new Map<string, { y: number; price: number }>();
      for (const [key, node] of nodesRef.current) {
        const price = Number(node.dataset['price']);
        if (!Number.isFinite(price)) continue;
        const effective = drag && drag.key === key ? drag.price : price;
        const y = adapter.priceToY(effective);
        inputs.push({
          id: key,
          y: y ?? Number.NaN,
          priority: Number(node.dataset['priority'] ?? 0),
          height: LABEL_HEIGHT,
        });
        if (y !== null) shown.set(key, { y, price: effective });
      }

      const placements = layoutMarkers(inputs, { height, gap: 3 });

      for (const placement of placements) {
        const node = nodesRef.current.get(placement.id);
        if (!node) continue;
        const info = shown.get(placement.id);
        if (!placement.visible || !info) {
          node.style.visibility = 'hidden';
          continue;
        }
        node.style.visibility = 'visible';
        // The rule sits at the TRUE y; the label is offset by the leader.
        node.style.transform = `translateY(${Math.round(info.y)}px)`;
        node.style.setProperty('--leader', `${Math.round(placement.leader)}px`);
        node.dataset['offset'] = Math.abs(placement.leader) > 0.5 ? 'yes' : 'no';
        const label = node.querySelector<HTMLElement>('[data-price-label]');
        if (label) label.textContent = info.price.toFixed(pricePrecision);
      }
    };

    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [adapterRef, containerRef, pricePrecision, ready]);

  const register = useCallback((key: string, node: HTMLElement | null): void => {
    if (node) nodesRef.current.set(key, node);
    else nodesRef.current.delete(key);
  }, []);

  // --- protective affordances --------------------------------------------

  const addProtection = useCallback(
    (leg: 'STOP' | 'TARGET'): void => {
      if (!accountId || !position || position.avgEntryPrice === null) return;
      const long = position.signedQty > 0;
      const distance = (leg === 'STOP' ? defaultStopTicks : defaultTargetTicks) * tickSize;
      // A stop goes against the position, a target with it.
      const direction = leg === 'STOP' ? (long ? -1 : 1) : long ? 1 : -1;
      const price = snap(position.avgEntryPrice + direction * distance, tickSize);
      void act(() =>
        tradingApi.protect(accountId, symbol, {
          [leg === 'STOP' ? 'stopPrice' : 'targetPrice']: price,
        }),
      );
    },
    [accountId, act, defaultStopTicks, defaultTargetTicks, position, symbol, tickSize],
  );

  if (!ready || !accountId) return null;

  return (
    <div className="pm" ref={overlayRef}>
      {replayPaused ? (
        <div className="pm-paused" title="The replay is paused: nothing can fill until it moves">
          <Icon name="pause" size={11} />
          REPLAY PAUSED
        </div>
      ) : null}

      {markers.map((marker) => (
        <div
          key={marker.key}
          className={[
            'pm-line',
            `pm-${marker.role.toLowerCase().replace('_', '-')}`,
            marker.side === 'BUY' ? 'pm-buy' : marker.side === 'SELL' ? 'pm-sell' : '',
            dragging === marker.key ? 'pm-dragging' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          data-price={marker.price}
          data-priority={marker.priority}
          data-marker={marker.role.toLowerCase()}
          ref={(node) => register(marker.key, node)}
        >
          <div className="pm-rule" />
          {/* Drawn only when the label had to move off its line. */}
          <div className="pm-leader" />
          {/*
            The test id is on the TAG rather than the line, because the line is
            a zero-height rule: it has no box to hover or click.
          */}
          <div
            className={`pm-tag ${marker.drag ? 'pm-tag-drag' : ''}`}
            data-testid={`marker-${marker.role.toLowerCase()}`}
            onPointerDown={(event) => beginDrag(event, marker)}
            title={marker.drag ? 'Drag to move this level' : undefined}
          >
            <span className="pm-kind">{marker.label}</span>
            {marker.qty !== null ? <span className="num pm-qty">{marker.qty}</span> : null}
            <span className="num pm-price" data-price-label>
              {marker.price.toFixed(pricePrecision)}
            </span>
            {marker.pnlMicros !== null ? (
              <span
                className={`num pm-pnl ${
                  showPnl ? (marker.pnlMicros >= 0 ? 'pos' : 'neg') : ''
                }`}
                title="Open profit and loss, computed by the server"
              >
                {showPnl ? money(marker.pnlMicros) : MASK}
              </span>
            ) : null}

            {marker.role === 'POSITION' ? (
              <span className="pm-acts">
                {!stopLeg ? (
                  <button
                    className="pm-act"
                    disabled={busy}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => addProtection('STOP')}
                    title={`Add a protective stop ${defaultStopTicks} ticks away, then drag it`}
                  >
                    +SL
                  </button>
                ) : null}
                {!targetLeg ? (
                  <button
                    className="pm-act"
                    disabled={busy}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => addProtection('TARGET')}
                    title={`Add a target ${defaultTargetTicks} ticks away, then drag it`}
                  >
                    +TP
                  </button>
                ) : null}
                <button
                  className="pm-act pm-act-close"
                  disabled={busy}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => void act(() => tradingApi.flatten(accountId, symbol))}
                  title="Close this position at market"
                >
                  <Icon name="close" size={9} />
                </button>
              </span>
            ) : null}

            {marker.cancel ? (
              <button
                className="pm-act pm-act-close"
                disabled={busy}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  const target = marker.cancel!;
                  if (target.kind === 'ORDER') {
                    void act(() => tradingApi.cancel(accountId, target.orderId));
                  } else {
                    void act(() =>
                      tradingApi.protect(accountId, symbol, {
                        [target.leg === 'STOP' ? 'stopPrice' : 'targetPrice']: null,
                      }),
                    );
                  }
                }}
                title="Cancel this order"
              >
                <Icon name="close" size={9} />
              </button>
            ) : null}

            {marker.role === 'REVIEW_EXIT' ? (
              <button
                className="pm-act pm-act-close"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => clearFocus(null)}
                title="Stop showing this trade"
              >
                <Icon name="close" size={9} />
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function money(micros: number): string {
  const dollars = micros / 1_000_000;
  const sign = dollars > 0 ? '+' : dollars < 0 ? '−' : '';
  return `${sign}$${Math.abs(dollars).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Levels a bracket should be placed at for a new position.
 *
 * Exported so the order ticket and the chart agree on what "40 ticks" means
 * without either of them owning the other.
 */
export function bracketLevels(
  position: ApiPosition,
  stopTicks: number,
  targetTicks: number,
  tickSize: number,
): { stopPrice: number | null; targetPrice: number | null } {
  if (position.avgEntryPrice === null) return { stopPrice: null, targetPrice: null };
  const long = position.signedQty > 0;
  return {
    stopPrice:
      stopTicks > 0
        ? snap(position.avgEntryPrice + (long ? -1 : 1) * stopTicks * tickSize, tickSize)
        : null,
    targetPrice:
      targetTicks > 0
        ? snap(position.avgEntryPrice + (long ? 1 : -1) * targetTicks * tickSize, tickSize)
        : null,
  };
}

export { newClientOrderId };
