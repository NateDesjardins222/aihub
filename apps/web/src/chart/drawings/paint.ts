/**
 * Painting a drawing.
 *
 * Pure functions of (drawing, projection, state): no React, no closures over
 * component state, nothing that can go stale between the frame that schedules
 * a repaint and the frame that performs it.
 */
import {
  ENTRY,
  HANDLE_RADIUS,
  STOP,
  TARGET,
  withAlpha,
  fibLevels,
  handlePoints,
  isPositionTool,
  positionMetrics,
  project,
  type Drawing,
  type Point,
  type Projection,
} from './model';
import { option } from './registry';

export type PaintState = 'NORMAL' | 'HOVER' | 'SELECTED' | 'PENDING';

/**
 * A dash pattern, scaled to the line it is drawn with.
 *
 * A fixed pattern stops being a pattern on a thick line: with round caps and a
 * five-pixel line, [1, 3] paints a solid line, because each round cap is wider
 * than the gap after it. A dotted level set to five pixels looked exactly like
 * a solid one. So the pattern grows with the width, and `dashCap` turns the
 * round caps off whenever a pattern is in use.
 */
function dashPattern(dash: Drawing['style']['dash'], width = 1): number[] {
  const w = Math.max(1, width);
  if (dash === 'DASHED') return [Math.max(4, w * 3), Math.max(3, w * 2)];
  if (dash === 'DOTTED') return [Math.max(1, w), Math.max(2, w * 2)];
  return [];
}

/** Round caps are for solid lines; on a dashed one they close the gaps. */
function dashCap(dash: Drawing['style']['dash']): CanvasLineCap {
  return dash === 'SOLID' ? 'round' : 'butt';
}

/**
 * Paint one drawing.
 *
 * Separated from the component so it is a plain function of (drawing,
 * projection, state) - no closures over React state, nothing to go stale.
 */
/**
 * What the position tools need to turn ticks into money.
 *
 * `tickValue` is dollars per tick for ONE contract. Zero is a legitimate value
 * - the instrument is not known yet - and simply leaves the money out rather
 * than printing a zero that looks like a real number.
 */
export interface PaintMarket {
  readonly tickSize: number;
  readonly tickValue: number;
}

