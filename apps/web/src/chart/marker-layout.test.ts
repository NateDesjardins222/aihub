import { describe, expect, it } from 'vitest';
import { hasOverlap, layoutMarkers, type MarkerInput } from './marker-layout';

/**
 * The property that matters is simple to state and was violated by the old
 * overlay: after layout, no two visible labels overlap, and every rule is
 * still at its true price.
 */

const HEIGHT = 18;

function markers(ys: number[]): MarkerInput[] {
  return ys.map((y, i) => ({ id: `m${i}`, y, priority: 0, height: HEIGHT }));
}

function heights(input: readonly MarkerInput[]): Map<string, number> {
  return new Map(input.map((marker) => [marker.id, marker.height]));
}

describe('layoutMarkers', () => {
  it('leaves well-separated markers exactly where they are', () => {
    const input = markers([50, 150, 250]);
    const out = layoutMarkers(input, { height: 400 });
    expect(out.map((p) => p.labelY)).toEqual([50, 150, 250]);
    expect(out.every((p) => p.leader === 0)).toBe(true);
  });

  it('never moves the rule, only the label', () => {
    const input = markers([200, 201, 202, 203]);
    const out = layoutMarkers(input, { height: 400 });
    expect(out.map((p) => p.y)).toEqual([200, 201, 202, 203]);
  });

  it('separates four labels stacked on the same price', () => {
    const input = markers([200, 200, 200, 200]);
    const out = layoutMarkers(input, { height: 400 });
    expect(hasOverlap(out, heights(input))).toBe(false);
  });

  it('separates labels two pixels apart', () => {
    const input = markers([120, 122, 124, 126, 128]);
    const out = layoutMarkers(input, { height: 400 });
    expect(hasOverlap(out, heights(input))).toBe(false);
  });

  it('keeps every label inside the chart', () => {
    const input = markers([2, 3, 4, 5, 6]);
    const out = layoutMarkers(input, { height: 200 });
    for (const placement of out) {
      expect(placement.labelY - HEIGHT / 2).toBeGreaterThanOrEqual(-0.001);
      expect(placement.labelY + HEIGHT / 2).toBeLessThanOrEqual(200.001);
    }
    expect(hasOverlap(out, heights(input))).toBe(false);
  });

  it('handles a cluster at the very bottom without overlapping', () => {
    const input = markers([396, 397, 398, 399]);
    const out = layoutMarkers(input, { height: 400 });
    expect(hasOverlap(out, heights(input))).toBe(false);
    for (const placement of out) {
      expect(placement.labelY + HEIGHT / 2).toBeLessThanOrEqual(400.001);
    }
  });

  it('reports an off-scale marker as not visible rather than drawing it', () => {
    const input: MarkerInput[] = [
      { id: 'a', y: 100, priority: 0, height: HEIGHT },
      { id: 'b', y: Number.NaN, priority: 0, height: HEIGHT },
    ];
    const out = layoutMarkers(input, { height: 400 });
    expect(out.find((p) => p.id === 'b')!.visible).toBe(false);
    expect(out.find((p) => p.id === 'a')!.visible).toBe(true);
  });

  it('returns a placement for every input, in the input order', () => {
    const input = markers([300, 100, 200]);
    const out = layoutMarkers(input, { height: 400 });
    expect(out.map((p) => p.id)).toEqual(['m0', 'm1', 'm2']);
  });

  it('is stable: the same input gives the same output', () => {
    const input = markers([200, 200, 201, 260, 261]);
    const first = layoutMarkers(input, { height: 400 });
    const second = layoutMarkers([...input].reverse(), { height: 400 });
    const byId = new Map(second.map((p) => [p.id, p.labelY]));
    for (const placement of first) expect(byId.get(placement.id)).toBeCloseTo(placement.labelY, 10);
  });

  it('respects a requested gap between labels', () => {
    const input = markers([200, 200, 200]);
    const out = layoutMarkers(input, { height: 400, gap: 6 });
    expect(hasOverlap(out, heights(input), 6)).toBe(false);
  });

  it('copes with more markers than fit, without stacking any two', () => {
    const input = markers(Array.from({ length: 12 }, (_, i) => 100 + i));
    const out = layoutMarkers(input, { height: 160 });
    expect(hasOverlap(out, heights(input))).toBe(false);
  });

  it('records a leader offset wherever the label had to move', () => {
    const input = markers([200, 201]);
    const out = layoutMarkers(input, { height: 400 });
    expect(out.some((p) => p.leader !== 0)).toBe(true);
    for (const placement of out) {
      expect(placement.labelY - placement.y).toBeCloseTo(placement.leader, 10);
    }
  });
});
