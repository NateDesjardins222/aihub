/**
 * Live interaction state: what the pointer is doing, right now.
 *
 * This is deliberately NOT React state and NOT the drawing store. A gesture
 * produces a mutable record here, the canvas reads it on the next animation
 * frame, and the store is written once when the gesture ends.
 *
 * The measurement that forced this (docs/chart-performance-audit.md): dragging
 * one drawing for eighty pointer moves produced ninety-two React commits, each
 * re-rendering the chart header, the order ticket, the drawing rail, the
 * positions table and nine hundred icons. None of that work was about the
 * drawing being dragged.
 *
 * Two rules follow from it:
 *
 *   1. A pointer move records a position and nothing else. The frame does the
 *      work, once, however many events arrived.
 *   2. Nothing in a gesture reaches global state - so nothing reaches the
 *      network either - until the pointer is released.
 */
import type { Anchor, Drawing, HandleRole, Point } from './model';

export type GestureKind = 'MOVE' | 'RESHAPE' | 'PLACE';

export interface Gesture {
  readonly kind: GestureKind;
  readonly drawingId: string;
  /** What a reshape is allowed to change: a corner, an edge or a point. */
  readonly role: HandleRole | null;
  /** Where the pointer went down, in market coordinates. */
  readonly from: Anchor;
  /** And in pixels, which is what a bar-index translation is measured from. */
  readonly fromX: number;
  /** The drawing as it was when the gesture started. */
  readonly original: Drawing;
}

export interface LiveState {
  /** Latest pointer position in canvas coordinates, or null when outside. */
  pointer: Point | null;
  /** True when a pointer position arrived that the frame has not seen. */
  pointerMoved: boolean;
  gesture: Gesture | null;
  /**
   * The gesture's working copy.
   *
   * The canvas paints this in place of the stored drawing, so a drag is shown
   * at full pointer rate while the store still holds the last committed
   * geometry.
   */
  draft: Drawing | null;
  /** A drawing being placed, before it exists. */
  preview: Drawing | null;
  /** Anchors already placed in a multi-click placement. */
  pending: Anchor[];
  /**
   * Where the magnet just snapped, in canvas pixels, or null.
   *
   * Set while placing or reshaping an anchor with the magnet on, so the canvas
   * can mark the open/high/low/close it caught. Cleared the instant the anchor
   * is free again, so it never lingers.
   */
  snap: Point | null;
  hoverId: string | null;
  /** Bumped whenever something the canvas paints has changed. */
  version: number;
}

const live: LiveState = {
  pointer: null,
  pointerMoved: false,
  gesture: null,
  draft: null,
  preview: null,
  pending: [],
  snap: null,
  hoverId: null,
  version: 0,
};

export function liveState(): LiveState {
  return live;
}

/** Tell the canvas something changed. Cheap, and the only way to ask for paint. */
export function invalidate(): void {
  live.version += 1;
}

export function setPointer(point: Point | null): void {
  live.pointer = point;
  live.pointerMoved = true;
}

export function setHover(id: string | null): void {
  if (live.hoverId === id) return;
  live.hoverId = id;
  invalidate();
}

export function beginGesture(gesture: Gesture, draft: Drawing): void {
  live.gesture = gesture;
  live.draft = draft;
  invalidate();
}

export function updateDraft(draft: Drawing): void {
  live.draft = draft;
  invalidate();
}

export function endGesture(): Gesture | null {
  const gesture = live.gesture;
  live.gesture = null;
  live.draft = null;
  live.snap = null;
  invalidate();
  return gesture;
}

export function setPreview(drawing: Drawing | null): void {
  live.preview = drawing;
  invalidate();
}

export function setPending(anchors: Anchor[]): void {
  live.pending = anchors;
  invalidate();
}

export function setSnap(point: Point | null): void {
  if (live.snap === point) return;
  if (live.snap && point && live.snap.x === point.x && live.snap.y === point.y) return;
  live.snap = point;
  invalidate();
}

/** Abandon everything in flight. Used when the tool changes or Escape is hit. */
export function resetInteraction(): void {
  live.gesture = null;
  live.draft = null;
  live.preview = null;
  live.pending = [];
  live.snap = null;
  invalidate();
}

/**
 * The drawing to paint for an id: the gesture's working copy while one is in
 * flight, otherwise the committed one.
 */
export function paintedVersion(drawing: Drawing): Drawing {
  return live.draft && live.draft.id === drawing.id ? live.draft : drawing;
}