export function drawDrawing(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  projection: Projection,
  state: PaintState,
  pricePrecision: number,
  market: PaintMarket = { tickSize: 0.25, tickValue: 0 },
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
  ctx.setLineDash(
    state === 'PENDING' ? [4, 3] : dashPattern(drawing.style.dash, drawing.style.width),
  );
  ctx.lineCap = state === 'PENDING' ? 'butt' : dashCap(drawing.style.dash);
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
    case 'TREND_LINE': {
      if (!a || !b) break;
      /*
       * A trend line can be extended from either end without becoming a ray
       * or an extended line: the object a trader drew between two swings is
       * still that object, and turning the extension off has to bring it back
       * exactly where it was.
       */
      const from = option(drawing, 'extendLeft', false) ? extend(b, a, projection) : a;
      const to = option(drawing, 'extendRight', false) ? extend(a, b, projection) : b;
      line(ctx, from, to);
      if (drawing.style.showPrice) {
        priceTag(ctx, projection, b.y, drawing.anchors[1]!.price, drawing.style.color, pricePrecision);
      }
      if (drawing.text) {
        ctx.save();
        ctx.setLineDash([]);
        ctx.font = `${drawing.style.fontSize}px var(--font-ui), system-ui, sans-serif`;
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = border;
        ctx.fillText(drawing.text, Math.min(a.x, b.x) + 4, Math.min(a.y, b.y) - 4);
        ctx.restore();
      }
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
      const shadeOpacity = option(drawing, 'shadeOpacity', 0.07);
      const labelSide = option<string>(drawing, 'labelSide', 'LEFT');
      const trendLine = option(drawing, 'trendLine', true);

      if (trendLine) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([4, 4]);
        line(ctx, a, b);
        ctx.restore();
      }

      ctx.setLineDash(dashPattern(drawing.style.dash, drawing.style.width));
      const ys = levels.map((level) => projection.priceToY(level.price));

      // Shading goes behind the lines, band by band, so a level's own colour
      // still reads on top of it.
      if (shade) {
        ctx.save();
        for (let i = 0; i < levels.length - 1; i += 1) {
          const top = ys[i];
          const bottom = ys[i + 1];
          if (top === null || bottom === null || top === undefined || bottom === undefined) continue;
          ctx.globalAlpha = shadeOpacity;
          ctx.fillStyle = levels[i]!.color;
          ctx.fillRect(left, Math.min(top, bottom), right - left, Math.abs(bottom - top));
        }
        ctx.restore();
      }

      for (let i = 0; i < levels.length; i += 1) {
        const level = levels[i]!;
        const y = ys[i];
        if (y === null || y === undefined) continue;
        // Each level carries its own colour AND its own opacity, so one level
        // can be the one that matters and the rest can sit back.
        ctx.strokeStyle = withAlpha(level.color, level.opacity);
        ctx.fillStyle = withAlpha(level.color, level.opacity);
        ctx.globalAlpha = state === 'PENDING' ? 0.5 : 1;
        // A level's own thickness and line style, when it has been given one:
        // zero and undefined both mean "whatever the object uses".
        ctx.lineWidth = level.width > 0 ? level.width : drawing.style.width;
        const levelDash = level.dash ?? drawing.style.dash;
        ctx.setLineDash(dashPattern(levelDash, ctx.lineWidth));
        ctx.lineCap = dashCap(levelDash);
        line(ctx, { x: left, y }, { x: right, y });
        ctx.globalAlpha = 1;
        if (!showPercents && !showPrices) continue;
        ctx.font = `${drawing.style.fontSize}px ui-monospace, monospace`;
        ctx.textBaseline = 'bottom';
        const parts: string[] = [];
        // A level named by the trader is shown by that name: "OTE" says more
        // than 70.5% to whoever wrote it.
        if (showPercents) parts.push(level.label || `${(level.fraction * 100).toFixed(1)}%`);
        if (showPrices) parts.push(level.price.toFixed(pricePrecision));
        const text = parts.join('  ');
        // Labels on whichever side the trader asked for: on the left they sit
        // over the bars the retracement came from, on the right they sit in
        // the space it is projecting into.
        const textX =
          labelSide === 'RIGHT' ? right - 4 - ctx.measureText(text).width : left + 4;
        ctx.fillText(text, textX, y - 2);
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
    case 'LONG_POSITION':
    case 'SHORT_POSITION': {
      drawPosition(ctx, drawing, projection, points, pricePrecision, market);
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

/**
 * A planned trade: the target zone, the stop zone and what they are worth.
 *
 * It draws a trade; it never places one. The numbers are arithmetic on the
 * three anchors and the instrument's tick value - no account, no order, no
 * engine - which is why the tool can be dragged around freely while an actual
 * position sits untouched in the panel below.
 */
function drawPosition(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  projection: Projection,
  points: ReadonlyArray<Point | null>,
  pricePrecision: number,
  market: PaintMarket,
): void {
  const entry = points[ENTRY];
  const target = points[TARGET];
  const stop = points[STOP];
  if (!entry || !target || !stop) return;

  const metrics = positionMetrics(drawing, market.tickSize, market.tickValue);
  if (!metrics) return;

  const left = Math.min(entry.x, target.x);
  const right = Math.max(entry.x, target.x);
  const width = Math.max(4, right - left);
  const profitColor = option(drawing, 'profitColor', '#2ec4a6');
  const lossColor = option(drawing, 'lossColor', '#f2544b');
  const zoneOpacity = option(drawing, 'zoneOpacity', 0.14);

  ctx.save();
  ctx.setLineDash([]);

  // The two zones. Drawn from the entry outwards, so a target dragged through
  // the entry simply makes the profit zone zero-height rather than inverting.
  const zone = (from: number, to: number, color: string): void => {
    const top = Math.min(from, to);
    const height = Math.abs(to - from);
    ctx.fillStyle = withAlpha(color, zoneOpacity);
    ctx.fillRect(left, top, width, height);
    ctx.strokeStyle = withAlpha(color, 0.85);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, Math.round(to) + 0.5);
    ctx.lineTo(right, Math.round(to) + 0.5);
    ctx.stroke();
  };
  zone(entry.y, target.y, profitColor);
  zone(entry.y, stop.y, lossColor);

  // The entry, which is the one line the trader measures everything from.
  ctx.strokeStyle = withAlpha(drawing.style.color, drawing.style.opacity);
  ctx.lineWidth = Math.max(1, drawing.style.width);
  ctx.beginPath();
  ctx.moveTo(left, Math.round(entry.y) + 0.5);
  ctx.lineTo(right, Math.round(entry.y) + 0.5);
  ctx.stroke();

  // --- the readout ---------------------------------------------------------
  const showTicks = option(drawing, 'showTicks', true);
  const showMoney = option(drawing, 'showMoney', true);
  const showRatio = option(drawing, 'showRatio', true);
  const fontSize = drawing.style.fontSize;
  ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, monospace`;
  ctx.textBaseline = 'middle';

  const money = (value: number): string =>
    `$${Math.round(Math.abs(value)).toLocaleString('en-US')}`;

  const row = (label: string, price: number, ticks: number, cash: number | null): string => {
    const out = [`${label} ${price.toFixed(pricePrecision)}`];
    if (showTicks) out.push(`${ticks}t`);
    if (cash !== null && showMoney) out.push(money(cash));
    return out.join('   ');
  };

  const cash = metrics.qty > 0 && market.tickValue > 0;
  const labels: Array<{ y: number; text: string; color: string }> = [
    {
      y: target.y,
      text: row('Target', metrics.target, metrics.rewardTicks, cash ? metrics.rewardMoney : null),
      color: profitColor,
    },
    {
      y: stop.y,
      text: row('Stop', metrics.stop, metrics.riskTicks, cash ? -metrics.riskMoney : null),
      color: lossColor,
    },
  ];
  /*
   * Each label at the middle of its OWN zone, and nothing where there is no
   * room for it.
   *
   * Drawn beside their lines, the three readouts collided the moment the
   * zones were a few candles tall - a 40-tick target on a one-minute chart is
   * about twenty-five pixels - and three overlapping rows of numbers is worse
   * than none.
   */
  /*
   * Behind every row, a little of the chart's own background.
   *
   * Numbers read over a candle wick are not numbers. The backing is the
   * workspace colour at 62%, sized to the text, so the price action is still
   * visible through it.
   */
  const textRow = (text: string, x: number, y: number, color: string): void => {
    const width = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(7, 9, 13, 0.62)';
    ctx.fillRect(x - 3, y - fontSize * 0.72, width + 6, fontSize * 1.45);
    ctx.fillStyle = withAlpha(color, 1);
    ctx.fillText(text, x, y);
  };

  for (const label of labels) {
    const height = Math.abs(label.y - entry.y);
    if (height < fontSize + 2) continue;
    textRow(label.text, left + 6, (label.y + entry.y) / 2, label.color);
  }

  // The summary sits ABOVE the box, clear of both zones.
  const summary: string[] = [`Entry ${metrics.entry.toFixed(pricePrecision)}`];
  if (showRatio && metrics.ratio !== null) summary.push(`R:R ${metrics.ratio.toFixed(2)}`);
  if (metrics.qty > 0) summary.push(`${metrics.qty}x`);
  if (metrics.riskPercent !== null) summary.push(`${metrics.riskPercent.toFixed(2)}% of account`);
  textRow(
    summary.join('   '),
    left + 6,
    Math.min(target.y, stop.y, entry.y) - fontSize * 0.8,
    drawing.style.color,
  );

  if (drawing.style.showPrice) {
    priceTag(ctx, projection, entry.y, metrics.entry, drawing.style.color, pricePrecision);
    priceTag(ctx, projection, target.y, metrics.target, profitColor, pricePrecision);
    priceTag(ctx, projection, stop.y, metrics.stop, lossColor, pricePrecision);
  }

  ctx.restore();
}
