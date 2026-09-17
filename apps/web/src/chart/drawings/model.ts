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

/**
 * How a drawing looks.
 *
 * The border and the fill are SEPARATE, each with its own colour and its own
 * alpha. That is not a refinement: a zone drawn on a price chart is only
 * useful if the candles inside it are still readable, and the way to get a
 * crisp edge over a barely-there interior is a solid border colour and a fill
 * at eight per cent - not one colour chosen dark enough to look transparent.
 *
 * Colours are stored as plain hex. Alpha is applied at paint time, so a
 * trader can change either without the other being re-derived.
 */
export interface DrawingStyle {
  /** Border and line colour, as #rrggbb. */
  readonly color: string;
  /** Border alpha, 0-1. */
  readonly opacity: number;
  readonly width: number;
  readonly dash: 'SOLID' | 'DASHED' | 'DOTTED';
  /** Whether the shape has an interior at all. */
  readonly filled: boolean;
  readonly fillColor: string;
  /** Fill alpha, 0-1. Deliberately low by default. */
  readonly fillOpacity: number;
  readonly fontSize: number;
  readonly showPrice: boolean;
}

export const DEFAULT_STYLE: DrawingStyle = {
  color: '#4d8dff',
  opacity: 1,
  width: 1,
  dash: 'SOLID',
  filled: false,
  fillColor: '#4d8dff',
  // Eight per cent: enough to read the zone, not enough to hide a candle.
  fillOpacity: 0.08,
  fontSize: 11,
  showPrice: false,
};

/**
 * A colour with an alpha applied.
 *
 * Accepts #rgb, #rrggbb and anything already carrying its own alpha - a stored
 * rgba() from before border and fill were separate is passed through rather
 * than mangled.
 */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  if (a >= 1) return color;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return color;
  const digits = hex[1]!;
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

/**
 * Bring a style written by an older build up to date.
 *
 * The previous shape carried a single `fill` string - an rgba() or null - and
 * no border alpha. The colour inside it is recovered where it can be, so a
 * rectangle a trader drew last week keeps looking like the rectangle they
 * drew, and the alpha is capped so a stored opaque fill cannot survive as
 * something that hides price action.
 */
export function normalizeStyle(raw: unknown): DrawingStyle {
  const style = (raw ?? {}) as Partial<DrawingStyle> & { fill?: unknown };
  const legacyFill = typeof style.fill === 'string' ? parseRgba(style.fill) : null;

  const clamp01 = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.min(1, value))
      : fallback;

  return {
    color: typeof style.color === 'string' ? style.color : DEFAULT_STYLE.color,
    opacity: clamp01(style.opacity, DEFAULT_STYLE.opacity),
    width:
      typeof style.width === 'number' && Number.isFinite(style.width)
        ? Math.max(1, Math.min(10, Math.round(style.width)))
        : DEFAULT_STYLE.width,
    dash:
      style.dash === 'DASHED' || style.dash === 'DOTTED' || style.dash === 'SOLID'
        ? style.dash
        : DEFAULT_STYLE.dash,
    filled:
      typeof style.filled === 'boolean' ? style.filled : legacyFill !== null,
    fillColor:
      typeof style.fillColor === 'string'
        ? style.fillColor
        : (legacyFill?.color ?? DEFAULT_STYLE.fillColor),
    fillOpacity: clamp01(style.fillOpacity, legacyFill?.alpha ?? DEFAULT_STYLE.fillOpacity),
    fontSize:
      typeof style.fontSize === 'number' && Number.isFinite(style.fontSize)
        ? Math.max(8, Math.min(32, Math.round(style.fontSize)))
        : DEFAULT_STYLE.fontSize,
    showPrice: style.showPrice === true,
  };
}

function parseRgba(value: string): { color: string; alpha: number } | null {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/i.exec(value);
  if (!match) return /^#[0-9a-f]{3,6}$/i.test(value.trim()) ? { color: value.trim(), alpha: 0.08 } : null;
  const hex = (n: string): string => Number(n).toString(16).padStart(2, '0');
  return {
    color: `#${hex(match[1]!)}${hex(match[2]!)}${hex(match[3]!)}`,
    alpha: match[4] === undefined ? 0.08 : Math.max(0, Math.min(1, Number(match[4]))),
  };
}

