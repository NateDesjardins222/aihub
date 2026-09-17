/**
 * Drawing objects: what they are, and where they are.
 *
 * A drawing is stored in MARKET coordinates - a time in milliseconds and a
 * price - never in pixels. That is what makes it survive a zoom, a pan, a
 * timeframe change and a reload, and it is why the geometry below converts
 * through the chart rather than caching screen positions.
 *
 * Everything in this file is pure. Hit-testing, dragging and the handle layout
 * are all decided here so they can be unit-tested without a canvas.
 */

export type DrawingKind =
  | 'TREND_LINE'
  | 'RAY'
  | 'EXTENDED_LINE'
  | 'HORIZONTAL_LINE'
  | 'VERTICAL_LINE'
  | 'RECTANGLE'
  | 'FIB_RETRACEMENT'
  | 'TEXT'
  | 'MEASURE';

export interface Anchor {
  /** Epoch milliseconds of the bar the anchor is pinned to. */
  readonly time: number;
  readonly price: number;
}

export interface DrawingStyle {
  readonly color: string;
  readonly width: number;
  readonly dash: 'SOLID' | 'DASHED' | 'DOTTED';
  readonly fill: string | null;
  readonly fontSize: number;
  readonly showPrice: boolean;
}

export const DEFAULT_STYLE: DrawingStyle = {
  color: '#4d8dff',
  width: 1,
  dash: 'SOLID',
  fill: null,
  fontSize: 11,
  showPrice: false,
};

export interface Drawing {
  readonly id: string;
  readonly kind: DrawingKind;
  readonly symbol: string;
  readonly anchors: readonly Anchor[];
  readonly style: DrawingStyle;
  readonly text: string;
  readonly locked: boolean;
  readonly hidden: boolean;
  readonly createdAt: number;
}

/** How many anchors a kind needs before it is finished. */
export const ANCHOR_COUNT: Record<DrawingKind, number> = {
  TREND_LINE: 2,
  RAY: 2,
  EXTENDED_LINE: 2,
  HORIZONTAL_LINE: 1,
  VERTICAL_LINE: 1,
  RECTANGLE: 2,
  FIB_RETRACEMENT: 2,
  TEXT: 1,
  MEASURE: 2,
};

export const KIND_LABEL: Record<DrawingKind, string> = {
  TREND_LINE: 'Trend line',
  RAY: 'Ray',
  EXTENDED_LINE: 'Extended line',
  HORIZONTAL_LINE: 'Horizontal line',
  VERTICAL_LINE: 'Vertical line',
  RECTANGLE: 'Rectangle',
  FIB_RETRACEMENT: 'Fib retracement',
  TEXT: 'Text',
  MEASURE: 'Measure',
};

/** The Fibonacci levels drawn by FIB_RETRACEMENT, as fractions of the range. */
export const FIB_LEVELS: readonly number[] = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Converts between market coordinates and the canvas. Supplied by the adapter. */
export interface Projection {
  readonly timeToX: (time: number) => number | null;
  readonly xToTime: (x: number) => number | null;
  readonly priceToY: (price: number) => number | null;
  readonly yToPrice: (y: number) => number | null;
  readonly width: number;
  readonly height: number;
}

export function project(projection: Projection, anchor: Anchor): Point | null {
  const x = projection.timeToX(anchor.time);
  const y = projection.priceToY(anchor.price);
  if (x === null || y === null) return null;
  return { x, y };
}

