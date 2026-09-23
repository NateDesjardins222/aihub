/**
 * V4 tool catalog — Batch 1 (fixed-anchor geometry tools).
 *
 * Proves, without a browser, that each new tool is a REAL tool: registered in
 * the menu registry, carrying the right anchor count and a hit-test that
 * actually claims a cursor on its geometry. The browser drive-test
 * (tools/…) exercises the same tools through the UI; this is the deterministic
 * backstop so a regression is caught in CI, not only by eye.
 */
import { describe, expect, it } from 'vitest';
import { TOOLS, toolDef } from './registry';
import {
  ANCHOR_COUNT,
  STORED_ANCHORS,
  KIND_LABEL,
  hitTest,
  type Drawing,
  type DrawingKind,
  type Projection,
} from './model';

const NEW: DrawingKind[] = [
  'INFO_LINE',
  'TREND_ANGLE',
  'ARROW_MARKER',
  'ARROW_MARK_UP',
  'ARROW_MARK_DOWN',
  'ARROW_MARK_LEFT',
  'ARROW_MARK_RIGHT',
  'CIRCLE',
  'PRICE_RANGE',
  'DATE_RANGE',
  'ANCHORED_TEXT',
  'NOTE',
];

// A projection where time === x and price === y, so geometry is trivial to reason about.
const projection: Projection = {
  width: 1000,
  height: 600,
  timeToX: (t: number) => t,
  priceToY: (p: number) => p,
  xToTime: (x: number) => x,
  yToPrice: (y: number) => y,
  xToIndex: (x: number) => x,
  timeToIndex: (t: number) => t,
  indexToTime: (i: number) => i,
} as unknown as Projection;

function make(kind: DrawingKind, anchors: Array<{ time: number; price: number }>): Drawing {
  const def = toolDef(kind)!;
  return {
    id: 'd1',
    kind,
    symbol: 'NQ',
    anchors,
    style: {
      color: '#8a97ad',
      opacity: 1,
      width: 2,
      dash: 'SOLID',
      fillColor: '#8a97ad',
      fillOpacity: 0.1,
      filled: false,
      fontSize: 11,
      showPrice: false,
    },
    options: { ...def.options },
    text: '',
    locked: false,
    hidden: false,
    timeframes: [],
    createdAt: 0,
  } as unknown as Drawing;
}

describe('V4 catalog batch 1 — every new tool is real', () => {
  it('each new kind is registered in the menu with a label and anchor counts', () => {
    for (const kind of NEW) {
      expect(TOOLS.find((t) => t.kind === kind), `${kind} in TOOLS`).toBeTruthy();
      expect(KIND_LABEL[kind], `${kind} label`).toBeTruthy();
      expect(ANCHOR_COUNT[kind], `${kind} anchor count`).toBeGreaterThanOrEqual(1);
      expect(STORED_ANCHORS[kind], `${kind} stored anchors`).toBe(ANCHOR_COUNT[kind]);
      expect(toolDef(kind)!.props.length, `${kind} has props`).toBeGreaterThan(0);
    }
  });

  it('two-anchor tools are hit-testable on their geometry', () => {
    for (const kind of ['INFO_LINE', 'TREND_ANGLE', 'ARROW_MARKER'] as DrawingKind[]) {
      const d = make(kind, [
        { time: 100, price: 100 },
        { time: 300, price: 300 },
      ]);
      // A cursor on the segment midpoint is claimed.
      expect(hitTest(d, projection, { x: 200, y: 200 }, false), `${kind} mid`).toBeTruthy();
      // A cursor far away is not.
      expect(hitTest(d, projection, { x: 200, y: 20 }, false), `${kind} far`).toBeNull();
    }
  });

  it('one-anchor marks and note are hit-testable at their anchor', () => {
    for (const kind of [
      'ARROW_MARK_UP',
      'ARROW_MARK_DOWN',
      'ARROW_MARK_LEFT',
      'ARROW_MARK_RIGHT',
      'NOTE',
    ] as DrawingKind[]) {
      const d = make(kind, [{ time: 400, price: 250 }]);
      expect(hitTest(d, projection, { x: 400, y: 250 }, false), `${kind} on anchor`).toBeTruthy();
      expect(hitTest(d, projection, { x: 400, y: 320 }, false), `${kind} away`).toBeNull();
    }
  });

  it('circle is hit-testable on its curve, filled inside, empty outside', () => {
    const d = make('CIRCLE', [
      { time: 100, price: 100 },
      { time: 300, price: 300 },
    ]);
    // Centre of an unfilled ellipse is NOT a hit; the curve is.
    expect(hitTest(d, projection, { x: 200, y: 200 }, false)).toBeNull();
    expect(hitTest(d, projection, { x: 300, y: 200 }, false)).toBeTruthy(); // right vertex
  });

  it('price range and date range hit-test between their anchors', () => {
    const pr = make('PRICE_RANGE', [
      { time: 200, price: 100 },
      { time: 200, price: 300 },
    ]);
    expect(hitTest(pr, projection, { x: 200, y: 200 }, false)).toBeTruthy();
    const dr = make('DATE_RANGE', [
      { time: 100, price: 250 },
      { time: 300, price: 250 },
    ]);
    expect(hitTest(dr, projection, { x: 200, y: 250 }, false)).toBeTruthy();
  });
});
