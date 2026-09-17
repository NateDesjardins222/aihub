/**
 * The drawing surface.
 *
 * A canvas over the chart, redrawn in the same animation frame discipline the
 * rest of the terminal uses: panning the chart moves a hundred drawings without
 * a single React render. React owns only what the trader has drawn, not where
 * it currently is on screen.
 *
 * Interaction is deliberately conventional, because a drawing tool that behaves
 * unusually is a drawing tool nobody trusts: click to place, click again to
 * finish, hover to highlight, click to select, drag the body to move, drag a
 * handle to reshape, Escape to abandon, Delete to remove.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { ChartAdapter } from '../ChartAdapter';
import { useChartStore } from '../../state/chart-store';
import {
  ANCHOR_COUNT,
  FIB_LEVELS,
  HANDLE_RADIUS,
  fibLevels,
  handlePoints,
  hitTest,
  magnetAnchor,
  moveAnchor,
  project,
  translate,
  type Anchor,
  type Drawing,
  type DrawingKind,
  type Point,
  type Projection,
} from './model';
import './DrawingLayer.css';

export interface DrawingLayerProps {
  readonly adapterRef: React.RefObject<ChartAdapter | null>;
  readonly symbol: string;
  readonly pricePrecision: number;
  readonly tickSize: number;
  readonly ready: boolean;
}

interface Gesture {
  readonly mode: 'MOVE' | 'RESHAPE';
  readonly drawingId: string;
  readonly anchorIndex: number;
  readonly from: Anchor;
  readonly original: Drawing;
}

function newId(): string {
  return `draw-${Math.random().toString(36).slice(2, 10)}`;
}

export function DrawingLayer({
  adapterRef,
  symbol,
  pricePrecision,
  tickSize,
  ready,
}: DrawingLayerProps): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tool = useChartStore((s) => s.tool);
  const magnet = useChartStore((s) => s.magnet);
  const drawings = useChartStore((s) => s.drawings);
  const selectedId = useChartStore((s) => s.selectedDrawingId);
  const defaultStyle = useChartStore((s) => s.defaultStyle);
  const addDrawing = useChartStore((s) => s.addDrawing);
  const updateDrawing = useChartStore((s) => s.updateDrawing);
  const removeDrawing = useChartStore((s) => s.removeDrawing);
  const duplicateDrawing = useChartStore((s) => s.duplicateDrawing);
  const select = useChartStore((s) => s.select);
  const setTool = useChartStore((s) => s.setTool);

  /** Anchors placed so far for the drawing being created. */
  const [pending, setPending] = useState<readonly Anchor[]>([]);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Read by the animation frame, which must not depend on a render to be current.
  const liveRef = useRef({
    drawings,
    selectedId,
    hoverId,
    pending,
    tool,
    cursor: null as Point | null,
    gesture: null as Gesture | null,
    symbol,
  });
  liveRef.current.drawings = drawings;
  liveRef.current.selectedId = selectedId;
  liveRef.current.hoverId = hoverId;
  liveRef.current.pending = pending;
  liveRef.current.tool = tool;
  liveRef.current.symbol = symbol;

  const mine = useCallback(
    (list: readonly Drawing[]): Drawing[] => list.filter((drawing) => drawing.symbol === symbol),
    [symbol],
  );

  const projectionOf = useCallback((): Projection | null => {
    const adapter = adapterRef.current;
    if (!adapter) return null;
    return adapter.projection();
  }, [adapterRef]);

  const anchorAt = useCallback(
    (point: Point): Anchor | null => {
      const adapter = adapterRef.current;
      const projection = projectionOf();
      if (!adapter || !projection) return null;
      const time = projection.xToTime(point.x);
      const price = projection.yToPrice(point.y);
      if (time === null || price === null) return null;
      const raw: Anchor = { time, price };
      if (!magnet) return raw;
      // The magnet snaps to a price the bar actually printed - never to a value
      // between them - and to that bar's own time.
      const bar = adapter.barNear(time);
      const tolerance = tickSize * 8;
      return magnetAnchor(raw, bar, tolerance);
    },
    [adapterRef, magnet, projectionOf, tickSize],
  );

  // --- drawing ------------------------------------------------------------

  useEffect(() => {
    if (!ready) return;
    let frame = 0;

    const render = (): void => {
      frame = requestAnimationFrame(render);
      const canvas = canvasRef.current;
      const projection = projectionOf();
      if (!canvas || !projection) return;

      const ratio = window.devicePixelRatio || 1;
      // projection.width is the PLOT width, which is what the canvas is sized
      // to: a drawing must not paint over the price axis.
      const width = projection.width;
      const height = projection.height;
      if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
        canvas.width = Math.floor(width * ratio);
        canvas.height = Math.floor(height * ratio);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const live = liveRef.current;
      for (const drawing of live.drawings) {
        if (drawing.symbol !== live.symbol) continue;
        if (drawing.hidden) continue;
        const state =
          drawing.id === live.selectedId
            ? 'SELECTED'
            : drawing.id === live.hoverId
              ? 'HOVER'
              : 'NORMAL';
        paint(ctx, drawing, projection, state, pricePrecision);
      }

      // The drawing in progress, previewed to the cursor.
      if (live.pending.length > 0 && live.tool !== 'CURSOR') {
        const kind = live.tool as DrawingKind;
        const anchors = [...live.pending];
        if (anchors.length < ANCHOR_COUNT[kind] && live.cursor) {
          const projectionTime = projection.xToTime(live.cursor.x);
          const projectionPrice = projection.yToPrice(live.cursor.y);
          if (projectionTime !== null && projectionPrice !== null) {
            anchors.push({ time: projectionTime, price: projectionPrice });
          }
        }
        if (anchors.length >= 1) {
          paint(
            ctx,
            {
              id: 'pending',
              kind,
              symbol: live.symbol,
              anchors,
              style: defaultStyle,
              text: '',
              locked: false,
              hidden: false,
              createdAt: 0,
            },
            projection,
            'PENDING',
            pricePrecision,
          );
        }
      }
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [defaultStyle, pricePrecision, projectionOf, ready]);

  // --- pointer handling ---------------------------------------------------

  const localPoint = useCallback((event: PointerEvent | React.PointerEvent): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent): void => {
      if (event.button !== 0) return;
      const projection = projectionOf();
      if (!projection) return;
      const point = localPoint(event);

      // Placing a new drawing.
      if (tool !== 'CURSOR') {
        const anchor = anchorAt(point);
        if (!anchor) return;
        const needed = ANCHOR_COUNT[tool];
        const anchors = [...pending, anchor];
        if (anchors.length >= needed) {
          addDrawing({
            id: newId(),
            kind: tool,
            symbol,
            anchors,
            style: defaultStyle,
            text: tool === 'TEXT' ? 'Text' : '',
            locked: false,
            hidden: false,
            createdAt: Date.now(),
          });
          setPending([]);
        } else {
          setPending(anchors);
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // Selecting or grabbing an existing one. Topmost first, so the drawing
      // most recently made wins where two overlap.
      const candidates = [...mine(drawings)].reverse();
      for (const drawing of candidates) {
        const hit = hitTest(drawing, projection, point, drawing.id === selectedId);
        if (!hit) continue;
        select(drawing.id);
        if (drawing.locked) {
          event.preventDefault();
          return;
        }
        const anchor = anchorAt(point);
        if (!anchor) return;
        liveRef.current.gesture = {
          mode: hit.kind === 'HANDLE' ? 'RESHAPE' : 'MOVE',
          drawingId: drawing.id,
          anchorIndex: hit.kind === 'HANDLE' ? hit.index : 0,
          from: anchor,
          original: drawing,
        };
        (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // Nothing hit: clear the selection and let the chart have the event, so
      // the drawing layer never swallows a pan.
      if (selectedId) select(null);
    },
    [
      addDrawing,
      anchorAt,
      defaultStyle,
      drawings,
      localPoint,
      mine,
      pending,
      projectionOf,
      select,
      selectedId,
      symbol,
      tool,
    ],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent): void => {
      const projection = projectionOf();
      if (!projection) return;
      const point = localPoint(event);
      liveRef.current.cursor = point;

      const gesture = liveRef.current.gesture;
      if (gesture) {
        const anchor = anchorAt(point);
        if (!anchor) return;
        if (gesture.mode === 'MOVE') {
          updateDrawing(
            gesture.drawingId,
            translate(
              gesture.original,
              anchor.time - gesture.from.time,
              anchor.price - gesture.from.price,
            ),
          );
        } else {
          updateDrawing(gesture.drawingId, moveAnchor(gesture.original, gesture.anchorIndex, anchor));
        }
        return;
      }

      if (tool !== 'CURSOR') return;

      // Hover highlight. Cheap: a handful of arithmetic per drawing.
      let found: string | null = null;
      for (const drawing of [...mine(drawings)].reverse()) {
        if (hitTest(drawing, projection, point, drawing.id === selectedId)) {
          found = drawing.id;
          break;
        }
      }
      if (found !== liveRef.current.hoverId) setHoverId(found);
    },
    [anchorAt, drawings, localPoint, mine, projectionOf, selectedId, tool, updateDrawing],
  );

  const endGesture = useCallback((): void => {
    liveRef.current.gesture = null;
  }, []);

  // Escape abandons a part-placed drawing; Delete removes the selection.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      // Never steal a key from an input: the journal and the settings dialog
      // are full of them.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (event.key === 'Escape') {
        if (pending.length > 0) setPending([]);
        else if (tool !== 'CURSOR') setTool('CURSOR');
        else if (selectedId) select(null);
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        const drawing = drawings.find((d) => d.id === selectedId);
        if (drawing && !drawing.locked) removeDrawing(selectedId);
        event.preventDefault();
        return;
      }
      if (event.key.toLowerCase() === 'd' && (event.ctrlKey || event.metaKey) && selectedId) {
        duplicateDrawing(selectedId);
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawings, duplicateDrawing, pending.length, removeDrawing, select, selectedId, setTool, tool]);

  if (!ready) return null;

  const drawingCursor = tool !== 'CURSOR' ? 'crosshair' : hoverId ? 'pointer' : 'default';
  // Pointer events are only captured when there is something to capture them
  // for. Otherwise the chart keeps its own pan and zoom.
  const interactive = tool !== 'CURSOR' || mine(drawings).length > 0;

  return (
    <canvas
      ref={canvasRef}
      className="draw-layer"
      data-testid="drawing-layer"
      style={{ pointerEvents: interactive ? 'auto' : 'none', cursor: drawingCursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onPointerLeave={() => {
        liveRef.current.cursor = null;
        setHoverId(null);
      }}
    />
  );
}

type PaintState = 'NORMAL' | 'HOVER' | 'SELECTED' | 'PENDING';

function dashPattern(dash: Drawing['style']['dash']): number[] {
  if (dash === 'DASHED') return [6, 4];
  if (dash === 'DOTTED') return [1, 3];
  return [];
}

/**
 * Paint one drawing.
 *
 * Separated from the component so it is a plain function of (drawing,
 * projection, state) - no closures over React state, nothing to go stale.
 */
function paint(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  projection: Projection,
  state: PaintState,
  pricePrecision: number,
): void {
  const points = drawing.anchors.map((anchor) => project(projection, anchor));
  if (points.some((point) => point === null)) {
    // A drawing whose anchors are off the current view is still drawn where its
    // geometry allows - a horizontal line needs only its price.
    if (drawing.kind !== 'HORIZONTAL_LINE' && drawing.kind !== 'VERTICAL_LINE') {
      if (points[0] === null) return;
    }
  }

  ctx.save();
  ctx.strokeStyle = drawing.style.color;
  ctx.fillStyle = drawing.style.color;
  ctx.lineWidth = drawing.style.width + (state === 'HOVER' ? 1 : 0);
  ctx.globalAlpha = state === 'PENDING' ? 0.7 : 1;
  ctx.setLineDash(state === 'PENDING' ? [4, 3] : dashPattern(drawing.style.dash));
  ctx.lineCap = 'round';

  const a = points[0];
  const b = points[1];

  switch (drawing.kind) {
    case 'HORIZONTAL_LINE': {
      if (!a) break;
      line(ctx, { x: 0, y: a.y }, { x: projection.width, y: a.y });
      if (drawing.style.showPrice) {
        priceTag(ctx, projection, a.y, drawing.anchors[0]!.price, drawing.style.color, pricePrecision);
      }
      break;
    }
    case 'VERTICAL_LINE': {
      if (!a) break;
      line(ctx, { x: a.x, y: 0 }, { x: a.x, y: projection.height });
      break;
    }
    case 'RAY': {
      if (!a || !b) break;
      line(ctx, a, extend(a, b, projection));
      break;
    }
    case 'EXTENDED_LINE': {
      if (!a || !b) break;
      line(ctx, extend(b, a, projection), extend(a, b, projection));
      break;
    }
    case 'RECTANGLE': {
      if (!a || !b) break;
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      if (drawing.style.fill) {
        ctx.save();
        ctx.fillStyle = drawing.style.fill;
        ctx.fillRect(x, y, w, h);
        ctx.restore();
      }
      ctx.strokeRect(x, y, w, h);
      break;
    }
    case 'FIB_RETRACEMENT': {
      if (!a || !b) break;
      const left = Math.min(a.x, b.x);
      const right = Math.max(a.x, b.x);
      const levels = fibLevels(drawing);
      ctx.setLineDash([]);
      for (let i = 0; i < levels.length; i += 1) {
        const level = levels[i]!;
        const y = projection.priceToY(level.price);
        if (y === null) continue;
        ctx.globalAlpha = state === 'PENDING' ? 0.5 : 0.85;
        line(ctx, { x: left, y }, { x: right, y });
        ctx.globalAlpha = 1;
        ctx.font = `${drawing.style.fontSize}px ui-monospace, monospace`;
        ctx.textBaseline = 'bottom';
        ctx.fillText(
          `${(FIB_LEVELS[i]! * 100).toFixed(1)}%  ${level.price.toFixed(pricePrecision)}`,
          left + 4,
          y - 2,
        );
      }
      break;
    }
    case 'TEXT': {
      if (!a) break;
      ctx.setLineDash([]);
      ctx.font = `${drawing.style.fontSize}px var(--font-ui), system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText(drawing.text || 'Text', a.x, a.y);
      break;
    }
    case 'MEASURE': {
      if (!a || !b) break;
      const priceFrom = drawing.anchors[0]!.price;
      const priceTo = drawing.anchors[1]!.price;
      const delta = priceTo - priceFrom;
      ctx.save();
      ctx.fillStyle = delta >= 0 ? 'rgba(46,196,166,0.12)' : 'rgba(242,84,75,0.12)';
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.restore();
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.setLineDash([]);
      ctx.font = `${drawing.style.fontSize}px ui-monospace, monospace`;
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = delta >= 0 ? '#2ec4a6' : '#f2544b';
      const bars = Math.round(Math.abs(drawing.anchors[1]!.time - drawing.anchors[0]!.time) / 60_000);
      ctx.fillText(
        `${delta >= 0 ? '+' : ''}${delta.toFixed(pricePrecision)}   ${bars}m`,
        Math.min(a.x, b.x) + 4,
        Math.min(a.y, b.y) - 3,
      );
      break;
    }
    default: {
      if (!a || !b) break;
      line(ctx, a, b);
    }
  }

  // Handles, on the selected drawing only. Hollow squares: they read as grab
  // points and stay visible over any candle colour.
  if (state === 'SELECTED') {
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    for (const handle of handlePoints(drawing, projection)) {
      ctx.fillStyle = '#0b0e14';
      ctx.strokeStyle = drawing.style.color;
      ctx.beginPath();
      ctx.rect(
        handle.x - HANDLE_RADIUS,
        handle.y - HANDLE_RADIUS,
        HANDLE_RADIUS * 2,
        HANDLE_RADIUS * 2,
      );
      ctx.fill();
      ctx.stroke();
    }
  }

  ctx.restore();
}

function line(ctx: CanvasRenderingContext2D, from: Point, to: Point): void {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

/** Push `b` out past the edge of the canvas along the a-b direction. */
function extend(a: Point, b: Point, projection: Projection): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return b;
  const reach = projection.width + projection.height;
  return { x: b.x + (dx / length) * reach, y: b.y + (dy / length) * reach };
}

function priceTag(
  ctx: CanvasRenderingContext2D,
  projection: Projection,
  y: number,
  price: number,
  color: string,
  pricePrecision: number,
): void {
  const text = price.toFixed(pricePrecision);
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = '10px ui-monospace, monospace';
  const width = ctx.measureText(text).width + 8;
  ctx.fillStyle = color;
  ctx.fillRect(projection.width - width - 2, y - 7, width, 14);
  ctx.fillStyle = '#07090d';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, projection.width - width + 2, y);
  ctx.restore();
}
