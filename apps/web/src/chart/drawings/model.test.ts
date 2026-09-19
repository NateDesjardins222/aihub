import { describe, expect, it } from 'vitest';
import {
  ANCHOR_COUNT,
  DEFAULT_STYLE,
  STORED_ANCHORS,
  FIB_LEVELS,
  distanceToLine,
  drawingBounds,
  normalizeStyle,
  withAlpha,
  distanceToRay,
  distanceToSegment,
  fibLevels,
  applyHandle,
  handlePoints,
  handlesFor,
  hitTest,
  isPositionTool,
  magnetAnchor,
  moveAnchor,
  positionReadout,
  translate,
  positionAnchors,
  positionMetrics,
  translateByBars,
  type Drawing,
  type DrawingKind,
  type Projection,
} from './model';

/**
 * Drawing geometry.
 *
 * Hit-testing is what makes a drawing feel like an object rather than a
 * picture, and it is entirely arithmetic, so it is tested without a canvas.
 * The projection below is deliberately linear and obvious: 1 px per second of
 * time and 1 px per price unit, inverted, so every expectation can be read off
 * by hand.
 */

const projection: Projection = {
  // time 0 -> x 0, and one pixel per second
  timeToX: (time) => time / 1000,
  xToTime: (x) => x * 1000,
  // price 100 -> y 0, falling one pixel per unit
  priceToY: (price) => 100 - price,
  yToPrice: (y) => 100 - y,
  // One bar a second, so an index is a time in seconds: enough for the
  // geometry under test, and the bar-index translation is exercised against a
  // series with a GAP in its own test below.
  xToIndex: (x) => x,
  indexToTime: (index) => index * 1000,
  timeToIndex: (time) => time / 1000,
  width: 400,
  height: 200,
};

function drawing(kind: DrawingKind, anchors: Array<[number, number]>, patch: Partial<Drawing> = {}): Drawing {
  return {
    id: 'd1',
    kind,
    symbol: 'NQ',
    anchors: anchors.map(([time, price]) => ({ time, price })),
    style: DEFAULT_STYLE,
    options: {},
    text: '',
    locked: false,
    hidden: false,
    timeframes: [],
    createdAt: 0,
    ...patch,
  };
}

describe('distance helpers', () => {
  it('bounds a segment at its endpoints', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(distanceToSegment({ x: 5, y: 3 }, a, b)).toBeCloseTo(3, 10);
    // past the end, the nearest point is the endpoint itself
    expect(distanceToSegment({ x: 20, y: 0 }, a, b)).toBeCloseTo(10, 10);
  });

  it('lets a ray run past its second point but not behind its first', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(distanceToRay({ x: 100, y: 2 }, a, b)).toBeCloseTo(2, 10);
    expect(distanceToRay({ x: -10, y: 0 }, a, b)).toBeCloseTo(10, 10);
  });

  it('extends a line in both directions', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 10 };
    expect(distanceToLine({ x: -10, y: -10 }, a, b)).toBeCloseTo(0, 10);
  });
});

