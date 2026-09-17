/**
 * Painting a drawing.
 *
 * Pure functions of (drawing, projection, state): no React, no closures over
 * component state, nothing that can go stale between the frame that schedules
 * a repaint and the frame that performs it.
 */
import {
  FIB_LEVELS,
  HANDLE_RADIUS,
  fibLevels,
  handlePoints,
  project,
  type Drawing,
  type Point,
  type Projection,
} from './model';

export type PaintState = 'NORMAL' | 'HOVER' | 'SELECTED' | 'PENDING';

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
export function drawDrawing(
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
