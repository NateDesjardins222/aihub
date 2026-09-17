/**
 * Who owns the pointer.
 *
 * This is the whole of the chart-freeze fix, stated as a rule:
 *
 *   The chart owns every gesture unless the drawings can prove a claim to it.
 *
 * Listeners are attached to the chart container in the CAPTURE phase, so this
 * machine sees a pointerdown before the renderer does and can decide. It calls
 * stopPropagation ONLY when the drawings are taking the gesture - arming a
 * tool, hitting an existing drawing, or continuing a drag. Every other press
 * falls straight through to the chart, so panning and zooming behave exactly as
 * they do with no drawings on screen.
 *
 * After a placement finishes the machine returns to IDLE unless the trader has
 * asked to stay in drawing mode, so the very next click pans.
 */
import { useEffect, useRef } from 'react';
import type { ChartAdapter } from '../ChartAdapter';
import { useChartStore } from '../../state/chart-store';
import {
  ANCHOR_COUNT,
  hitTest,
  magnetAnchor,
  moveAnchor,
  translate,
  type Anchor,
  type Drawing,
  type DrawingKind,
  type Point,
  type Projection,
} from './model';
import type { PreviewState } from './DrawingCanvas';

export type InputState = 'IDLE' | 'PLACING' | 'DRAGGING';

export interface DrawingInputOptions {
  readonly adapterRef: React.RefObject<ChartAdapter | null>;
  readonly containerRef: React.RefObject<HTMLElement | null>;
  readonly symbol: string;
  readonly tickSize: number;
  readonly ready: boolean;
  /** Written every frame for the canvas to paint. */
  readonly previewRef: React.RefObject<PreviewState | null>;
}

interface Gesture {
  readonly mode: 'MOVE' | 'RESHAPE';
  readonly drawingId: string;
  readonly anchorIndex: number;
  readonly from: Anchor;
  readonly original: Drawing;
}

function newId(): string {
  return `draw-${crypto.randomUUID()}`;
}

