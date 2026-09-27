/**
 * Engineering Phase A — resizable-pane split math (STEP 17/20).
 *
 * A dragged split must adapt as studies are added/removed without throwing away
 * the price pane's share the trader chose, and must never collapse to a
 * one-element "split" that would overwrite their arrangement on reload.
 */
import { describe, expect, it } from 'vitest';
import { adaptSplit, automaticSplit } from './pane-split';

describe('adaptSplit', () => {
  it('returns null when there is nothing to split', () => {
    expect(adaptSplit(null, 2)).toBeNull();
    expect(adaptSplit([], 2)).toBeNull();
    expect(adaptSplit([3, 1], 1)).toBeNull(); // one pane has no split
  });

  it('returns the split unchanged when the count matches', () => {
    expect(adaptSplit([3, 1], 2)).toEqual([3, 1]);
    expect(adaptSplit([6, 1, 1], 3)).toEqual([6, 1, 1]);
  });

  it('keeps the price pane share and splits the rest when a pane is added', () => {
    // price kept at 3; the two lower panes share what was below (1) equally.
    expect(adaptSplit([3, 1], 3)).toEqual([3, 0.5, 0.5]);
  });

  it('keeps the price pane share when a pane is removed', () => {
    // price kept at 6; one lower pane gets all of what was below (2).
    expect(adaptSplit([6, 1, 1], 2)).toEqual([6, 2]);
  });

  it('never produces a one-element split (which is not a split)', () => {
    const out = adaptSplit([3, 1], 1);
    expect(out).toBeNull();
  });

  it('the price pane is never shrunk by adding a study', () => {
    const before = [8, 2];
    const after = adaptSplit(before, 4)!;
    expect(after[0]).toBe(8); // price share untouched
    expect(after.slice(1).reduce((a, b) => a + b, 0)).toBeCloseTo(2, 9); // below preserved
  });
});

describe('automaticSplit', () => {
  it('is null for a single pane', () => {
    expect(automaticSplit(1)).toBeNull();
  });
  it('gives the price pane about three quarters', () => {
    expect(automaticSplit(2)).toEqual([3, 1]); // 3/(3+1) = 75%
    const three = automaticSplit(3)!;
    expect(three[0]! / three.reduce((a, b) => a + b, 0)).toBeCloseTo(6 / 8, 9);
  });
});