describe('hitTest', () => {
  it('finds a trend line near its body and misses it elsewhere', () => {
    const line = drawing('TREND_LINE', [
      [0, 100],
      [100_000, 0],
    ]);
    // anchors project to (0,0) and (100,100); the midpoint is (50,50)
    expect(hitTest(line, projection, { x: 50, y: 52 }, false)).toEqual({ kind: 'BODY' });
    expect(hitTest(line, projection, { x: 50, y: 80 }, false)).toBeNull();
  });

  it('does not extend a trend line past its anchors', () => {
    const line = drawing('TREND_LINE', [
      [0, 100],
      [100_000, 0],
    ]);
    expect(hitTest(line, projection, { x: 300, y: 300 }, false)).toBeNull();
  });

  it('extends a ray forward and an extended line both ways', () => {
    const ray = drawing('RAY', [
      [0, 100],
      [100_000, 0],
    ]);
    expect(hitTest(ray, projection, { x: 300, y: 300 }, false)).toEqual({ kind: 'BODY' });
    expect(hitTest(ray, projection, { x: -50, y: -50 }, false)).toBeNull();

    const extended = drawing('EXTENDED_LINE', [
      [0, 100],
      [100_000, 0],
    ]);
    expect(hitTest(extended, projection, { x: -50, y: -50 }, false)).toEqual({ kind: 'BODY' });
  });

  it('prefers a handle to the body once the drawing is selected', () => {
    const line = drawing('TREND_LINE', [
      [0, 100],
      [100_000, 0],
    ]);
    // right on the first anchor: the body would also match here
    const hit = hitTest(line, projection, { x: 0, y: 0 }, true);
    expect(hit?.kind).toBe('HANDLE');
    expect(hit?.kind === 'HANDLE' ? hit.handle.role : null).toEqual({ kind: 'POINT', index: 0 });
    expect(hitTest(line, projection, { x: 0, y: 0 }, false)).toEqual({ kind: 'BODY' });
  });

  it('treats a horizontal line as its whole width', () => {
    const line = drawing('HORIZONTAL_LINE', [[50_000, 40]]);
    expect(hitTest(line, projection, { x: 5, y: 60 }, false)).toEqual({ kind: 'BODY' });
    expect(hitTest(line, projection, { x: 380, y: 60 }, false)).toEqual({ kind: 'BODY' });
    expect(hitTest(line, projection, { x: 380, y: 20 }, false)).toBeNull();
  });

  it('grabs an unfilled rectangle only by its edges', () => {
    const rect = drawing('RECTANGLE', [
      [0, 100],
      [100_000, 0],
    ]);
    expect(hitTest(rect, projection, { x: 50, y: 1 }, false)).toEqual({ kind: 'BODY' });
    expect(hitTest(rect, projection, { x: 50, y: 50 }, false)).toBeNull();

    const filled = drawing(
      'RECTANGLE',
      [
        [0, 100],
        [100_000, 0],
      ],
      { style: { ...DEFAULT_STYLE, filled: true } },
    );
    expect(hitTest(filled, projection, { x: 50, y: 50 }, false)).toEqual({ kind: 'BODY' });
  });

  it('gives a rectangle four corners and four edges, each with its own job', () => {
    const rect = drawing('RECTANGLE', [
      [0, 100],
      [100_000, 0],
    ]);
    // timeToX is time/1000 and priceToY is 100 - price, so anchor 0 is the
    // top-left of the shape and anchor 1 the bottom-right.
    const handles = handlesFor(rect, projection);
    expect(handles).toHaveLength(8);

    const roles = handles.map((handle) => handle.role);
    expect(roles).toContainEqual({ kind: 'CORNER', timeIndex: 0, priceIndex: 0 });
    expect(roles).toContainEqual({ kind: 'CORNER', timeIndex: 1, priceIndex: 1 });
    // The top edge moves the price of whichever anchor is at the top.
    expect(roles).toContainEqual({ kind: 'PRICE', index: 0 });
    expect(roles).toContainEqual({ kind: 'PRICE', index: 1 });
    // The left edge moves the time of whichever anchor is on the left.
    expect(roles).toContainEqual({ kind: 'TIME', index: 0 });
    expect(roles).toContainEqual({ kind: 'TIME', index: 1 });

    const topLeft = handles.find(
      (handle) =>
        handle.role.kind === 'CORNER' &&
        handle.role.timeIndex === 0 &&
        handle.role.priceIndex === 0,
    )!;
    const hit = hitTest(rect, projection, { x: topLeft.x, y: topLeft.y }, true);
    expect(hit?.kind === 'HANDLE' ? hit.handle.role : null).toEqual(topLeft.role);
  });

  it('follows the shape when a rectangle is drawn backwards', () => {
    // Dragged from the bottom-right to the top-left: anchor 1 now holds the
    // left edge and the top price, and the handles must say so.
    const rect = drawing('RECTANGLE', [
      [100_000, 0],
      [0, 100],
    ]);
    const roles = handlesFor(rect, projection).map((handle) => handle.role);
    expect(roles).toContainEqual({ kind: 'TIME', index: 1 });
    expect(roles).toContainEqual({ kind: 'PRICE', index: 1 });
  });

  it('never matches a hidden drawing', () => {
    const line = drawing(
      'TREND_LINE',
      [
        [0, 100],
        [100_000, 0],
      ],
      { hidden: true },
    );
    expect(hitTest(line, projection, { x: 50, y: 50 }, true)).toBeNull();
  });
});