export function useDrawingInput(options: DrawingInputOptions): void {
  const { adapterRef, containerRef, symbol, tickSize, ready, previewRef } = options;

  // Everything the listeners need, in a ref: the listeners are attached once
  // and must never be rebound on a store change, or a gesture in flight would
  // lose its handlers mid-drag.
  const live = useRef({ symbol, tickSize });
  live.current.symbol = symbol;
  live.current.tickSize = tickSize;

  const stateRef = useRef<InputState>('IDLE');
  const pendingRef = useRef<Anchor[]>([]);
  const gestureRef = useRef<Gesture | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ready) return;

    const projection = (): Projection | null => adapterRef.current?.projection() ?? null;

    const pointAt = (event: PointerEvent | MouseEvent): Point => {
      const rect = container.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const anchorAt = (point: Point): Anchor | null => {
      const adapter = adapterRef.current;
      const view = projection();
      if (!adapter || !view) return null;
      const time = view.xToTime(point.x);
      const price = view.yToPrice(point.y);
      if (time === null || price === null) return null;
      const raw: Anchor = { time, price };
      if (!useChartStore.getState().magnet) return raw;
      // The magnet snaps to a price the bar actually printed, never between.
      return magnetAnchor(raw, adapter.barNear(time), live.current.tickSize * 8);
    };

    const mine = (): Drawing[] =>
      useChartStore.getState().drawings.filter((d) => d.symbol === live.current.symbol);

    /** The topmost drawing under the cursor, most recent first. */
    const pick = (point: Point) => {
      const view = projection();
      if (!view) return null;
      const selectedId = useChartStore.getState().selectedDrawingId;
      for (const drawing of [...mine()].reverse()) {
        const hit = hitTest(drawing, view, point, drawing.id === selectedId);
        if (hit) return { drawing, hit };
      }
      return null;
    };

    const setPreview = (patch: Partial<PreviewState>): void => {
      previewRef.current = {
        drawing: patch.drawing ?? previewRef.current?.drawing ?? null,
        hoverId: patch.hoverId !== undefined ? patch.hoverId : (previewRef.current?.hoverId ?? null),
      };
    };

    const finishPlacement = (): void => {
      stateRef.current = 'IDLE';
      pendingRef.current = [];
      setPreview({ drawing: null });
      const store = useChartStore.getState();
      // Back to the cursor unless the trader asked to stay armed, so the next
      // press pans the chart rather than starting another object.
      if (!store.toolSticky) store.setTool('CURSOR');
    };

    const cancelPlacement = (): void => {
      stateRef.current = 'IDLE';
      pendingRef.current = [];
      setPreview({ drawing: null });
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const store = useChartStore.getState();
      const view = projection();
      if (!view) return;
      const point = pointAt(event);

      // --- a tool is armed: the drawings take it ---------------------------
      if (store.tool !== 'CURSOR') {
        const anchor = anchorAt(point);
        if (!anchor) return;
        const kind = store.tool as DrawingKind;
        const anchors = [...pendingRef.current, anchor];
        if (anchors.length >= ANCHOR_COUNT[kind]) {
          store.addDrawing({
            id: newId(),
            kind,
            symbol: live.current.symbol,
            anchors,
            style: store.defaultStyle,
            text: kind === 'TEXT' ? 'Text' : '',
            locked: false,
            hidden: false,
            createdAt: Date.now(),
          });
          finishPlacement();
        } else {
          pendingRef.current = anchors;
          stateRef.current = 'PLACING';
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // --- the cursor: only take it if something is actually under it ------
      const found = pick(point);
      if (!found) {
        // Nothing hit. Clear the selection and LET THE CHART HAVE IT: no
        // preventDefault, no stopPropagation, so the pan begins normally.
        if (store.selectedDrawingId) store.select(null);
        return;
      }

      store.select(found.drawing.id);
      if (found.drawing.locked) {
        // A locked object is selectable but not movable, and it must not eat
        // the gesture either - the chart still pans under it.
        return;
      }

      const anchor = anchorAt(point);
      if (!anchor) return;
      gestureRef.current = {
        mode: found.hit.kind === 'HANDLE' ? 'RESHAPE' : 'MOVE',
        drawingId: found.drawing.id,
        anchorIndex: found.hit.kind === 'HANDLE' ? found.hit.index : 0,
        from: anchor,
        original: found.drawing,
      };
      stateRef.current = 'DRAGGING';
      event.preventDefault();
      event.stopPropagation();
    };

    const onPointerMove = (event: PointerEvent): void => {
      const store = useChartStore.getState();
      const point = pointAt(event);

      // Mid-placement: preview to the cursor.
      if (stateRef.current === 'PLACING' && store.tool !== 'CURSOR') {
        const view = projection();
        const kind = store.tool as DrawingKind;
        if (view) {
          const time = view.xToTime(point.x);
          const price = view.yToPrice(point.y);
          const anchors = [...pendingRef.current];
          if (time !== null && price !== null) anchors.push({ time, price });
          setPreview({
            drawing: {
              id: 'preview',
              kind,
              symbol: live.current.symbol,
              anchors,
              style: store.defaultStyle,
              text: '',
              locked: false,
              hidden: false,
              createdAt: 0,
            },
          });
        }
        return;
      }

      // Mid-drag: move or reshape. The store update is cheap; the repaint is
      // the animation frame's job.
      const gesture = gestureRef.current;
      if (gesture) {
        const anchor = anchorAt(point);
        if (!anchor) return;
        const next =
          gesture.mode === 'MOVE'
            ? translate(
                gesture.original,
                anchor.time - gesture.from.time,
                anchor.price - gesture.from.price,
              )
            : moveAnchor(gesture.original, gesture.anchorIndex, anchor);
        store.updateDrawing(gesture.drawingId, next);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // Idle: hover highlight only. Never swallowed, so the chart's own
      // crosshair keeps tracking.
      if (store.tool !== 'CURSOR') return;
      const found = pick(point);
      const hoverId = found?.drawing.id ?? null;
      if (hoverId !== (previewRef.current?.hoverId ?? null)) setPreview({ hoverId });
      container.style.cursor = hoverId ? 'pointer' : '';
    };

    const endGesture = (): void => {
      if (!gestureRef.current) return;
      gestureRef.current = null;
      stateRef.current = 'IDLE';
      // The drawing moved, so what is under the cursor may have changed.
      useChartStore.getState().commitHistory();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      // Never steal a key from an input: the settings dialog is full of them.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const store = useChartStore.getState();

      if (event.key === 'Escape') {
        if (stateRef.current === 'PLACING') cancelPlacement();
        else if (store.tool !== 'CURSOR') store.setTool('CURSOR');
        else if (store.selectedDrawingId) store.select(null);
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && store.selectedDrawingId) {
        const drawing = store.drawings.find((d) => d.id === store.selectedDrawingId);
        if (drawing && !drawing.locked) store.removeDrawing(store.selectedDrawingId);
        event.preventDefault();
        return;
      }
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === 'd' && store.selectedDrawingId) {
        store.duplicateDrawing(store.selectedDrawingId);
        event.preventDefault();
        return;
      }
      if (meta && event.key.toLowerCase() === 'z') {
        if (event.shiftKey) store.redo();
        else store.undo();
        event.preventDefault();
      }
    };

    // Capture phase: seen before the renderer, released when not claimed.
    container.addEventListener('pointerdown', onPointerDown, true);
    container.addEventListener('pointermove', onPointerMove, true);
    // The end of a drag can happen anywhere, including outside the chart.
    window.addEventListener('pointerup', endGesture);
    window.addEventListener('pointercancel', endGesture);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      container.removeEventListener('pointerdown', onPointerDown, true);
      container.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', endGesture);
      window.removeEventListener('pointercancel', endGesture);
      window.removeEventListener('keydown', onKeyDown);
      container.style.cursor = '';
    };
  }, [adapterRef, containerRef, previewRef, ready]);

  // The armed cursor is a class on the container rather than a style write, so
  // it cannot fight the hover cursor above.
  const tool = useChartStore((s) => s.tool);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.classList.toggle('chart-arming', tool !== 'CURSOR');
    return () => container.classList.remove('chart-arming');
  }, [containerRef, tool]);

  /*
   * Abandon a half-placed drawing when the tool changes.
   *
   * Switching tools mid-placement used to leave the preview painted for ever:
   * it is not a drawing, so "remove all drawings" could not remove it and
   * nothing else ever cleared it. Changing the tool is an abandonment.
   */
  useEffect(() => {
    stateRef.current = 'IDLE';
    pendingRef.current = [];
    if (previewRef.current) previewRef.current = { ...previewRef.current, drawing: null };
  }, [previewRef, tool]);
}
