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
import { ChartMenu, type ChartMenuItem } from './ChartMenu';
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
    | {
        kind: 'ORDER';
        orderId: string;
        field: 'limitPrice' | 'stopPrice';
        version: number;
        /** The order's TOTAL and filled quantities: a modify sets the total. */
        qty: number;
        filledQty: number;
      }
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
  /**
   * The level being pulled off the position marker.
   *
   * React holds only WHICH leg is being created, because that decides the
   * element's colour and label. The price, the tick distance and the money
   * change on every pointer move and are written straight into the mounted
   * element - a React render per pointer move is what made this gesture feel
   * heavy, and the numbers a trader reads while dragging have to be immediate.
   */
  const [creating, setCreating] = useState<{ leg: 'STOP' | 'TARGET' } | null>(null);
  /** The right-click menu for one marker, at the cursor. */
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);

  const dragRef = useRef<{ key: string; startPrice: number; price: number } | null>(null);
  /** The live pull-off-the-marker gesture. Written per pointer move. */
  const createRef = useRef<{
    startY: number;
    active: boolean;
    /** Null until the first move decides which side of entry the pointer is. */
    leg: 'STOP' | 'TARGET' | null;
    price: number;
    pnl: number | null;
    ticks: number;
  } | null>(null);
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

  /**
   * What the placement loop needs about the account, without restarting it.
   *
   * The loop is attached once; reading these through the closure would rebind
   * it on every position update, and a loop that restarts mid-drag drops the
   * gesture.
   */
  const liveRef = useRef({ position, tickSize, tickValueMicros, showPnl });
  liveRef.current.position = position;
  liveRef.current.tickSize = tickSize;
  liveRef.current.tickValueMicros = tickValueMicros;
  liveRef.current.showPnl = showPnl;

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

  // --- the right-click menu -----------------------------------------------

  /**
   * What can be done to the marker under the cursor.
   *
   * Every entry here ends in a request to the execution engine: a cancel
   * cancels the working order, a quantity change modifies it with the version
   * it was read at, a break-even stop moves the real protective order. None of
   * it is graphical, and none of it asks for confirmation - an ordinary
   * modification a trader asked for twice (right-click, then the item) does
   * not need a third click.
   */
  const menuItems = useCallback(
    (marker: Marker): ChartMenuItem[] => {
      const out: ChartMenuItem[] = [];
      const cancelAll: ChartMenuItem = {
        id: 'cancel-all',
        label: `Cancel all ${symbol} orders`,
        disabled: busy || workingOrders.length === 0,
        run: () => void act(() => tradingApi.cancelAll(accountId!, symbol)),
      };

      if (marker.role === 'POSITION') {
        out.push(
          {
            id: 'flatten',
            label: 'Close position at market',
            icon: 'close',
            disabled: busy,
            run: () => void act(() => tradingApi.flatten(accountId!, symbol)),
          },
          {
            id: 'reverse',
            label: 'Reverse position',
            icon: 'reset',
            disabled: busy,
            run: () => void act(() => tradingApi.reverse(accountId!, symbol)),
          },
          { id: 's1', separator: true },
          {
            id: 'unprotect',
            label: 'Remove stop and target',
            disabled: busy || !workingOrders.some((order) => order.bracketRole !== null),
            run: () =>
              void act(() =>
                tradingApi.protect(accountId!, symbol, { stopPrice: null, targetPrice: null }),
              ),
          },
          cancelAll,
        );
        return out;
      }

      if (marker.role === 'STOP' || marker.role === 'TARGET') {
        const leg = marker.role === 'STOP' ? 'stopPrice' : 'targetPrice';
        const entry = position?.avgEntryPrice ?? null;
        if (marker.role === 'STOP') {
          out.push({
            id: 'breakeven',
            label: 'Move stop to break even',
            disabled: busy || entry === null,
            title:
              entry === null ? 'There is no open position to break even on' : undefined,
            run: () =>
              void act(() =>
                tradingApi.protect(accountId!, symbol, { stopPrice: entry ?? undefined }),
              ),
          });
        }
        out.push(
          {
            id: 'remove-leg',
            label: marker.role === 'STOP' ? 'Remove stop loss' : 'Remove take profit',
            icon: 'trash',
            danger: true,
            disabled: busy,
            run: () => void act(() => tradingApi.protect(accountId!, symbol, { [leg]: null })),
          },
          { id: 's1', separator: true },
          cancelAll,
        );
        return out;
      }

      const target = marker.drag?.kind === 'ORDER' ? marker.drag : null;
      if (target) {
        // A modify sets the order's TOTAL quantity, so a partially filled
        // order steps from its total and can never be cut below what has
        // already filled.
        const qty = target.qty;
        out.push(
          {
            id: 'qty-up',
            label: 'Add one contract',
            icon: 'plus',
            disabled: busy,
            run: () =>
              void act(() =>
                tradingApi.modify(accountId!, target.orderId, {
                  qty: qty + 1,
                  expectedVersion: target.version,
                }),
              ),
          },
          {
            id: 'qty-down',
            label: 'Remove one contract',
            icon: 'minus',
            disabled: busy || qty - 1 < Math.max(target.filledQty, 1),
            title:
              qty - 1 < Math.max(target.filledQty, 1)
                ? 'Cancel the order instead'
                : undefined,
            run: () =>
              void act(() =>
                tradingApi.modify(accountId!, target.orderId, {
                  qty: qty - 1,
                  expectedVersion: target.version,
                }),
              ),
          },
          { id: 's1', separator: true },
          {
            id: 'cancel',
            label: 'Cancel order',
            icon: 'trash',
            danger: true,
            disabled: busy,
            run: () => void act(() => tradingApi.cancel(accountId!, target.orderId)),
          },
        );
      }
      out.push({ id: 's2', separator: true }, cancelAll);
      return out;
    },
    [accountId, act, busy, position, symbol, workingOrders],
  );

  const openMenu = useCallback((event: React.MouseEvent, marker: Marker): void => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ key: marker.key, x: event.clientX, y: event.clientY });
  }, []);

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
        drag: {
          kind: 'ORDER',
          orderId: order.id,
          field: level.field,
          version: order.version,
          qty: order.qty,
          filledQty: order.filledQty,
        },
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

  /*
   * The menu closes by itself when its marker goes away - a cancelled order
   * has no options, and a menu left hanging over an empty line would apply to
   * nothing.
   */
  const menuMarker = menu ? markers.find((m) => m.key === menu.key) ?? null : null;

  // --- dragging an existing level -----------------------------------------

  const beginDrag = useCallback((event: React.PointerEvent, marker: Marker): void => {
    // A right-click opens the menu; it must not also start a drag.
    if (!marker.drag || event.button !== 0) return;
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
      if (!position || position.avgEntryPrice === null || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      createRef.current = {
        startY: event.clientY,
        active: false,
        // Null, not a guess: the first move decides, and starting at STOP
        // meant a downward drag matched it and never mounted the preview.
        leg: null,
        price: position.avgEntryPrice,
        pnl: 0,
        ticks: 0,
      };
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    },
    [position],
  );

  /**
   * Write the dragged level's numbers into the element.
   *
   * Price, distance in ticks and money, updated continuously: that is what a
   * trader reads while deciding where the stop goes, and it has to be the
   * current number rather than one a render cycle behind.
   */
  const paintPreview = useCallback(
    (create: {
      leg: 'STOP' | 'TARGET' | null;
      price: number;
      pnl: number | null;
      ticks: number;
    }): void => {
      const node = previewRef.current;
      if (!node || !create.leg) return;
      node.dataset['price'] = String(create.price);
      const price = node.querySelector<HTMLElement>('[data-preview-price]');
      if (price) price.textContent = create.price.toFixed(pricePrecision);
      const ticks = node.querySelector<HTMLElement>('[data-preview-ticks]');
      if (ticks) {
        ticks.textContent = `${create.leg === 'TARGET' ? '+' : '-'}${create.ticks} ticks`;
      }
      const pnl = node.querySelector<HTMLElement>('[data-preview-pnl]');
      if (pnl) {
        pnl.textContent = create.pnl === null ? '—' : formatMoney(create.pnl);
        pnl.classList.toggle('pos', (create.pnl ?? 0) >= 0);
        pnl.classList.toggle('neg', (create.pnl ?? 0) < 0);
      }
    },
    [pricePrecision],
  );

  useEffect(() => {
    if (!position || position.avgEntryPrice === null) return;
    const container = containerRef.current;
    if (!container) return;

    let rect = container.getBoundingClientRect();
    const remeasure = (): void => {
      rect = container.getBoundingClientRect();
    };
    window.addEventListener('resize', remeasure);

    const onMove = (event: PointerEvent): void => {
      const create = createRef.current;
      const adapter = adapterRef.current;
      if (!create || !adapter) return;
      // A small movement is a click on the marker, not a gesture.
      if (!create.active && Math.abs(event.clientY - create.startY) < DRAG_THRESHOLD_PX) return;
      create.active = true;

      const raw = adapter.yToPrice(event.clientY - rect.top);
      if (raw === null) return;
      const price = snap(raw, tickSize);
      // Against the market the position would exit at, which is the side the
      // engine checks: see legFor.
      const leg = legFor(position, price, position.markPrice);
      if (!leg) return;

      create.price = price;
      create.pnl = estimatePnlMicros(position, price, tickSize, tickValueMicros);
      create.ticks = Math.round(Math.abs(price - (position.avgEntryPrice ?? price)) / tickSize);

      // Only a change of LEG needs React: the element's colour and its SL/TP
      // label come from it. Everything else is written directly.
      if (create.leg !== leg) {
        create.leg = leg;
        setCreating({ leg });
        return;
      }
      paintPreview(create);
    };

    const onUp = (): void => {
      const create = createRef.current;
      createRef.current = null;
      if (!create?.active) {
        setCreating(null);
        return;
      }
      setCreating(null);
      // ONE request, on release: nothing about this gesture reached the server
      // while the pointer was moving.
      if (accountId && create.leg) {
        void act(() =>
          tradingApi.protect(accountId, symbol, {
            [create.leg === 'STOP' ? 'stopPrice' : 'targetPrice']: create.price,
          }),
        );
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [accountId, act, adapterRef, containerRef, position, symbol, tickSize, tickValueMicros]);

  // --- placement, off the React tree --------------------------------------

  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    let lastSignature = '';
    let lastHeight = 0;
    let heightAt = 0;

    const place = (): void => {
      frame = requestAnimationFrame(place);
      const adapter = adapterRef.current;
      const container = containerRef.current;
      if (!adapter || !container) return;

      /*
       * Nothing is written unless something moved.
       *
       * This loop used to re-measure the container, re-measure the axis, run
       * the label layout and write to every marker on every frame whether or
       * not a price or the scale had changed - which a CPU profile showed as
       * one of the largest pieces of application JavaScript while the mouse
       * moved. The signature below is everything that can change what the
       * markers look like: where two reference prices land, the prices
       * themselves, and the size of the plot.
       */
      const drag = dragRef.current;
      const now = performance.now();
      if (now - heightAt > 250) {
        heightAt = now;
        lastHeight = container.clientHeight;
      }
      const height = lastHeight;

      let signature = `${adapter.priceToY(0) ?? 'x'}:${adapter.priceToY(1_000) ?? 'x'}:${height}`;
      for (const [key, node] of nodesRef.current) {
        signature += `|${key}=${node.dataset['price'] ?? ''}`;
      }
      signature += `|drag=${drag ? `${drag.key}:${drag.price}` : '-'}`;
      signature += `|preview=${previewRef.current?.dataset['price'] ?? '-'}`;
      if (signature === lastSignature) return;
      lastSignature = signature;

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

        /*
         * The three numbers a trader reads while moving a level: where it is,
         * how far that is in ticks, and what it is worth.
         *
         * Written here rather than rendered, so they follow the pointer
         * instead of arriving a render behind it. Off a drag they are written
         * once too, which keeps them true after a fill moves the average.
         */
        const live = liveRef.current;
        const entry = live.position?.avgEntryPrice ?? null;
        const ticksLabel = node.querySelector<HTMLElement>('[data-ticks-label]');
        const pnlLabel = node.querySelector<HTMLElement>('[data-pnl-label]');
        if ((ticksLabel || pnlLabel) && entry !== null && live.position) {
          const ticks = Math.round(Math.abs(info.price - entry) / live.tickSize);
          const money = estimatePnlMicros(
            live.position,
            info.price,
            live.tickSize,
            live.tickValueMicros,
          );
          // Null means the position has no average entry yet, so the level is
          // not worth anything definite. Blank beats a confident zero.
          if (ticksLabel) {
            ticksLabel.textContent = money === null ? '' : `${money >= 0 ? '+' : '-'}${ticks}t`;
          }
          if (pnlLabel) {
            pnlLabel.textContent =
              money === null ? '' : live.showPnl ? formatMoney(money) : MASK;
            pnlLabel.classList.toggle('pos', money !== null && money >= 0);
            pnlLabel.classList.toggle('neg', money !== null && money < 0);
          }
        }
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

  // A leg change re-renders the preview element, which arrives empty; the
  // numbers are written back into it as soon as it is on the page.
  useEffect(() => {
    if (creating && createRef.current) paintPreview(createRef.current);
  }, [creating, paintPreview]);

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
          data-testid="marker-preview"
          ref={previewRef}
        >
          <div className="pm-rule" />
          <div className="pm-tag">
            <span className="pm-kind">{creating.leg === 'STOP' ? 'SL' : 'TP'}</span>
            <span className="num pm-ticks" data-preview-ticks />
            <span className="num pm-pnl" data-preview-pnl />
            <span className="num pm-price" data-preview-price />
          </div>
        </div>
      ) : null}

      {markers.map((marker) => {
        const isPosition = marker.role === 'POSITION';
        const isProtective = marker.role === 'STOP' || marker.role === 'TARGET';
        const isDragging = dragging === marker.key;
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
                onContextMenu={(event) => openMenu(event, marker)}
                title="Drag up or down to place a target or a stop"
              >
                <span
                  className={`num pm-pos-pnl ${
                    showPnl ? ((marker.pnlMicros ?? 0) >= 0 ? 'up' : 'down') : ''
                  }`}
                >
                  {showPnl ? formatMoney(marker.pnlMicros ?? 0) : MASK}
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
                className={[
                  'pm-tag',
                  marker.drag ? 'pm-tag-drag' : '',
                  isProtective ? 'pm-tag-protective' : '',
                  isProtective && !isDragging ? 'pm-tag-money-only' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                data-testid={`marker-${marker.role.toLowerCase()}`}
                onPointerDown={(event) => beginDrag(event, marker)}
                onContextMenu={(event) => openMenu(event, marker)}
                title={marker.drag ? 'Drag to move this level' : undefined}
              >
                {/*
                  A PROTECTIVE LEVEL SHOWS ONE NUMBER: WHAT IT IS WORTH.
                  =====================================================
                  It used to carry the leg, the ticks, the dollars, the price,
                  the quantity and a cancel button - six things on a label that
                  exists to be read out of the corner of an eye while watching
                  price. The dollar amount is the one a trader acts on, and the
                  colour of the box already says which leg it is: red below a
                  long is a stop, green above it is a target.

                  The rest is not lost. Dragging the level shows the
                  destination price, the ticks and the estimated P&L, because
                  those are what a trader needs WHILE placing it - and the
                  instant the pointer is released it collapses back to the
                  dollars. Right-clicking the level still offers every action,
                  including removing it, which is what the cancel button was
                  for.
                */}
                {isProtective ? (
                  <>
                    {isDragging ? (
                      <>
                        <span className="pm-kind">{marker.label}</span>
                        <span className="num pm-ticks" data-ticks-label />
                        <span className="num pm-price" data-price-label>
                          {marker.price.toFixed(pricePrecision)}
                        </span>
                      </>
                    ) : null}
                    <span className="num pm-pnl" data-pnl-label />
                  </>
                ) : (
                  <>
                    <span className="pm-kind">{marker.label}</span>
                    <span className="num pm-price" data-price-label>
                      {marker.price.toFixed(pricePrecision)}
                    </span>
                    {marker.qty !== null ? <span className="num pm-qty">{marker.qty}</span> : null}
                  </>
                )}
                {marker.cancel && !isProtective ? (
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

      {/* Right-clicking a level offers what can be done to it. */}
      {menuMarker ? (
        <ChartMenu
          head={menuHead(menuMarker, pricePrecision)}
          x={menu!.x}
          y={menu!.y}
          testId="order-context-menu"
          items={menuItems(menuMarker)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

/** The menu's title: what was right-clicked, and where it sits. */
function menuHead(marker: Marker, pricePrecision: number): string {
  const what =
    marker.role === 'POSITION'
      ? `${marker.label} ${marker.qty ?? ''}`.trim()
      : marker.role === 'STOP'
        ? 'Stop loss'
        : marker.role === 'TARGET'
          ? 'Take profit'
          : marker.label;
  return `${what} \u00b7 ${marker.price.toFixed(pricePrecision)}`;
}

function formatMoney(micros: number): string {
  const dollars = micros / 1_000_000;
  const sign = dollars > 0 ? '+' : dollars < 0 ? '−' : '';
  return `${sign}$${Math.abs(dollars).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export { newClientOrderId };
