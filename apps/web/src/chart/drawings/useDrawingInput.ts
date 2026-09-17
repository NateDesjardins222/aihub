/**
 * Pointer ownership, and what a gesture costs.
 *
 * Two rules decide everything in this file.
 *
 * **The chart owns every gesture unless the drawings can prove a claim to it.**
 * Listeners are attached to the chart container in the CAPTURE phase, so this
 * machine sees a pointerdown before the renderer does and can decide. It calls
 * stopPropagation ONLY when the drawings are taking the gesture - arming a
 * tool, hitting an existing drawing, or continuing a drag. Every other press
 * falls straight through, so panning and zooming behave exactly as they do
 * with no drawings on screen.
 *
 * **A pointer move records a position; the FRAME does the work.** Pointer
 * events arrive faster than the display refreshes, and the old machine did a
 * full hit-test, a store write and a React render on each one: eighty moves of
 * a drag produced ninety-two React commits that re-rendered the order ticket
 * and the chart header (docs/chart-performance-audit.md). Now a move writes a
 * coordinate into the live interaction record, one animation frame turns the
 * latest coordinate into hover or geometry, and the store is written once, on
 * release - which is also why a drag never touches the network.
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
import { BoundsCache } from './bounds';
import {
  beginGesture,
  endGesture,
  invalidate,
  liveState,
  resetInteraction,
  setHover,
  setPending,
  setPointer,
  setPreview,
  updateDraft,
  type Gesture,
} from './interaction';

export type InputState = 'IDLE' | 'PLACING' | 'DRAGGING';

export interface DrawingInputOptions {
  readonly adapterRef: React.RefObject<ChartAdapter | null>;
  readonly containerRef: React.RefObject<HTMLElement | null>;
  readonly symbol: string;
  readonly tickSize: number;
  readonly ready: boolean;
  /** Shared with the canvas, so both agree what is under the pointer. */
  readonly boundsRef: React.RefObject<BoundsCache>;
  /** Right-click on a drawing. */
  readonly onContextMenu?: (event: ContextMenuRequest) => void;
  /** Double-click on a drawing: the trader wants its settings. */
  readonly onOpenProperties?: (drawingId: string) => void;
}

export interface ContextMenuRequest {
  readonly drawingId: string | null;
  /** Viewport coordinates, for placing the menu. */
  readonly x: number;
  readonly y: number;
}

function newId(): string {
  return `draw-${crypto.randomUUID()}`;
}