describe('magnet', () => {
  const bar = { time: 60_000, open: 10, high: 14, low: 9, close: 13 };

  it('snaps to the nearest printed price when it is within tolerance', () => {
    expect(magnetAnchor({ time: 61_000, price: 13.4 }, bar, 1)).toEqual({ time: 60_000, price: 13 });
    expect(magnetAnchor({ time: 61_000, price: 8.6 }, bar, 1)).toEqual({ time: 60_000, price: 9 });
  });

  it('leaves the anchor completely alone when nothing printed is close', () => {
    // Not the time either: a magnet that quantises a placement the trader did
    // not ask to quantise is what made moving an object jump a bar at a time.
    expect(magnetAnchor({ time: 61_000, price: 40 }, bar, 1)).toEqual({ time: 61_000, price: 40 });
  });

  it('never invents a price between the ones the bar printed', () => {
    const snapped = magnetAnchor({ time: 61_000, price: 11.5 }, bar, 5);
    expect([bar.open, bar.high, bar.low, bar.close]).toContain(snapped.price);
  });
});

describe('editing', () => {
  it('translates every anchor together', () => {
    const line = drawing('TREND_LINE', [
      [0, 100],
      [60_000, 110],
    ]);
    const moved = translate(line, 30_000, -5);
    expect(moved.anchors).toEqual([
      { time: 30_000, price: 95 },
      { time: 90_000, price: 105 },
    ]);
  });

  it('moves one anchor and leaves the other', () => {
    const line = drawing('TREND_LINE', [
      [0, 100],
      [60_000, 110],
    ]);
    const moved = moveAnchor(line, 1, { time: 120_000, price: 90 });
    expect(moved.anchors[0]).toEqual({ time: 0, price: 100 });
    expect(moved.anchors[1]).toEqual({ time: 120_000, price: 90 });
  });

  it('ignores an anchor index that does not exist', () => {
    const line = drawing('HORIZONTAL_LINE', [[0, 100]]);
    expect(moveAnchor(line, 4, { time: 1, price: 1 })).toBe(line);
  });
});

describe('fib levels', () => {
  it('runs 0 at the second anchor and 1 at the first', () => {
    const fib = drawing('FIB_RETRACEMENT', [
      [0, 100],
      [60_000, 200],
    ]);
    const levels = fibLevels(fib);
    expect(levels[0]!.fraction).toBe(0);
    expect(levels[0]!.price).toBe(200);
    expect(levels[levels.length - 1]!.fraction).toBe(1);
    expect(levels[levels.length - 1]!.price).toBe(100);
    expect(levels.find((l) => l.fraction === 0.5)!.price).toBeCloseTo(150, 10);
    expect(levels.find((l) => l.fraction === 0.618)!.price).toBeCloseTo(138.2, 10);
  });

  it('gives nothing for an unfinished drawing', () => {
    expect(fibLevels(drawing('FIB_RETRACEMENT', [[0, 100]]))).toEqual([]);
  });

  it('uses the levels the drawing carries, not the classic set', () => {
    const fib = drawing(
      'FIB_RETRACEMENT',
      [
        [0, 100],
        [60_000, 200],
      ],
      {
        options: {
          levels: [
            { value: 0, color: '#111111', visible: true },
            { value: 0.705, color: '#222222', visible: false },
            { value: 1, color: '#333333', visible: true },
          ],
        },
      },
    );
    const levels = fibLevels(fib);
    expect(levels.map((level) => level.fraction)).toEqual([0, 0.705, 1]);
    expect(levels[1]!.color).toBe('#222222');
    // A hidden level is still REPORTED - the paint routine decides what to
    // draw, so a level can be toggled back on without losing its colour.
    expect(levels[1]!.visible).toBe(false);
    expect(levels[1]!.price).toBeCloseTo(129.5, 10);
  });

  it('reverses which anchor counts as zero', () => {
    const anchors: Array<[number, number]> = [
      [0, 100],
      [60_000, 200],
    ];
    const forward = fibLevels(drawing('FIB_RETRACEMENT', anchors));
    const reversed = fibLevels(drawing('FIB_RETRACEMENT', anchors, { options: { reverse: true } }));
    expect(forward[0]!.price).toBe(200);
    expect(reversed[0]!.price).toBe(100);
    expect(reversed[reversed.length - 1]!.price).toBe(200);
  });

  it('gives a level saved before opacity and names existed the old defaults', () => {
    const fib = drawing(
      'FIB_RETRACEMENT',
      [
        [0, 100],
        [60_000, 200],
      ],
      { options: { levels: [{ value: 0.5, color: '#444444', visible: true }] } },
    );
    const [level] = fibLevels(fib);
    // Opaque and shown as its percentage: exactly how it looked when it was
    // saved, which is what makes adding a level property safe.
    expect(level!.opacity).toBe(1);
    expect(level!.label).toBe('');
  });

  it('carries a level\u2019s own opacity and name, clamped to a real alpha', () => {
    const fib = drawing(
      'FIB_RETRACEMENT',
      [
        [0, 100],
        [60_000, 200],
      ],
      {
        options: {
          levels: [
            { value: 0.5, color: '#444444', visible: true, opacity: 0.35, label: 'OTE' },
            { value: 0.705, color: '#555555', visible: true, opacity: 4, label: 7 },
          ],
        },
      },
    );
    const levels = fibLevels(fib);
    expect(levels[0]!.opacity).toBeCloseTo(0.35, 10);
    expect(levels[0]!.label).toBe('OTE');
    expect(levels[1]!.opacity).toBe(1);
    expect(levels[1]!.label).toBe('');
  });

  it('falls back to the classic set when the levels are junk', () => {
    const fib = drawing(
      'FIB_RETRACEMENT',
      [
        [0, 100],
        [60_000, 200],
      ],
      { options: { levels: 'not an array' } },
    );
    expect(fibLevels(fib).map((level) => level.fraction)).toEqual(FIB_LEVELS);
  });
});