/** Shortest distance from a point to a finite segment. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance to a ray: like a segment, but unbounded beyond `b`. */
export function distanceToRay(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distanceToLine(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / Math.hypot(dx, dy);
}

export const HANDLE_RADIUS = 4;
export const HIT_TOLERANCE = 6;

/** Where the grab handles sit for a drawing, in screen space. */
export function handlePoints(drawing: Drawing, projection: Projection): Point[] {
  const points: Point[] = [];
  for (const anchor of drawing.anchors) {
    const point = project(projection, anchor);
    if (!point) continue;
    if (drawing.kind === 'HORIZONTAL_LINE') points.push({ x: projection.width / 2, y: point.y });
    else if (drawing.kind === 'VERTICAL_LINE') points.push({ x: point.x, y: projection.height / 2 });
    else points.push(point);
  }
  if (drawing.kind === 'RECTANGLE' && points.length === 2) {
    const [a, b] = points as [Point, Point];
    return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
  }
  return points;
}

export type HitTarget =
  | { readonly kind: 'BODY' }
  | { readonly kind: 'HANDLE'; readonly index: number };

/**
 * What, if anything, is under the cursor.
 *
 * Handles win over bodies, so grabbing an endpoint of a line moves that
 * endpoint rather than sliding the whole line - which is the behaviour a
 * trader expects and the one that is impossible to undo by accident.
 */
export function hitTest(
  drawing: Drawing,
  projection: Projection,
  cursor: Point,
  selected: boolean,
): HitTarget | null {
  if (drawing.hidden) return null;

  if (selected) {
    const handles = handlePoints(drawing, projection);
    for (let i = 0; i < handles.length; i += 1) {
      if (Math.hypot(cursor.x - handles[i]!.x, cursor.y - handles[i]!.y) <= HANDLE_RADIUS + 3) {
        // A rectangle exposes four corners but stores two anchors; the corner
        // index maps back to the anchor it actually moves.
        const index = drawing.kind === 'RECTANGLE' ? (i === 0 || i === 3 ? 0 : 1) : i;
        return { kind: 'HANDLE', index };
      }
    }
  }

  const points = drawing.anchors
    .map((anchor) => project(projection, anchor))
    .filter((point): point is Point => point !== null);
  if (points.length === 0) return null;

  switch (drawing.kind) {
    case 'HORIZONTAL_LINE':
      return Math.abs(cursor.y - points[0]!.y) <= HIT_TOLERANCE ? { kind: 'BODY' } : null;

    case 'VERTICAL_LINE':
      return Math.abs(cursor.x - points[0]!.x) <= HIT_TOLERANCE ? { kind: 'BODY' } : null;

    case 'TEXT': {
      const p = points[0]!;
      const halfWidth = Math.max(16, drawing.text.length * drawing.style.fontSize * 0.32);
      const halfHeight = drawing.style.fontSize;
      return Math.abs(cursor.x - p.x) <= halfWidth && Math.abs(cursor.y - p.y) <= halfHeight
        ? { kind: 'BODY' }
        : null;
    }

    case 'RECTANGLE':
    case 'FIB_RETRACEMENT': {
      if (points.length < 2) return null;
      const [a, b] = points as [Point, Point];
      const left = Math.min(a.x, b.x);
      const right = Math.max(a.x, b.x);
      const top = Math.min(a.y, b.y);
      const bottom = Math.max(a.y, b.y);
      const insideX = cursor.x >= left - HIT_TOLERANCE && cursor.x <= right + HIT_TOLERANCE;
      const insideY = cursor.y >= top - HIT_TOLERANCE && cursor.y <= bottom + HIT_TOLERANCE;
      if (!insideX || !insideY) return null;
      // A filled shape is grabbable anywhere inside; an unfilled one only on
      // its edges, so it does not swallow clicks meant for the chart.
      if (drawing.kind === 'FIB_RETRACEMENT' || drawing.style.fill) return { kind: 'BODY' };
      const onEdge =
        Math.abs(cursor.x - left) <= HIT_TOLERANCE ||
        Math.abs(cursor.x - right) <= HIT_TOLERANCE ||
        Math.abs(cursor.y - top) <= HIT_TOLERANCE ||
        Math.abs(cursor.y - bottom) <= HIT_TOLERANCE;
      return onEdge ? { kind: 'BODY' } : null;
    }

    case 'RAY': {
      if (points.length < 2) return null;
      return distanceToRay(cursor, points[0]!, points[1]!) <= HIT_TOLERANCE ? { kind: 'BODY' } : null;
    }

    case 'EXTENDED_LINE': {
      if (points.length < 2) return null;
      return distanceToLine(cursor, points[0]!, points[1]!) <= HIT_TOLERANCE ? { kind: 'BODY' } : null;
    }

    default: {
      if (points.length < 2) return null;
      return distanceToSegment(cursor, points[0]!, points[1]!) <= HIT_TOLERANCE
        ? { kind: 'BODY' }
        : null;
    }
  }
}

/**
 * Snap an anchor to the nearest interesting price on the bar under it.
 *
 * The magnet pulls to open, high, low and close only - never to an
 * interpolated value - so a line drawn with the magnet on sits on a price the
 * market actually printed.
 */
export function magnetAnchor(
  anchor: Anchor,
  bar: { open: number; high: number; low: number; close: number; time: number } | null,
  tolerance: number,
): Anchor {
  if (!bar) return anchor;
  const candidates = [bar.open, bar.high, bar.low, bar.close];
  let best = anchor.price;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - anchor.price);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= tolerance ? { time: bar.time, price: best } : { ...anchor, time: bar.time };
}

/** Move every anchor of a drawing by a time and price delta. */
export function translate(drawing: Drawing, deltaTime: number, deltaPrice: number): Drawing {
  return {
    ...drawing,
    anchors: drawing.anchors.map((anchor) => ({
      time: anchor.time + deltaTime,
      price: anchor.price + deltaPrice,
    })),
  };
}

/** Move one anchor of a drawing. */
export function moveAnchor(drawing: Drawing, index: number, anchor: Anchor): Drawing {
  if (index < 0 || index >= drawing.anchors.length) return drawing;
  const anchors = [...drawing.anchors];
  anchors[index] = anchor;
  return { ...drawing, anchors };
}

/** The levels a fib retracement draws, as {fraction, price} pairs. */
export function fibLevels(drawing: Drawing): Array<{ fraction: number; price: number }> {
  const [a, b] = drawing.anchors;
  if (!a || !b) return [];
  const span = b.price - a.price;
  return FIB_LEVELS.map((fraction) => ({ fraction, price: a.price + span * (1 - fraction) }));
}
