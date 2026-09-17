/**
 * Screen-space bounds, cached per projection.
 *
 * Hit-testing used to project every anchor of every drawing on every pointer
 * move. With a few dozen objects that is the largest single cost of moving the
 * mouse (see docs/chart-performance-audit.md), and almost all of it is wasted:
 * the pointer is nowhere near most of them.
 *
 * So each drawing gets a cheap rectangle in screen space, computed once per
 * projection rather than once per pointer move, and a hit-test rejects
 * anything the pointer is not inside before doing any real geometry.
 *
 * The cache is keyed on a PROJECTION SIGNATURE - two reference conversions
 * plus the canvas size - so a pan, a zoom, a scale change or a resize
 * invalidates it, and nothing else has to remember to.
 */
import { HIT_TOLERANCE, project, type Drawing, type Projection } from './model';

export interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * What the view currently shows, as a string.
 *
 * Read INWARDS - the time and price at the corners of the plot - rather than
 * outwards from two fixed market coordinates. Converting a time that is not on
 * the chart makes the adapter extrapolate from the logical index, which is
 * real work to do sixty times a second for a comparison; converting a
 * coordinate the plot already owns is a lookup.
 */
export function projectionSignature(projection: Projection): string {
  const t0 = projection.xToTime(0) ?? 0;
  const t1 = projection.xToTime(projection.width) ?? 0;
  const p0 = projection.yToPrice(0) ?? 0;
  const p1 = projection.yToPrice(projection.height) ?? 0;
  return `${t0}:${t1}:${Math.round(p0 * 1000)}:${Math.round(p1 * 1000)}:${projection.width}:${
    projection.height
  }`;
}

export class BoundsCache {
  private signature = '';
  /**
   * The box, and the drawing object it was computed from.
   *
   * Keeping the reference is what makes the cache safe. The view signature
   * catches a pan or a zoom, and the end of a gesture forgets the object that
   * moved - but geometry also changes with no gesture and no view change: a
   * price typed into the settings dialog, an undo, a template that moves a
   * level. Those left a STALE box, and a stale box is an object that cannot be
   * clicked where it is and can be clicked where it used to be. The store
   * replaces the drawing object on every edit, so comparing the reference
   * catches all of them for the price of one comparison.
   */
  private readonly boxes = new Map<string, { box: Box | null; from: Drawing }>();

  /** Drop everything if the view moved. Called once a frame, not once a move. */
  sync(projection: Projection): void {
    const signature = projectionSignature(projection);
    if (signature === this.signature) return;
    this.signature = signature;
    this.boxes.clear();
  }

  /** Forget one drawing, because its geometry changed under the same view. */
  forget(id: string): void {
    this.boxes.delete(id);
  }

  clear(): void {
    this.boxes.clear();
  }

  boxFor(drawing: Drawing, projection: Projection): Box | null {
    const cached = this.boxes.get(drawing.id);
    if (cached !== undefined && cached.from === drawing) return cached.box;
    const box = computeBox(drawing, projection);
    this.boxes.set(drawing.id, { box, from: drawing });
    return box;
  }

  /** Is the pointer near enough to this drawing to be worth testing properly? */
  mayHit(drawing: Drawing, projection: Projection, x: number, y: number): boolean {
    const box = this.boxFor(drawing, projection);
    if (!box) return false;
    return (
      x >= box.left - HIT_TOLERANCE &&
      x <= box.right + HIT_TOLERANCE &&
      y >= box.top - HIT_TOLERANCE &&
      y <= box.bottom + HIT_TOLERANCE
    );
  }
}

/**
 * The box a drawing occupies on screen.
 *
 * Lines that extend beyond their anchors - a horizontal line, a ray, an
 * extended line - claim the whole plot in that direction, because that is
 * where they can actually be clicked.
 */
export function computeBox(drawing: Drawing, projection: Projection): Box | null {
  const points = drawing.anchors
    .map((anchor) => project(projection, anchor))
    .filter((point): point is NonNullable<typeof point> => point !== null);
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

  switch (drawing.kind) {
    case 'HORIZONTAL_LINE':
      return { left: 0, right: projection.width, top, bottom };
    case 'VERTICAL_LINE':
      return { left, right, top: 0, bottom: projection.height };
    case 'RAY':
    case 'EXTENDED_LINE':
      // An unbounded line is clickable anywhere along its path; the plot is
      // the honest bound.
      return { left: 0, right: projection.width, top: 0, bottom: projection.height };
    default:
      return { left, right, top, bottom };
  }
}
