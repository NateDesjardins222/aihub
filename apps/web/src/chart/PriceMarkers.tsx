/**
 * Orders and positions, drawn on the chart.
 *
 * The rules this layer is built on:
 *
 *   The RULE is always at the true price. Only the LABEL is de-overlapped, with
 *   a leader back to its line, so a level read off the chart is the level the
 *   server holds.
 *
 *   The position marker shows the OPEN P&L and nothing else. Side, entry price
 *   and quantity are available, but they are not what a trader looks at while a
 *   trade is on.
 *
 *   Protection is created by a GESTURE, not by a button. Press the position
 *   marker and drag: above the entry on a long is a target and below it is a
 *   stop, and the other way round on a short. A live preview shows the level
 *   and what it is worth, and releasing creates a real server-side order.
 *
 *   Nothing here is graphical-only. A drag ends in a request that modifies the
 *   authoritative order, with the version it was holding, and a cancel cancels
 *   the working order.
 *
 * Positioning happens in an animation frame, not in React, because prices move
 * and the chart pans on every frame.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { ChartAdapter } from './ChartAdapter';
import { newClientOrderId, tradingApi, type ApiOrder, type ApiPosition } from '../trading/api';
import { useTrading } from '../trading/store';
import { MASK, useTraining } from '../state/training';
import { useSession } from '../state/session';
import { useReplayStatus } from '../state/replay-status';
import { layoutMarkers, type MarkerInput } from './marker-layout';
import { estimatePnlMicros, legFor, snapPrice as snap } from './protection';
import { Icon } from '../ui/Icon';
import './PriceMarkers.css';

/** How the position's protective orders come into existence. */
export type BracketMode = 'OFF' | 'MANUAL' | 'AUTO';

export interface PriceMarkersProps {
  readonly adapterRef: React.RefObject<ChartAdapter | null>;
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly symbol: string;
  readonly tickSize: number;
  readonly tickValueMicros: number;
  readonly pricePrecision: number;
  readonly ready: boolean;
}

type Role = 'POSITION' | 'STOP' | 'TARGET' | 'ORDER' | 'REVIEW_ENTRY' | 'REVIEW_EXIT';

interface Marker {
  readonly key: string;
  readonly role: Role;
  readonly price: number;
  readonly side: 'BUY' | 'SELL' | null;
  readonly label: string;
  readonly qty: number | null;
  readonly drag:
    | { kind: 'ORDER'; orderId: string; field: 'limitPrice' | 'stopPrice'; version: number }
    | { kind: 'PROTECT'; leg: 'STOP' | 'TARGET' }
    | null;
  readonly cancel:
    | { kind: 'ORDER'; orderId: string }
    | { kind: 'PROTECT'; leg: 'STOP' | 'TARGET' }
    | null;
  /** Open P&L for the position; estimated P&L at the level for a protective leg. */
  readonly pnlMicros: number | null;
  readonly priority: number;
}

const LABEL_HEIGHT = 22;
/** Below this, a press on the position marker is a click and not a drag. */
const DRAG_THRESHOLD_PX = 6;

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
  return `${order.side} ${kind}`;
}

