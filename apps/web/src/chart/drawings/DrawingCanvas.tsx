/**
 * The drawing surface.
 *
 * A painting surface and NEVER an input surface: `pointer-events: none` is not
 * conditional. The previous version turned pointer events on as soon as any
 * drawing existed, which meant the canvas swallowed every pan and zoom - the
 * chart appeared to freeze the moment a trend line was drawn. Input is owned by
 * useDrawingInput, which decides per gesture whether the chart or the drawings
 * should have it.
 *
 * It repaints in an animation frame, like the rest of the terminal: panning the
 * chart moves a hundred drawings without a single React render.
 */
import { useEffect, useRef, type JSX } from 'react';
import type { ChartAdapter } from '../ChartAdapter';
import { useChartStore } from '../../state/chart-store';
import { drawDrawing, type PaintState } from './paint';
import type { Drawing, Projection } from './model';
import './DrawingCanvas.css';

export interface DrawingCanvasProps {
  readonly adapterRef: React.RefObject<ChartAdapter | null>;
  readonly symbol: string;
  readonly pricePrecision: number;
  readonly ready: boolean;
  /** Live gesture state, written by the input machine, read every frame. */
  readonly previewRef: React.RefObject<PreviewState | null>;
}

/** What the input machine wants drawn on top of the committed drawings. */
export interface PreviewState {
  /** A drawing being placed, or the ghost of one being dragged. */
  readonly drawing: Drawing | null;
  readonly hoverId: string | null;
}

export function DrawingCanvas({
  adapterRef,
  symbol,
  pricePrecision,
  ready,
  previewRef,
}: DrawingCanvasProps): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawings = useChartStore((s) => s.drawings);
  const selectedId = useChartStore((s) => s.selectedDrawingId);
  const tool = useChartStore((s) => s.tool);

  // Read by the frame loop, which must not wait for a render to be current.
  const liveRef = useRef({ drawings, selectedId, symbol, tool });
  liveRef.current.drawings = drawings;
  liveRef.current.selectedId = selectedId;
  liveRef.current.symbol = symbol;
  liveRef.current.tool = tool;

  useEffect(() => {
    if (!ready) return;
    let frame = 0;

    const render = (): void => {
      frame = requestAnimationFrame(render);
      const canvas = canvasRef.current;
      const projection = adapterRef.current?.projection() ?? null;
      if (!canvas || !projection) return;

      const ratio = window.devicePixelRatio || 1;
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

      const live = liveRef.current;
      const preview = previewRef.current;

      for (const drawing of live.drawings) {
        if (drawing.symbol !== live.symbol || drawing.hidden) continue;
        const state: PaintState =
          drawing.id === live.selectedId
            ? 'SELECTED'
            : drawing.id === preview?.hoverId
              ? 'HOVER'
              : 'NORMAL';
        drawDrawing(ctx, drawing, projection as Projection, state, pricePrecision);
      }

      // The preview belongs to a placement in progress. With no tool armed
      // there is no placement, so a stale one is never painted.
      if (preview?.drawing && live.tool !== 'CURSOR') {
        drawDrawing(ctx, preview.drawing, projection as Projection, 'PENDING', pricePrecision);
      }
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [adapterRef, pricePrecision, previewRef, ready]);

  if (!ready) return null;
  return <canvas ref={canvasRef} className="draw-canvas" data-testid="drawing-layer" />;
}