/**
 * Tool-specific settings.
 *
 * A bag rather than a union, because the alternative is a `Drawing` type that
 * grows a field for every tool ever added and a paint function that branches on
 * which ones are meaningful. Each tool declares the options it understands in
 * the registry, which is also what generates its property editor, so the two
 * cannot drift apart.
 */
export type ToolOptions = Record<string, unknown>;

/** One level of a Fibonacci tool. Shared by every fib family. */
export interface FibLevel {
  readonly value: number;
  readonly color: string;
  readonly visible: boolean;
  /**
   * The level's own opacity, and its own name.
   *
   * Both OPTIONAL, and both filled in by readLevels: a level saved before
   * either existed is a fully opaque level shown as its percentage, which is
   * what it looked like when it was saved.
   */
  readonly opacity?: number;
  readonly label?: string;
}

export interface Drawing {
  readonly id: string;
  readonly kind: DrawingKind;
  readonly symbol: string;
  readonly anchors: readonly Anchor[];
  readonly style: DrawingStyle;
  readonly options: ToolOptions;
  readonly text: string;
  readonly locked: boolean;
  readonly hidden: boolean;
  /**
   * Intervals this drawing is shown on. Empty means every interval.
   *
   * A level marked on the daily is often noise on the one-minute, and a
   * scalping trend line is meaningless on the daily.
   */
  readonly timeframes: readonly string[];
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
  /** Bar-index conversions; see ChartProjection for why they exist. */
  readonly xToIndex: (x: number) => number | null;
  readonly indexToTime: (index: number) => number | null;
  readonly timeToIndex: (time: number) => number | null;
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

/**
 * What dragging a handle is allowed to change.
 *
 * A rectangle's corner moves a time and a price; its top edge moves only a
 * price; its left edge moves only a time. Expressing that as a role - rather
 * than as "anchor 0" and a pile of special cases in the input machine - is
 * what makes the interaction match what a trader expects from any charting
 * package, and it generalises: every tool describes its handles, and one
 * reshape function applies them.
 */
export type HandleRole =
  /** Move both coordinates of one anchor. */
  | { readonly kind: 'POINT'; readonly index: number }
  /** A corner: the time of one anchor and the price of another. */
  | { readonly kind: 'CORNER'; readonly timeIndex: number; readonly priceIndex: number }
  /** An edge that moves time only. */
  | { readonly kind: 'TIME'; readonly index: number }
  /** An edge that moves price only. */
  | { readonly kind: 'PRICE'; readonly index: number };

export interface Handle {
  readonly x: number;
  readonly y: number;
  readonly role: HandleRole;
  /** The cursor to show over it. */
  readonly cursor: string;
}

/**
 * Where a drawing's grab handles are, and what each one does.
 *
 * A rectangle gets four corners AND four edge midpoints, because resizing one
 * side of a zone without touching the other three is the commonest edit there
 * is. Everything else gets a handle per anchor.
 */
export function handlesFor(drawing: Drawing, projection: Projection): Handle[] {
  const points = drawing.anchors.map((anchor) => project(projection, anchor));

  if (drawing.kind === 'RECTANGLE' && points[0] && points[1]) {
    const [a, b] = points as [Point, Point];
    // Which anchor holds the left edge, and which the top, depends on how the
    // trader dragged it out; the handles must follow the shape, not the order.
    const leftIndex = a.x <= b.x ? 0 : 1;
    const rightIndex = leftIndex === 0 ? 1 : 0;
    const topIndex = a.y <= b.y ? 0 : 1;
    const bottomIndex = topIndex === 0 ? 1 : 0;
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const bottom = Math.max(a.y, b.y);
    const midX = (left + right) / 2;
    const midY = (top + bottom) / 2;

    return [
      { x: left, y: top, cursor: 'nwse-resize', role: { kind: 'CORNER', timeIndex: leftIndex, priceIndex: topIndex } },
      { x: right, y: top, cursor: 'nesw-resize', role: { kind: 'CORNER', timeIndex: rightIndex, priceIndex: topIndex } },
      { x: right, y: bottom, cursor: 'nwse-resize', role: { kind: 'CORNER', timeIndex: rightIndex, priceIndex: bottomIndex } },
      { x: left, y: bottom, cursor: 'nesw-resize', role: { kind: 'CORNER', timeIndex: leftIndex, priceIndex: bottomIndex } },
      { x: midX, y: top, cursor: 'ns-resize', role: { kind: 'PRICE', index: topIndex } },
      { x: midX, y: bottom, cursor: 'ns-resize', role: { kind: 'PRICE', index: bottomIndex } },
      { x: left, y: midY, cursor: 'ew-resize', role: { kind: 'TIME', index: leftIndex } },
      { x: right, y: midY, cursor: 'ew-resize', role: { kind: 'TIME', index: rightIndex } },
    ];
  }

  const handles: Handle[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point) continue;
    if (drawing.kind === 'HORIZONTAL_LINE') {
      handles.push({
        x: projection.width / 2,
        y: point.y,
        cursor: 'ns-resize',
        role: { kind: 'PRICE', index },
      });
    } else if (drawing.kind === 'VERTICAL_LINE') {
      handles.push({
        x: point.x,
        y: projection.height / 2,
        cursor: 'ew-resize',
        role: { kind: 'TIME', index },
      });
    } else {
      handles.push({ x: point.x, y: point.y, cursor: 'grab', role: { kind: 'POINT', index } });
    }
  }
  return handles;
}