describe('dragging a handle', () => {
  const rect = drawing('RECTANGLE', [
    [0, 100],
    [100_000, 0],
  ]);

  it('moves one time and one price for a corner', () => {
    const next = applyHandle(
      rect,
      { kind: 'CORNER', timeIndex: 1, priceIndex: 0 },
      { time: 50_000, price: 80 },
    );
    expect(next.anchors[0]).toEqual({ time: 0, price: 80 });
    expect(next.anchors[1]).toEqual({ time: 50_000, price: 0 });
  });

  it('moves only the price for a top or bottom edge', () => {
    const next = applyHandle(rect, { kind: 'PRICE', index: 0 }, { time: 999, price: 60 });
    expect(next.anchors[0]).toEqual({ time: 0, price: 60 });
    expect(next.anchors[1]).toEqual({ time: 100_000, price: 0 });
  });

  it('moves only the time for a left or right edge', () => {
    const next = applyHandle(rect, { kind: 'TIME', index: 1 }, { time: 30_000, price: 999 });
    expect(next.anchors[0]).toEqual({ time: 0, price: 100 });
    expect(next.anchors[1]).toEqual({ time: 30_000, price: 0 });
  });

  it('moves both for a point handle', () => {
    const line = drawing('TREND_LINE', [
      [0, 100],
      [100_000, 0],
    ]);
    const next = applyHandle(line, { kind: 'POINT', index: 1 }, { time: 7, price: 7 });
    expect(next.anchors[1]).toEqual({ time: 7, price: 7 });
  });

  it('leaves the drawing alone when the handle points at nothing', () => {
    expect(applyHandle(rect, { kind: 'POINT', index: 9 }, { time: 1, price: 1 })).toBe(rect);
  });
});

describe('drawing bounds', () => {
  it('covers every handle of a rectangle', () => {
    const rect = drawing('RECTANGLE', [
      [10_000, 90],
      [40_000, 60],
    ]);
    // timeToX is time/1000 and priceToY is 100 - price.
    expect(drawingBounds(rect, projection)).toEqual({ left: 10, right: 40, top: 10, bottom: 40 });
  });

  it('spans the plot for a horizontal line, whose handle sits at the middle', () => {
    const level = drawing('HORIZONTAL_LINE', [[0, 95]]);
    const bounds = drawingBounds(level, projection)!;
    expect(bounds.top).toBe(5);
    expect(bounds.bottom).toBe(5);
    expect(bounds.left).toBe(projection.width / 2);
  });

  it('has no bounds when nothing projects', () => {
    const nowhere: Projection = { ...projection, timeToX: () => null, priceToY: () => null };
    expect(drawingBounds(drawing('TREND_LINE', [[0, 100], [1000, 90]]), nowhere)).toBeNull();
  });
});

