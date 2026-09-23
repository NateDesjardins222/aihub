/**
 * The drawing surface.
 *
 * A painting surface and NEVER an input surface: `pointer-events: none` is not
 * conditional. An earlier version turned pointer events on as soon as any
 * drawing existed, which meant the canvas swallowed every pan and zoom - the
 * chart appeared to freeze the moment a trend line was drawn. Input is owned
 * by useDrawingInput, which decides per gesture whether the chart or the
 * drawings should have it.
 *
 * It repaints on CHANGE, not on the clock. The old loop cleared and redrew
 * every frame whether or not anything had moved, which cost a fifth of the
 * main thread while the terminal sat still (docs/chart-performance-audit.md).
 * Now each frame compares a cheap signature - the drawings, the selection, the
 * live gesture, the hover, and two reference conversions that change whenever
 * the view does - and returns immediately when it matches.
 */
import { useEffect, useRef, type JSX } from 'react';
import type { ChartAdapter } from '../ChartAdapter';
import { useChartStore } from '../../state/chart-store';
import { drawDrawing, type PaintState } from './paint';
import { timeframeMs } from './measure';
import { projectionSignature, type BoundsCache } from './bounds';
import { liveState, paintedVersion } from './interaction';
import type { Projection } from './model';
import './DrawingCanvas.css';

export interface DrawingCanvasProps {
  readonly adapterRef: React.RefObject<ChartAdapter | null>;
  readonly symbol: string;
  readonly pricePrecision: number;
  /** For the position tools, which price a trade in ticks and in dollars. */
  readonly tickSize: number;
  readonly tickValueMicros: number;
  /** The chart interval, so the measure tool can count bars correctly. */
  readonly timeframe: string;
  readonly ready: boolean;
  /** Shared with the input machine, so both agree where things are. */
  readonly boundsRef: React.RefObject<BoundsCache>;
}

export function DrawingCanvas({
  adapterRef,
  symbol,
  pricePrecision,
  tickSize,
  tickValueMicros,
  timeframe,
  ready,
  boundsRef,
}: DrawingCanvasProps): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Read by the frame loop, which must not wait for a render to be current.
  // Subscribing transiently rather than with a hook keeps a drawing edit from
  // re-rendering this component at all: the canvas is painted, not rendered.
  const liveRef = useRef({
    drawings: useChartStore.getState().drawings,
    selectedId: useChartStore.getState().selectedDrawingId,
    tool: useChartStore.getState().tool,
    symbol,
    pricePrecision,
    market: {
      tickSize,
      tickValue: tickValueMicros / 1_000_000,
      barMs: timeframeMs(timeframe) ?? undefined,
    },
  });
  liveRef.current.symbol = symbol;
  liveRef.current.pricePrecision = pricePrecision;
  liveRef.current.market = {
    tickSize,
    tickValue: tickValueMicros / 1_000_000,
    barMs: timeframeMs(timeframe) ?? undefined,
  };

  useEffect(() => {
    const apply = (state: ReturnType<typeof useChartStore.getState>): void => {
      liveRef.current.drawings = state.drawings;
      liveRef.current.selectedId = state.selectedDrawingId;
      liveRef.current.tool = state.tool;
    };
    apply(useChartStore.getState());
    return useChartStore.subscribe(apply);
  }, []);

  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    let lastSignature = '';
    // Identity of the drawing array last painted. Zustand replaces the array
    // on every edit, so comparing references is a complete change check.
    let lastDrawings = liveRef.current.drawings;
    let drawingsEpoch = 0;

    const render = (): void => {
      frame = requestAnimationFrame(render);
      const canvas = canvasRef.current;
      const projection = adapterRef.current?.projection() ?? null;
      if (!canvas || !projection) return;

      const live = liveState();
      const state = liveRef.current;

      /*
       * Everything that can change what is on screen, in one string. The two
       * conversions inside projectionSignature catch a pan, a zoom, a price
       * scale change and a resize; the rest catch an edit, a selection, a
       * gesture and a hover.
       *
       * The device pixel ratio is in the signature too: a browser zoom or a drag
       * to a monitor of a different density changes it WITHOUT changing the
       * logical projection, and the overlay would stay at the old backing-store
       * resolution — crisp chart, blurry drawings — until the next unrelated
       * repaint. Including it repaints at the new ratio the moment it changes.
       */
      const ratio = window.devicePixelRatio || 1;
      if (state.drawings !== lastDrawings) {
        lastDrawings = state.drawings;
        drawingsEpoch += 1;
      }
      const signature = [
        projectionSignature(projection),
        drawingsEpoch,
        state.selectedId ?? '-',
        state.tool,
        state.symbol,
        live.version,
        live.hoverId ?? '-',
        ratio,
      ].join('|');
      if (signature === lastSignature) return;
      lastSignature = signature;

      const width = projection.width;
      const height = projection.height;
      if (
        canvas.width !== Math.floor(width * ratio) ||
        canvas.height !== Math.floor(height * ratio)
      ) {
        canvas.width = Math.floor(width * ratio);
        canvas.height = Math.floor(height * ratio);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);

      boundsRef.current.sync(projection);

      for (const stored of state.drawings) {
        if (stored.symbol !== state.symbol || stored.hidden) continue;
        // The gesture's working copy while one is in flight, so a drag paints
        // at pointer rate without the store hearing about it.
        const drawing = paintedVersion(stored);
        const paintState: PaintState =
          drawing.id === state.selectedId
            ? 'SELECTED'
            : drawing.id === live.hoverId
              ? 'HOVER'
              : 'NORMAL';
        drawDrawing(
          ctx,
          drawing,
          projection as Projection,
          paintState,
          state.pricePrecision,
          state.market,
        );
      }

      // The preview belongs to a placement in progress. With no tool armed
      // there is no placement, so a stale one is never painted.
      if (live.preview && state.tool !== 'CURSOR') {
        drawDrawing(
          ctx,
          live.preview,
          projection as Projection,
          'PENDING',
          state.pricePrecision,
          state.market,
        );
      }

      // The magnet's mark: a small ring on the open/high/low/close the anchor
      // snapped to, so a trader can SEE the snap rather than guess at it. Drawn
      // only while `snap` is set - placement or an anchor reshape with the
      // magnet on - and cleared the instant the anchor is free again.
      if (live.snap) {
        const accent =
          getComputedStyle(canvas).getPropertyValue('--accent').trim() || '#4d8dff';
        const { x, y } = live.snap;
        ctx.save();
        ctx.strokeStyle = accent;
        ctx.fillStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(x, y, 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [adapterRef, boundsRef, ready]);

  if (!ready) return null;
  return <canvas ref={canvasRef} className="draw-canvas" data-testid="drawing-layer" />;
}