/** Where the grab handles sit, as plain points. Used by the painter. */
export function handlePoints(drawing: Drawing, projection: Projection): Point[] {
  return handlesFor(drawing, projection).map((handle) => ({ x: handle.x, y: handle.y }));
}

/**
 * Apply a dragged handle.
 *
 * The role decides what may change: a corner moves one time and one price, an
 * edge moves one of them, a point moves both. Nothing else about the drawing
 * is touched.
 */
export function applyHandle(drawing: Drawing, role: HandleRole, anchor: Anchor): Drawing {
  const anchors = drawing.anchors.map((existing) => ({ ...existing }));
  const at = (index: number): { time: number; price: number } | undefined => anchors[index];

  switch (role.kind) {
    case 'POINT': {
      const target = at(role.index);
      if (!target) return drawing;
      target.time = anchor.time;
      target.price = anchor.price;
      break;
    }
    case 'CORNER': {
      const timeTarget = at(role.timeIndex);
      const priceTarget = at(role.priceIndex);
      if (!timeTarget || !priceTarget) return drawing;
      timeTarget.time = anchor.time;
      priceTarget.price = anchor.price;
      break;
    }
    case 'TIME': {
      const target = at(role.index);
      if (!target) return drawing;
      target.time = anchor.time;
      break;
    }
    case 'PRICE': {
      const target = at(role.index);
      if (!target) return drawing;
      target.price = anchor.price;
      break;
    }
  }

  return { ...drawing, anchors };
}