describe('styles', () => {
  it('applies alpha to a hex colour', () => {
    expect(withAlpha('#4d8dff', 0.08)).toBe('rgba(77, 141, 255, 0.08)');
    expect(withAlpha('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
  });

  it('leaves a fully opaque colour alone', () => {
    expect(withAlpha('#4d8dff', 1)).toBe('#4d8dff');
  });

  it('passes through a colour it cannot parse rather than mangling it', () => {
    expect(withAlpha('rgba(1, 2, 3, 0.4)', 0.2)).toBe('rgba(1, 2, 3, 0.4)');
  });

  it('defaults to a fill that price action shows through', () => {
    expect(DEFAULT_STYLE.fillOpacity).toBeLessThanOrEqual(0.12);
    expect(DEFAULT_STYLE.opacity).toBe(1);
  });

  describe('normalising a stored style', () => {
    it('recovers the colour and alpha from an old rgba fill', () => {
      const style = normalizeStyle({ color: '#ffffff', fill: 'rgba(91, 157, 255, 0.10)' });
      expect(style.filled).toBe(true);
      expect(style.fillColor).toBe('#5b9dff');
      expect(style.fillOpacity).toBeCloseTo(0.1, 5);
      // A drawing made before border opacity existed was fully opaque.
      expect(style.opacity).toBe(1);
    });

    it('treats a drawing with no fill as unfilled', () => {
      expect(normalizeStyle({ color: '#ffffff', fill: null }).filled).toBe(false);
    });

    it('clamps nonsense', () => {
      const style = normalizeStyle({ opacity: 4, fillOpacity: -2, width: 99, fontSize: 900 });
      expect(style.opacity).toBe(1);
      expect(style.fillOpacity).toBe(0);
      expect(style.width).toBe(10);
      expect(style.fontSize).toBe(32);
    });

    it('falls back to the defaults for junk', () => {
      expect(normalizeStyle(null)).toEqual(DEFAULT_STYLE);
      expect(normalizeStyle('nonsense')).toEqual(DEFAULT_STYLE);
    });
  });
});

describe('moving a drawing by bars', () => {
  /*
   * A series with a hole in it: bars every minute, then a four-hour gap, then
   * bars every minute again. This is what a session break looks like, and it
   * is where translating by milliseconds goes wrong.
   */
  const times = [0, 60_000, 120_000, 180_000, 4 * 3_600_000, 4 * 3_600_000 + 60_000, 4 * 3_600_000 + 120_000];
  const barred: Pick<Projection, 'timeToIndex' | 'indexToTime'> = {
    timeToIndex: (time) => {
      const exact = times.indexOf(time);
      if (exact >= 0) return exact;
      let index = 0;
      while (index < times.length - 1 && times[index + 1]! <= time) index += 1;
      return index;
    },
    indexToTime: (index) => times[Math.max(0, Math.min(times.length - 1, Math.round(index)))] ?? null,
  };

  it('moves each anchor the same number of bars', () => {
    const line = drawing('TREND_LINE', [
      [0, 100],
      [60_000, 90],
    ]);
    const moved = translateByBars(line, 2, 5, barred);
    expect(moved.anchors[0]).toEqual({ time: 120_000, price: 105 });
    expect(moved.anchors[1]).toEqual({ time: 180_000, price: 95 });
  });

  it('keeps its width in bars across a session gap', () => {
    const line = drawing('TREND_LINE', [
      [120_000, 100],
      [180_000, 90],
    ]);
    // Three bars right takes the first anchor over the gap; the second follows
    // it, and the two stay one bar apart - which is what the trader dragged.
    const moved = translateByBars(line, 3, 0, barred);
    const first = barred.timeToIndex(moved.anchors[0]!.time)!;
    const second = barred.timeToIndex(moved.anchors[1]!.time)!;
    expect(second - first).toBe(1);
  });

  it('rounds to whole bars, so an object never sits between two candles', () => {
    const line = drawing('TREND_LINE', [
      [0, 100],
      [60_000, 90],
    ]);
    expect(translateByBars(line, 1.4, 0, barred).anchors[0]!.time).toBe(60_000);
    expect(translateByBars(line, 1.6, 0, barred).anchors[0]!.time).toBe(120_000);
  });

  it('still moves the price when an anchor is off the end of the series', () => {
    const line = drawing('TREND_LINE', [[0, 100]]);
    const nowhere: Pick<Projection, 'timeToIndex' | 'indexToTime'> = {
      timeToIndex: () => null,
      indexToTime: () => null,
    };
    expect(translateByBars(line, 5, -10, nowhere).anchors[0]).toEqual({ time: 0, price: 90 });
  });
});

/**
 * The position tools.
 *
 * NQ numbers, by hand: a 0.25 tick and $5 a tick for one contract. Everything
 * here is arithmetic on three anchors - the point of the tests is that the
 * arithmetic is the arithmetic a trader would do on paper, and that nothing in
 * it touches an order, an account or a fill.
 */
describe('position tools', () => {
  const NQ_TICK = 0.25;
  const NQ_TICK_VALUE = 5;

  it('places a 2:1 trade from the one click that made it', () => {
    const anchors = positionAnchors('LONG_POSITION', { time: 60_000, price: 20_000 }, NQ_TICK, 90_000);
    // 40 ticks up, 20 ticks down: 10 points and 5 points on NQ.
    expect(anchors[0]).toEqual({ time: 60_000, price: 20_000 });
    expect(anchors[1]).toEqual({ time: 90_000, price: 20_010 });
    expect(anchors[2]).toEqual({ time: 90_000, price: 19_995 });
  });

  it('mirrors it for a short', () => {
    const anchors = positionAnchors('SHORT_POSITION', { time: 0, price: 20_000 }, NQ_TICK, 30_000);
    expect(anchors[1]!.price).toBe(19_990);
    expect(anchors[2]!.price).toBe(20_005);
    expect(isPositionTool('SHORT_POSITION')).toBe(true);
    expect(isPositionTool('RECTANGLE')).toBe(false);
  });

  it('prices the trade in ticks, dollars and account risk', () => {
    // Long 3 contracts from 20,000 with a 15-point target and a 5-point stop.
    const long = drawing(
      'LONG_POSITION',
      [
        [0, 20_000],
        [60_000, 20_015],
        [60_000, 19_995],
      ],
      { options: { qty: 3, accountSize: 50_000 } },
    );
    const m = positionMetrics(long, NQ_TICK, NQ_TICK_VALUE)!;
    expect(m.rewardTicks).toBe(60);
    expect(m.riskTicks).toBe(20);
    expect(m.ratio).toBeCloseTo(3, 10);
    // 60 ticks x $5 x 3 = $900 to make, 20 x $5 x 3 = $300 to lose.
    expect(m.rewardMoney).toBe(900);
    expect(m.riskMoney).toBe(300);
    // $300 of a $50,000 account.
    expect(m.riskPercent).toBeCloseTo(0.6, 10);
  });

  it('leaves the money out rather than inventing it', () => {
    const noQty = drawing(
      'SHORT_POSITION',
      [
        [0, 20_000],
        [60_000, 19_990],
        [60_000, 20_005],
      ],
      { options: { qty: 0, accountSize: 0 } },
    );
    const m = positionMetrics(noQty, NQ_TICK, NQ_TICK_VALUE)!;
    expect(m.rewardTicks).toBe(40);
    expect(m.riskTicks).toBe(20);
    expect(m.rewardMoney).toBe(0);
    expect(m.riskMoney).toBe(0);
    // No account size means no percentage, NOT a percentage of nothing.
    expect(m.riskPercent).toBeNull();
  });

  it('has no ratio when the stop is at the entry', () => {
    const flat = drawing('LONG_POSITION', [
      [0, 20_000],
      [60_000, 20_010],
      [60_000, 20_000],
    ]);
    expect(positionMetrics(flat, NQ_TICK, NQ_TICK_VALUE)!.ratio).toBeNull();
  });

  it('stores three anchors although it is placed with one click', () => {
    // A saved chart is checked against STORED_ANCHORS, not against the click
    // count: checking against the click count discarded every saved position
    // on reload.
    expect(STORED_ANCHORS.LONG_POSITION).toBe(3);
    expect(ANCHOR_COUNT.LONG_POSITION).toBe(1);
  });

  it('gives the target and the stop their own handles', () => {
    const long = drawing('LONG_POSITION', [
      [0, 50],
      [60_000, 70],
      [60_000, 40],
    ]);
    const handles = handlesFor(long, projection);
    // Three prices, each on its own, and the two edges of the box.
    expect(handles.filter((h) => h.role.kind === 'PRICE')).toHaveLength(3);
    expect(handles.filter((h) => h.role.kind === 'TIME')).toHaveLength(2);
    const prices = handles.filter((h) => h.role.kind === 'PRICE').map((h) => h.y);
    // price 50 -> y 50, 70 -> 30, 40 -> 60 under this projection
    expect(prices).toEqual([50, 30, 60]);
  });

  it('drags the stop without moving the entry or the target', () => {
    const long = drawing('LONG_POSITION', [
      [0, 50],
      [60_000, 70],
      [60_000, 40],
    ]);
    const moved = applyHandle(long, { kind: 'PRICE', index: 2 }, { time: 999, price: 44 });
    expect(moved.anchors[0]).toEqual({ time: 0, price: 50 });
    expect(moved.anchors[1]).toEqual({ time: 60_000, price: 70 });
    expect(moved.anchors[2]).toEqual({ time: 60_000, price: 44 });
  });

  it('is grabbable anywhere inside the box and nowhere outside it', () => {
    const long = drawing('LONG_POSITION', [
      [0, 50],
      [60_000, 70],
      [60_000, 40],
    ]);
    // x 0..60, y 30..60 under this projection.
    expect(hitTest(long, projection, { x: 30, y: 45 }, false)).toEqual({ kind: 'BODY' });
    expect(hitTest(long, projection, { x: 30, y: 20 }, false)).toBeNull();
    expect(hitTest(long, projection, { x: 200, y: 45 }, false)).toBeNull();
  });
});

describe('positionReadout', () => {
  const metrics = {
    entry: 20000,
    target: 20050,
    stop: 20020,
    rewardPrice: 50,
    riskPrice: 20,
    rewardTicks: 200,
    riskTicks: 80,
    ratio: 2.5,
    qty: 2,
    rewardMoney: 2000,
    riskMoney: 800,
    riskPercent: 1.6,
  };

  it('leads with the points and the ratio', () => {
    const readout = positionReadout(metrics, { pricePrecision: 2, tickValue: 5 });
    // "How far" and "how many times my risk" come before anything else.
    expect(readout.reward.startsWith('+50.00 pts   2.50R')).toBe(true);
  });

  it('shows the risk as a distance too', () => {
    const readout = positionReadout(metrics, { pricePrecision: 2, tickValue: 5 });
    expect(readout.risk.startsWith('−20.00 pts')).toBe(true);
  });

  it('leaves the money out when no contracts have been set', () => {
    const readout = positionReadout(
      { ...metrics, qty: 0, riskPercent: null },
      { pricePrecision: 2, tickValue: 5 },
    );
    expect(readout.reward).not.toMatch(/\$/);
    expect(readout.risk).not.toMatch(/\$/);
  });

  it('adds the money when they have', () => {
    const readout = positionReadout(metrics, { pricePrecision: 2, tickValue: 5 });
    expect(readout.reward).toContain('$2,000');
    expect(readout.risk).toContain('$800');
  });

  it('can be asked for the points alone', () => {
    const readout = positionReadout(metrics, {
      pricePrecision: 2,
      tickValue: 5,
      showTicks: false,
      showMoney: false,
      showRatio: false,
    });
    expect(readout.reward).toBe('+50.00 pts');
  });

  it('states the entry price plainly', () => {
    expect(positionReadout(metrics, { pricePrecision: 2, tickValue: 5 }).entry).toBe('Entry 20000.00');
  });

  it('has no ratio to show when there is no risk', () => {
    const readout = positionReadout(
      { ...metrics, riskPrice: 0, riskTicks: 0, ratio: null, riskMoney: 0, riskPercent: null },
      { pricePrecision: 2, tickValue: 5 },
    );
    expect(readout.reward).not.toMatch(/R\b/);
  });
});
