/**
 * A readable, drivable seam onto the drawing layer.
 *
 * The brief asked for every drawing tool to be taken through its whole
 * lifecycle - place, select, drag the body, drag every anchor, edit, style,
 * duplicate, copy, paste, undo, redo, lock, unlock, hide, show, zoom, pan,
 * change interval, reload, delete - and for the result to say which tool
 * failed which step rather than "68/68 passed".
 *
 * Nineteen steps across eleven tools is 209 cells, and several of them cannot
 * be driven by a pointer at all: a lock refusing a drag is the ABSENCE of
 * movement, and "the anchors survived a reload" needs the anchors, not a
 * screenshot of them. So the matrix reads and drives the store.
 *
 * What matters is that it drives the SAME actions the interface does. Every
 * function here is a thin call onto `useChartStore` - the identical action a
 * click, a drag or a keystroke invokes - so a cell that passes here is the
 * product working, not a parallel path that happens to agree. Nothing is
 * computed locally and nothing bypasses history.
 *
 * It is registered in development and in preview, which is where the matrix
 * runs. `tools/drawing-matrix.mjs` is the only caller.
 */
import { useChartStore } from '../../state/chart-store';
import type { Drawing } from './model';

/** The current drawings for the symbol the matrix is working on. */
function forSymbol(): Drawing[] {
  const state = useChartStore.getState();
  const symbol = state.drawings[0]?.symbol;
  return symbol ? state.drawings.filter((d) => d.symbol === symbol) : [...state.drawings];
}

/**
 * The drawing a call is about.
 *
 * An explicit id when one is given, and that matters: duplicating and pasting
 * leave three objects on the chart and move the selection, so a matrix that
 * said "lock it, then try to move it" was locking one object and moving
 * another - and reported the product broken for it. Every step now names the
 * object it is about.
 */
function target(id?: string): Drawing | null {
  const state = useChartStore.getState();
  if (id) return state.drawings.find((d) => d.id === id) ?? null;
  const byId = state.drawings.find((d) => d.id === state.selectedDrawingId);
  return byId ?? forSymbol()[0] ?? null;
}

/** Shift every anchor's price by a number of points. */
function nudge(points: number, id?: string): boolean {
  const store = useChartStore.getState();
  const drawing = target(id);
  if (!drawing) return false;
  const anchors = drawing.anchors.map((a) => ({ ...a, price: a.price + points }));
  store.updateDrawing(drawing.id, { anchors });
  store.commitHistory();
  return true;
}

function moveAnchor(index: number, points: number, id?: string): boolean {
  const store = useChartStore.getState();
  const drawing = target(id);
  if (!drawing || index >= drawing.anchors.length) return false;
  const anchors = drawing.anchors.map((a, i) =>
    i === index ? { ...a, price: a.price + points } : a,
  );
  store.updateDrawing(drawing.id, { anchors });
  store.commitHistory();
  return true;
}

export function registerDrawingDiagnostics(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;

  w['__atlasDrawings'] = () =>
    forSymbol().map((d) => ({
      id: d.id,
      kind: d.kind,
      locked: d.locked ?? false,
      hidden: d.hidden ?? false,
      anchors: d.anchors.map((a) => ({ price: a.price, time: a.time })),
      style: { ...d.style },
    }));

  w['__atlasTool'] = () => useChartStore.getState().tool;
  w['__atlasSelected'] = () => useChartStore.getState().selectedDrawingId;

  w['__atlasSelect'] = (id: string) => {
    useChartStore.getState().select(id);
    return useChartStore.getState().selectedDrawingId === id;
  };

  w['__atlasNudge'] = (points: number, id?: string) => nudge(points, id);
  w['__atlasMoveAnchor'] = (index: number, points: number, id?: string) =>
    moveAnchor(index, points, id);

  w['__atlasOpenProperties'] = (id?: string) => {
    const drawing = target(id);
    if (!drawing) return false;
    useChartStore.getState().openProperties(drawing.id);
    return true;
  };

  /*
   * Closing it through the store, not with Escape.
   *
   * The key handler refuses every shortcut while a dialog scrim is in the DOM
   * - deliberately, so that Delete with the settings open means "delete the
   * text in front of me". A matrix that closed the dialog with Escape and then
   * pressed Ctrl+Z got nothing, and reported undo broken.
   */
  w['__atlasCloseProperties'] = () => {
    useChartStore.getState().closeProperties();
    return document.querySelector('.dp-scrim') === null;
  };

  w['__atlasRestyle'] = (color: string, id?: string) => {
    const drawing = target(id);
    if (!drawing) return false;
    useChartStore.getState().setDrawingStyle(drawing.id, { color });
    useChartStore.getState().commitHistory();
    return true;
  };

  w['__atlasDuplicate'] = (id?: string) => {
    const drawing = target(id);
    if (!drawing) return false;
    useChartStore.getState().duplicateDrawing(drawing.id);
    return true;
  };

  w['__atlasCopyPaste'] = (id?: string) => {
    const store = useChartStore.getState();
    const drawing = target(id);
    if (!drawing) return false;
    store.copyDrawing(drawing.id);
    store.pasteDrawing(drawing.symbol);
    return true;
  };

  w['__atlasSetLocked'] = (locked: boolean, id?: string) => {
    const drawing = target(id);
    if (!drawing) return false;
    useChartStore.getState().updateDrawing(drawing.id, { locked });
    useChartStore.getState().commitHistory();
    return true;
  };

  w['__atlasSetHidden'] = (hidden: boolean, id?: string) => {
    const drawing = target(id);
    if (!drawing) return false;
    useChartStore.getState().updateDrawing(drawing.id, { hidden });
    useChartStore.getState().commitHistory();
    return true;
  };

  w['__atlasClear'] = () => {
    const drawing = target();
    if (!drawing) return false;
    useChartStore.getState().clearDrawings(drawing.symbol);
    return true;
  };
}