export type HitTarget =
  | { readonly kind: 'BODY' }
  | { readonly kind: 'HANDLE'; readonly handle: Handle };

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
    // Handles are only grabbable on a SELECTED object, which is what keeps an
    // unselected chart clean and stops a stray click resizing something the
    // trader had not chosen.
    for (const handle of handlesFor(drawing, projection)) {
      if (Math.hypot(cursor.x - handle.x, cursor.y - handle.y) <= HANDLE_RADIUS + 4) {
        return { kind: 'HANDLE', handle };
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
      if (drawing.kind === 'FIB_RETRACEMENT' || drawing.style.filled) return { kind: 'BODY' };
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
  /*
   * Within reach: take the bar's price AND its time, which is what makes an
   * anchor sit exactly on a candle.
   *
   * Out of reach: leave the anchor completely alone. An earlier version still
   * snapped the TIME in this case, which meant a weak magnet quietly
   * quantised every placement to a bar boundary and - because a body drag
   * translates by the difference between two anchors - made moving an object
   * jump a whole bar at a time. A magnet that moves something the trader did
   * not point at is not help.
   */
  return bestDistance <= tolerance ? { time: bar.time, price: best } : anchor;
}

/**
 * Move a drawing by a number of BARS and a price delta.
 *
 * Moving by milliseconds looks right until the object crosses a session gap:
 * a chart gives a weekend no more width than a minute, so a drag measured in
 * time either overshoots or stalls the moment it passes one. Measured in bars,
 * the object follows the pointer exactly and keeps its width, which is what a
 * trader sees in any charting package.
 *
 * Anchors beyond either end of the series are carried at the median bar
 * spacing, the same rule the projection uses, so a drawing in the empty space
 * to the right of the last bar moves with the hand too.
 */
export function translateByBars(
  drawing: Drawing,
  deltaIndex: number,
  deltaPrice: number,
  projection: Pick<Projection, 'timeToIndex' | 'indexToTime'>,
): Drawing {
  const steps = Math.round(deltaIndex);
  const anchors = drawing.anchors.map((anchor) => {
    const index = projection.timeToIndex(anchor.time);
    if (index === null) return { ...anchor, price: anchor.price + deltaPrice };
    const time = projection.indexToTime(index + steps);
    return { time: time ?? anchor.time, price: anchor.price + deltaPrice };
  });
  return { ...drawing, anchors };
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

/**
 * The levels a Fibonacci tool draws.
 *
 * Reads the drawing's own levels when it has them, so a trader who added 0.705
 * or removed 0.236 gets what they asked for, and falls back to the classic set
 * for a drawing made before levels were editable. `reverse` swaps which anchor
 * counts as zero, which is the difference between measuring a pullback and
 * measuring an extension.
 */
export function fibLevels(
  drawing: Drawing,
): Array<{
  fraction: number;
  price: number;
  color: string;
  visible: boolean;
  opacity: number;
  label: string;
}> {
  const [a, b] = drawing.anchors;
  if (!a || !b) return [];
  const levels = readLevels(drawing);
  const reverse = drawing.options['reverse'] === true;
  const from = reverse ? b : a;
  const to = reverse ? a : b;
  const span = to.price - from.price;
  return levels.map((level) => ({
    fraction: level.value,
    price: from.price + span * (1 - level.value),
    color: level.color,
    visible: level.visible,
    opacity: level.opacity ?? 1,
    label: level.label ?? '',
  }));
}

/** A drawing's levels, or the classic set when it has none of its own. */
export function readLevels(drawing: Drawing): readonly FibLevel[] {
  const raw = drawing.options['levels'];
  if (Array.isArray(raw) && raw.length > 0) {
    return raw
      .filter(
        (level): level is FibLevel =>
          typeof level === 'object' && level !== null && Number.isFinite((level as FibLevel).value),
      )
      .map((level) => ({
        value: level.value,
        color: typeof level.color === 'string' ? level.color : drawing.style.color,
        visible: level.visible !== false,
        opacity:
          typeof level.opacity === 'number' && Number.isFinite(level.opacity)
            ? Math.min(1, Math.max(0, level.opacity))
            : 1,
        label: typeof level.label === 'string' ? level.label : '',
      }));
  }
  return FIB_LEVELS.map((value) => ({
    value,
    color: drawing.style.color,
    visible: true,
    opacity: 1,
    label: '',
  }));
}

export interface Bounds {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * The screen box a drawing occupies, used to place the floating style bar.
 *
 * Kept here rather than in the toolbar because it is geometry, and geometry in
 * this file is testable without a canvas. A drawing whose anchors are entirely
 * off-screen has no bounds, and the toolbar then hides rather than floating
 * over nothing.
 */
export function drawingBounds(drawing: Drawing, projection: Projection): Bounds | null {
  const points = handlePoints(drawing, projection);
  if (points.length === 0) return null;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const point of points) {
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { left, right, top, bottom };
}