export function useDrawingInput(options: DrawingInputOptions): void {
  const { adapterRef, containerRef, symbol, tickSize, ready, boundsRef } = options;

  // Everything the listeners need, in a ref: they are attached once and must
  // never be rebound on a store change, or a gesture in flight would lose its
  // handlers mid-drag.
  const env = useRef({
    symbol,
    tickSize,
    onContextMenu: options.onContextMenu,
    onOpenProperties: options.onOpenProperties,
  });
  env.current.symbol = symbol;
  env.current.tickSize = tickSize;
  env.current.onContextMenu = options.onContextMenu;
  env.current.onOpenProperties = options.onOpenProperties;

  const stateRef = useRef<InputState>('IDLE');

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ready) return;

    const live = liveState();
    const projection = (): Projection | null => adapterRef.current?.projection() ?? null;

    let frame = 0;
    let cursor = '';

    /*
     * The container's position, cached.
     *
     * getBoundingClientRect forces layout, and calling it on every pointer
     * event meant the browser re-laid out the page several times per painted
     * frame while the mouse moved - visible in the profile as tens of
     * milliseconds of layout during a crosshair sweep. The rectangle only
     * changes when the window or the panels do, so it is measured then.
     */
    let rect = container.getBoundingClientRect();
    const remeasure = (): void => {
      rect = container.getBoundingClientRect();
    };
    const observer = new ResizeObserver(remeasure);
    observer.observe(container);
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, true);

    const pointAt = (event: PointerEvent | MouseEvent): Point => ({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });

    const anchorAt = (point: Point): Anchor | null => {
      const adapter = adapterRef.current;
      const view = projection();
      if (!adapter || !view) return null;
      const time = view.xToTime(point.x);
      const price = view.yToPrice(point.y);
      if (time === null || price === null) return null;
      const raw: Anchor = { time, price };
      const store = useChartStore.getState();
      if (store.magnet === 'OFF') return raw;
      // The magnet snaps to a price the bar actually printed, never between.
      // A weak magnet only reaches as far as a trader would expect it to; a
      // strong one takes the nearest of the four whatever the distance.
      const reach = store.magnet === 'STRONG' ? Number.POSITIVE_INFINITY : env.current.tickSize * 6;
      return magnetAnchor(raw, adapter.barNear(time), reach);
    };

    const mine = (): Drawing[] =>
      useChartStore.getState().drawings.filter((d) => d.symbol === env.current.symbol);

    /**
     * The topmost drawing under the cursor, most recent first.
     *
     * The cached screen box rejects everything the pointer is nowhere near
     * before any geometry runs, which is what keeps this affordable with a
     * chart full of objects.
     */
    const pick = (point: Point) => {
      const view = projection();
      if (!view) return null;
      const bounds = boundsRef.current;
      bounds.sync(view);
      const selectedId = useChartStore.getState().selectedDrawingId;
      const candidates = mine();
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const drawing = candidates[i]!;
        if (drawing.hidden) continue;
        if (!bounds.mayHit(drawing, view, point.x, point.y)) continue;
        const hit = hitTest(drawing, view, point, drawing.id === selectedId);
        if (hit) return { drawing, hit };
      }
      return null;
    };

    const setCursor = (next: string): void => {
      if (cursor === next) return;
      cursor = next;
      container.style.cursor = next;
    };

    const finishPlacement = (): void => {
      stateRef.current = 'IDLE';
      setPending([]);
      setPreview(null);
      const store = useChartStore.getState();
      // Back to the cursor unless the trader asked to stay armed, so the next
      // press pans the chart rather than starting another object.
      if (!store.toolSticky) store.setTool('CURSOR');
    };

    const cancelPlacement = (): void => {
      stateRef.current = 'IDLE';
      resetInteraction();
    };

    // --- the frame: all the work a pointer move implies ---------------------
    const onFrame = (): void => {
      frame = requestAnimationFrame(onFrame);
      if (!live.pointerMoved || !live.pointer) return;
      live.pointerMoved = false;

      const point = live.pointer;
      const store = useChartStore.getState();

      // Mid-placement: preview to the cursor.
      if (stateRef.current === 'PLACING' && store.tool !== 'CURSOR') {
        const view = projection();
        if (!view) return;
        const kind = store.tool as DrawingKind;
        const time = view.xToTime(point.x);
        const price = view.yToPrice(point.y);
        const anchors = [...live.pending];
        if (time !== null && price !== null) anchors.push({ time, price });
        const defaults = store.newDrawingDefaults(kind);
        setPreview({
          id: 'preview',
          kind,
          symbol: env.current.symbol,
          anchors,
          style: defaults.style,
          options: defaults.options,
          text: '',
          locked: false,
          hidden: false,
          timeframes: [],
          createdAt: 0,
        });
        return;
      }

      // Mid-drag: the working copy moves, the store does not.
      const gesture = live.gesture;
      if (gesture) {
        const anchor = anchorAt(point);
        if (!anchor) return;
        const next =
          gesture.kind === 'MOVE'
            ? translate(
                gesture.original,
                anchor.time - gesture.from.time,
                anchor.price - gesture.from.price,
              )
            : moveAnchor(gesture.original, gesture.anchorIndex, anchor);
        updateDraft(next);
        return;
      }

      // Idle: hover only, and only with the cursor tool armed.
      if (store.tool !== 'CURSOR') {
        setCursor('crosshair');
        return;
      }
      const found = pick(point);
      setHover(found?.drawing.id ?? null);
      setCursor(found ? (found.hit.kind === 'HANDLE' ? 'grab' : 'pointer') : '');
    };

    // --- pointer events: record, decide ownership, never compute ------------
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const store = useChartStore.getState();
      const view = projection();
      if (!view) return;
      const point = pointAt(event);
      setPointer(point);

      // A tool is armed: the drawings take it.
      if (store.tool !== 'CURSOR') {
        const anchor = anchorAt(point);
        if (!anchor) return;
        const kind = store.tool as DrawingKind;
        const anchors = [...live.pending, anchor];
        if (anchors.length >= ANCHOR_COUNT[kind]) {
          const defaults = store.newDrawingDefaults(kind);
          store.addDrawing({
            id: newId(),
            kind,
            symbol: env.current.symbol,
            anchors,
            style: defaults.style,
            options: defaults.options,
            text: kind === 'TEXT' ? 'Text' : '',
            locked: false,
            hidden: false,
            timeframes: [],
            createdAt: Date.now(),
          });
          finishPlacement();
        } else {
          setPending(anchors);
          stateRef.current = 'PLACING';
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // The cursor: only take the gesture if something is actually under it.
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
      const gesture: Gesture = {
        kind: found.hit.kind === 'HANDLE' ? 'RESHAPE' : 'MOVE',
        drawingId: found.drawing.id,
        anchorIndex: found.hit.kind === 'HANDLE' ? found.hit.index : 0,
        from: anchor,
        original: found.drawing,
      };
      beginGesture(gesture, found.drawing);
      stateRef.current = 'DRAGGING';
      setCursor('grabbing');
      event.preventDefault();
      event.stopPropagation();
    };

    const onPointerMove = (event: PointerEvent): void => {
      setPointer(pointAt(event));
      // A gesture in flight belongs to the drawings; the chart must not also
      // pan under it.
      if (live.gesture) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    /**
     * Right-click.
     *
     * The menu is the one place a locked or hidden object can be reached, so
     * the press selects whatever is under it even when a drag would not. With
     * nothing under the cursor the chart keeps its own menu.
     */
    const onContextMenu = (event: MouseEvent): void => {
      const handler = env.current.onContextMenu;
      if (!handler) return;
      const found = pick(pointAt(event));
      if (!found) return;
      useChartStore.getState().select(found.drawing.id);
      event.preventDefault();
      event.stopPropagation();
      handler({ drawingId: found.drawing.id, x: event.clientX, y: event.clientY });
    };

    const onDoubleClick = (event: MouseEvent): void => {
      const handler = env.current.onOpenProperties;
      if (!handler) return;
      if (useChartStore.getState().tool !== 'CURSOR') return;
      const found = pick(pointAt(event));
      if (!found) return;
      useChartStore.getState().select(found.drawing.id);
      event.preventDefault();
      event.stopPropagation();
      handler(found.drawing.id);
    };

    /**
     * The end of a drag: ONE store write, ONE undo step, one save.
     *
     * Everything between pointerdown and here happened in the live record, so
     * this is the first moment anything outside the canvas hears about it.
     */
    const onPointerUp = (): void => {
      if (!live.gesture) return;
      const draft = live.draft;
      const gesture = endGesture();
      stateRef.current = 'IDLE';
      setCursor('');
      if (!gesture || !draft) return;

      const store = useChartStore.getState();
      const moved = draft.anchors.some(
        (anchor, index) =>
          anchor.time !== gesture.original.anchors[index]?.time ||
          anchor.price !== gesture.original.anchors[index]?.price,
      );
      if (!moved) return;

      store.updateDrawing(gesture.drawingId, { anchors: draft.anchors });
      store.commitHistory();
      boundsRef.current.forget(gesture.drawingId);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      // Never steal a key from an input: the settings dialog is full of them.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // Nor from an open dialog. Delete with the object settings open means
      // "delete the text in front of me", not "delete the object I am editing".
      if (document.querySelector('.dp-scrim, .st-scrim')) return;
      const store = useChartStore.getState();

      if (event.key === 'Escape') {
        // A menu or a popover owns Escape while it is open: one press closes
        // it, and the selection it was opened against stays.
        if (document.querySelector('.dm-menu, .popover')) return;
        if (stateRef.current === 'PLACING') cancelPlacement();
        else if (live.gesture) {
          // Abandon a drag in flight: the object snaps back to where it was.
          endGesture();
          stateRef.current = 'IDLE';
        } else if (store.tool !== 'CURSOR') store.setTool('CURSOR');
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
      if (meta && event.key.toLowerCase() === 'c' && store.selectedDrawingId) {
        store.copyDrawing(store.selectedDrawingId);
        event.preventDefault();
        return;
      }
      if (meta && event.key.toLowerCase() === 'v') {
        store.pasteDrawing(env.current.symbol);
        event.preventDefault();
        return;
      }
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
    container.addEventListener('contextmenu', onContextMenu, true);
    container.addEventListener('dblclick', onDoubleClick, true);
    // The end of a drag can happen anywhere, including outside the chart.
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('keydown', onKeyDown);
    frame = requestAnimationFrame(onFrame);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, true);
      container.removeEventListener('pointerdown', onPointerDown, true);
      container.removeEventListener('pointermove', onPointerMove, true);
      container.removeEventListener('contextmenu', onContextMenu, true);
      container.removeEventListener('dblclick', onDoubleClick, true);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      container.style.cursor = '';
    };
  }, [adapterRef, boundsRef, containerRef, ready]);

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
    resetInteraction();
    invalidate();
  }, [tool]);
}