export function PriceMarkers({
  adapterRef,
  containerRef,
  symbol,
  tickSize,
  tickValueMicros,
  pricePrecision,
  ready,
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
  /** Set while a protective level is being pulled off the position marker. */
  const [creating, setCreating] = useState<{ leg: 'STOP' | 'TARGET'; price: number; pnl: number | null } | null>(null);

  const dragRef = useRef<{ key: string; startPrice: number; price: number } | null>(null);
  const createRef = useRef<{ startY: number; active: boolean } | null>(null);
  const nodesRef = useRef(new Map<string, HTMLElement>());
  const overlayRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

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
      const estimated =
        role === 'ORDER' || !position
          ? null
          : estimatePnlMicros(position, level.price, tickSize, tickValueMicros);
      out.push({
        key: order.id,
        role,
        price: level.price,
        side: order.side,
        label: role === 'STOP' ? 'SL' : role === 'TARGET' ? 'TP' : entryLabel(order),
        qty: order.remainingQty,
        drag: { kind: 'ORDER', orderId: order.id, field: level.field, version: order.version },
        cancel: { kind: 'ORDER', orderId: order.id },
        pnlMicros: estimated,
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
  }, [position, workingOrders, focus, symbol, tickSize, tickValueMicros]);

  // --- dragging an existing level -----------------------------------------

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
    if (!marker?.drag) return;

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
      if (!drag || !accountId || drag.price === drag.startPrice) return;
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

  // --- pulling protection off the position marker -------------------------

  const beginCreate = useCallback(
    (event: React.PointerEvent): void => {
      if (!position || position.avgEntryPrice === null) return;
      event.preventDefault();
      event.stopPropagation();
      createRef.current = { startY: event.clientY, active: false };
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    },
    [position],
  );

  useEffect(() => {
    if (!position || position.avgEntryPrice === null) return;
    const container = containerRef.current;
    if (!container) return;

    const onMove = (event: PointerEvent): void => {
      const create = createRef.current;
      const adapter = adapterRef.current;
      if (!create || !adapter) return;
      // A small movement is a click on the marker, not a gesture.
      if (!create.active && Math.abs(event.clientY - create.startY) < DRAG_THRESHOLD_PX) return;
      create.active = true;

      const rect = container.getBoundingClientRect();
      const raw = adapter.yToPrice(event.clientY - rect.top);
      if (raw === null) return;
      const price = snap(raw, tickSize);
      const leg = legFor(position, price);
      if (!leg) return;
      setCreating({
        leg,
        price,
        pnl: estimatePnlMicros(position, price, tickSize, tickValueMicros),
      });
    };

    const onUp = (): void => {
      const create = createRef.current;
      createRef.current = null;
      if (!create?.active) {
        setCreating(null);
        return;
      }
      setCreating((current) => {
        if (current && accountId) {
          void act(() =>
            tradingApi.protect(accountId, symbol, {
              [current.leg === 'STOP' ? 'stopPrice' : 'targetPrice']: current.price,
            }),
          );
        }
        return null;
      });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [accountId, act, adapterRef, containerRef, position, symbol, tickSize, tickValueMicros]);

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

      // Keep the whole layer clear of the price axis.
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
        node.style.transform = `translateY(${Math.round(info.y)}px)`;
        node.style.setProperty('--leader', `${Math.round(placement.leader)}px`);
        node.dataset['offset'] = Math.abs(placement.leader) > 0.5 ? 'yes' : 'no';
        const label = node.querySelector<HTMLElement>('[data-price-label]');
        if (label) label.textContent = info.price.toFixed(pricePrecision);
      }

      // The preview follows the cursor directly rather than through the layout:
      // it is a single transient line and must not push the real ones around.
      const preview = previewRef.current;
      if (preview) {
        const price = Number(preview.dataset['price']);
        const y = Number.isFinite(price) ? adapter.priceToY(price) : null;
        if (y === null) {
          preview.style.visibility = 'hidden';
        } else {
          preview.style.visibility = 'visible';
          preview.style.transform = `translateY(${Math.round(y)}px)`;
        }
      }
    };

    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [adapterRef, containerRef, pricePrecision, ready]);

  const register = useCallback((key: string, node: HTMLElement | null): void => {
    if (node) nodesRef.current.set(key, node);
    else nodesRef.current.delete(key);
  }, []);

  if (!ready || !accountId) return null;

  return (
    <div className="pm" ref={overlayRef}>
      {replayPaused ? (
        <div className="pm-paused" title="The replay is paused: nothing can fill until it moves">
          <Icon name="pause" size={11} />
          REPLAY PAUSED
        </div>
      ) : null}

      {/* The level being pulled off the position marker. */}
      {creating ? (
        <div
          className={`pm-line pm-preview pm-${creating.leg.toLowerCase()}`}
          data-price={creating.price}
          data-testid="marker-preview"
          ref={previewRef}
        >
          <div className="pm-rule" />
          <div className="pm-tag">
            <span className="pm-kind">{creating.leg === 'STOP' ? 'SL' : 'TP'}</span>
            <span className={`num pm-pnl ${(creating.pnl ?? 0) >= 0 ? 'pos' : 'neg'}`}>
              {creating.pnl === null ? '—' : `~ ${money(creating.pnl)}`}
            </span>
            <span className="num pm-price">{creating.price.toFixed(pricePrecision)}</span>
          </div>
        </div>
      ) : null}

      {markers.map((marker) => {
        const isPosition = marker.role === 'POSITION';
        const isProtective = marker.role === 'STOP' || marker.role === 'TARGET';
        return (
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
            <div className="pm-leader" />

            {isPosition ? (
              /*
               * The position marker: open P&L, and nothing else in the box.
               * It is also the handle - press it and drag to pull a stop or a
               * target out of it - so it carries the grab affordance.
               */
              <div
                className="pm-tag pm-pos-tag"
                data-testid="marker-position"
                onPointerDown={beginCreate}
                title="Drag up or down to place a target or a stop"
              >
                <span
                  className={`num pm-pos-pnl ${
                    showPnl ? ((marker.pnlMicros ?? 0) >= 0 ? 'up' : 'down') : ''
                  }`}
                >
                  {showPnl ? money(marker.pnlMicros ?? 0) : MASK}
                </span>
                <span className="pm-pos-side">{marker.label[0]}</span>
                <span className="num pm-pos-qty">{marker.qty}</span>
                <button
                  className="pm-act pm-act-close"
                  disabled={busy}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => void act(() => tradingApi.flatten(accountId, symbol))}
                  title="Close this position at market"
                >
                  <Icon name="close" size={9} />
                </button>
              </div>
            ) : (
              <div
                className={`pm-tag ${marker.drag ? 'pm-tag-drag' : ''}`}
                data-testid={`marker-${marker.role.toLowerCase()}`}
                onPointerDown={(event) => beginDrag(event, marker)}
                title={marker.drag ? 'Drag to move this level' : undefined}
              >
                <span className="pm-kind">{marker.label}</span>
                {isProtective && marker.pnlMicros !== null ? (
                  <span className={`num pm-pnl ${marker.pnlMicros >= 0 ? 'pos' : 'neg'}`}>
                    {showPnl ? `~ ${money(marker.pnlMicros)}` : MASK}
                  </span>
                ) : null}
                <span className="num pm-price" data-price-label>
                  {marker.price.toFixed(pricePrecision)}
                </span>
                {marker.qty !== null ? (
                  <span className="num pm-qty">
                    {isProtective ? `-${marker.qty}` : marker.qty}
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
            )}
          </div>
        );
      })}
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

export { newClientOrderId };
