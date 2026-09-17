/**
 * Painting a drawing.
 *
 * Pure functions of (drawing, projection, state): no React, no closures over
 * component state, nothing that can go stale between the frame that schedules
 * a repaint and the frame that performs it.
 */
import {
  HANDLE_RADIUS,
  withAlpha,
  fibLevels,
  handlePoints,
  project,
  type Drawing,
  type Point,
  type Projection,
} from './model';
import { option } from './registry';

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

  /*
   * The border carries its own alpha, and so does the fill.
   *
   * globalAlpha is reserved for the PAINT STATE - the ghost of an object being
   * placed - so that a trader's own opacity settings and the renderer's
   * feedback never multiply into something neither of them asked for.
   */
  ctx.save();
  const border = withAlpha(drawing.style.color, drawing.style.opacity);
  ctx.strokeStyle = border;
  ctx.fillStyle = border;
  ctx.lineWidth = drawing.style.width + (state === 'HOVER' ? 1 : 0);
  ctx.globalAlpha = state === 'PENDING' ? 0.7 : 1;
  ctx.setLineDash(state === 'PENDING' ? [4, 3] : dashPattern(drawing.style.dash));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

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
      const extendLeft = option(drawing, 'extendLeft', false);
      const extendRight = option(drawing, 'extendRight', false);
      const x = extendLeft ? 0 : Math.min(a.x, b.x);
      const right = extendRight ? projection.width : Math.max(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.max(0, right - x);
      const h = Math.abs(b.y - a.y);

      if (drawing.style.filled && drawing.style.fillOpacity > 0) {
        ctx.save();
        ctx.fillStyle = withAlpha(drawing.style.fillColor, drawing.style.fillOpacity);
        ctx.fillRect(x, y, w, h);
        ctx.restore();
      }
      // A border of zero width is a deliberate choice - a zone with no edge -
      // and must not be drawn as a hairline anyway.
      if (drawing.style.width > 0 && drawing.style.opacity > 0) ctx.strokeRect(x, y, w, h);

      if (drawing.style.showPrice) {
        const top = Math.max(drawing.anchors[0]!.price, drawing.anchors[1]!.price);
        const low = Math.min(drawing.anchors[0]!.price, drawing.anchors[1]!.price);
        priceTag(ctx, projection, y, top, drawing.style.color, pricePrecision);
        priceTag(ctx, projection, y + h, low, drawing.style.color, pricePrecision);
      }

      if (drawing.text) {
        ctx.save();
        ctx.setLineDash([]);
        ctx.font = `${drawing.style.fontSize}px var(--font-ui), system-ui, sans-serif`;
        ctx.textBaseline = 'top';
        ctx.fillStyle = border;
        ctx.fillText(drawing.text, x + 5, y + 4);
        ctx.restore();
      }
      break;
    }
    case 'FIB_RETRACEMENT': {
      if (!a || !b) break;
      const extendLeft = option(drawing, 'extendLeft', false);
      const extendRight = option(drawing, 'extendRight', false);
      const left = extendLeft ? 0 : Math.min(a.x, b.x);
      const right = extendRight ? projection.width : Math.max(a.x, b.x);
      const levels = fibLevels(drawing).filter((level) => level.visible);
      const showPercents = option(drawing, 'showPercents', true);
      const showPrices = option(drawing, 'showPrices', true);
      const shade = option(drawing, 'background', false);
      const trendLine = option(drawing, 'trendLine', true);

      if (trendLine) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([4, 4]);
        line(ctx, a, b);
        ctx.restore();
      }

      ctx.setLineDash(dashPattern(drawing.style.dash));
      const ys = levels.map((level) => projection.priceToY(level.price));

      // Shading goes behind the lines, band by band, so a level's own colour
      // still reads on top of it.
      if (shade) {
        ctx.save();
        for (let i = 0; i < levels.length - 1; i += 1) {
          const top = ys[i];
          const bottom = ys[i + 1];
          if (top === null || bottom === null || top === undefined || bottom === undefined) continue;
          ctx.globalAlpha = 0.07;
          ctx.fillStyle = levels[i]!.color;
          ctx.fillRect(left, Math.min(top, bottom), right - left, Math.abs(bottom - top));
        }
        ctx.restore();
      }

      for (let i = 0; i < levels.length; i += 1) {
        const level = levels[i]!;
        const y = ys[i];
        if (y === null || y === undefined) continue;
        ctx.strokeStyle = level.color;
        ctx.fillStyle = level.color;
        ctx.globalAlpha = state === 'PENDING' ? 0.5 : 0.9;
        line(ctx, { x: left, y }, { x: right, y });
        ctx.globalAlpha = 1;
        if (!showPercents && !showPrices) continue;
        ctx.font = `${drawing.style.fontSize}px ui-monospace, monospace`;
        ctx.textBaseline = 'bottom';
        const parts: string[] = [];
        if (showPercents) parts.push(`${(level.fraction * 100).toFixed(1)}%`);
        if (showPrices) parts.push(level.price.toFixed(pricePrecision));
        ctx.fillText(parts.join('  '), left + 4, y - 2);
      }
      ctx.strokeStyle = drawing.style.color;
      ctx.fillStyle = drawing.style.color;
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

  /*
   * Handles, on the SELECTED drawing only.
   *
   * Small white squares with the object's own colour around them: visible
   * against a candle of any colour, and small enough that a selected object
   * still reads as the line or the zone it is rather than as a row of blobs.
   * An unselected drawing shows none of this, which is what keeps a chart with
   * thirty objects on it legible.
   */
  if (state === 'SELECTED') {
    ctx.setLineDash([]);
    ctx.lineWidth = 1.5;
    for (const handle of handlePoints(drawing, projection)) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = drawing.style.color;
      ctx.beginPath();
      ctx.rect(
        Math.round(handle.x) - HANDLE_RADIUS + 0.5,
        Math.round(handle.y) - HANDLE_RADIUS + 0.5,
        HANDLE_RADIUS * 2 - 1,
        HANDLE_RADIUS * 2 - 1,
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
  /*
   * Sized to the number it carries, against the price axis.
   *
   * A price label is read at a glance next to the scale it belongs to; an
   * oversized chip with generous padding is a worse label, not a better one.
   */
  const text = price.toFixed(pricePrecision);
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
  const width = ctx.measureText(text).width + 7;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(projection.width - width - 1, Math.round(y) - 6.5, width, 13, 2);
  ctx.fill();
  ctx.fillStyle = '#07090d';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, projection.width - width + 2.5, Math.round(y));
  ctx.restore();
}
