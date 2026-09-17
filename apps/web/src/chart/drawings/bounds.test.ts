import { describe, expect, it } from 'vitest';
import { BoundsCache, computeBox, projectionSignature } from './bounds';
import { DEFAULT_STYLE, type Drawing, type Projection } from './model';

/**
 * The hit-test bounds cache.
 *
 * It exists for speed, and the failure it caused was subtle enough to be worth
 * a test of its own: an object whose geometry changed WITHOUT a gesture kept
 * its old rectangle, so it could not be clicked where it was.
 */
const projection: Projection = {
  timeToX: (time) => time / 1000,
  xToTime: (x) => x * 1000,
  priceToY: (price) => 100 - price,
  yToPrice: (y) => 100 - y,
  xToIndex: (x) => x,
  indexToTime: (index) => index * 1000,
  timeToIndex: (time) => time / 1000,
  width: 400,
  height: 200,
};

function line(anchors: Array<[number, number]>): Drawing {
  return {
    id: 'd1',
    kind: 'TREND_LINE',
    symbol: 'NQ',
    anchors: anchors.map(([time, price]) => ({ time, price })),
    style: DEFAULT_STYLE,
    options: {},
    text: '',
    locked: false,
    hidden: false,
    timeframes: [],
    createdAt: 0,
  };
}

describe('bounds cache', () => {
  it('boxes a drawing from its anchors', () => {
    expect(
      computeBox(
        line([
          [0, 90],
          [20_000, 70],
        ]),
        projection,
      ),
    ).toEqual({ left: 0, right: 20, top: 10, bottom: 30 });
  });

  it('recomputes when the geometry changed under the same view', () => {
    const cache = new BoundsCache();
    const before = line([
      [0, 90],
      [20_000, 70],
    ]);
    cache.sync(projection);
    expect(cache.mayHit(before, projection, 10, 20)).toBe(true);
    expect(cache.mayHit(before, projection, 10, 120)).toBe(false);

    // The same object, moved by something that is NOT a gesture - a price
    // typed into the settings dialog, an undo, a template. The store replaces
    // the object, the view has not moved, and the cache must notice.
    const after = line([
      [0, -10],
      [20_000, -30],
    ]);
    expect(cache.mayHit(after, projection, 10, 120)).toBe(true);
    expect(cache.mayHit(after, projection, 10, 20)).toBe(false);
  });

  it('keeps the cached box while the object is unchanged', () => {
    const cache = new BoundsCache();
    const drawing = line([
      [0, 90],
      [20_000, 70],
    ]);
    cache.sync(projection);
    const first = cache.boxFor(drawing, projection);
    expect(cache.boxFor(drawing, projection)).toBe(first);
  });

  it('changes its signature when the view moves', () => {
    const moved: Projection = { ...projection, xToTime: (x) => x * 1000 + 5_000 };
    expect(projectionSignature(moved)).not.toBe(projectionSignature(projection));
  });
});
