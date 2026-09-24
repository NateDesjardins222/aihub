/** Copy sizing — pure, exhaustive, deterministic. */
import { describe, expect, it } from 'vitest';
import { computeFollowerQty, validateFollowerSizing } from './copy-sizing.js';

describe('computeFollowerQty', () => {
  it('SAME copies the leader quantity', () => {
    expect(computeFollowerQty(2, { mode: 'SAME' })).toMatchObject({ qty: 2, skipped: false });
    expect(computeFollowerQty(7, { mode: 'SAME' })).toMatchObject({ qty: 7, skipped: false });
  });

  it('MULTIPLIER uses floor rounding (conservative, deterministic)', () => {
    expect(computeFollowerQty(2, { mode: 'MULTIPLIER', multiplierMilli: 1000 }).qty).toBe(2); // 1.0x
    expect(computeFollowerQty(2, { mode: 'MULTIPLIER', multiplierMilli: 500 }).qty).toBe(1); // 0.5x
    expect(computeFollowerQty(2, { mode: 'MULTIPLIER', multiplierMilli: 2000 }).qty).toBe(4); // 2.0x
    expect(computeFollowerQty(3, { mode: 'MULTIPLIER', multiplierMilli: 500 }).qty).toBe(1); // floor(1.5)
    expect(computeFollowerQty(5, { mode: 'MULTIPLIER', multiplierMilli: 333 }).qty).toBe(1); // floor(1.665)
    expect(computeFollowerQty(10, { mode: 'MULTIPLIER', multiplierMilli: 250 }).qty).toBe(2); // floor(2.5)
  });

  it('MULTIPLIER defaults to 1.0x when unset', () => {
    expect(computeFollowerQty(4, { mode: 'MULTIPLIER', multiplierMilli: null }).qty).toBe(4);
  });

  it('MULTIPLIER that rounds to zero is an explicit skip with a reason', () => {
    const s = computeFollowerQty(1, { mode: 'MULTIPLIER', multiplierMilli: 500 }); // floor(0.5)=0
    expect(s.qty).toBe(0);
    expect(s.skipped).toBe(true);
    expect(s.note).toMatch(/rounds to 0/i);
  });

  it('FIXED attempts the configured quantity regardless of leader size', () => {
    expect(computeFollowerQty(3, { mode: 'FIXED', fixedQty: 1 }).qty).toBe(1);
    expect(computeFollowerQty(10, { mode: 'FIXED', fixedQty: 1 }).qty).toBe(1);
    expect(computeFollowerQty(1, { mode: 'FIXED', fixedQty: 5 }).qty).toBe(5);
  });

  it('FIXED zero is an explicit skip', () => {
    expect(computeFollowerQty(3, { mode: 'FIXED', fixedQty: 0 })).toMatchObject({ qty: 0, skipped: true });
  });

  it('rejects a non-positive leader quantity', () => {
    expect(computeFollowerQty(0, { mode: 'SAME' }).skipped).toBe(true);
    expect(computeFollowerQty(-2, { mode: 'MULTIPLIER', multiplierMilli: 1000 }).skipped).toBe(true);
    expect(computeFollowerQty(1.5, { mode: 'SAME' }).skipped).toBe(true);
  });

  it('every result carries a human note', () => {
    for (const s of [
      computeFollowerQty(2, { mode: 'SAME' }),
      computeFollowerQty(2, { mode: 'MULTIPLIER', multiplierMilli: 500 }),
      computeFollowerQty(2, { mode: 'FIXED', fixedQty: 1 }),
      computeFollowerQty(1, { mode: 'MULTIPLIER', multiplierMilli: 500 }),
    ]) {
      expect(s.note.length).toBeGreaterThan(0);
    }
  });
});

describe('validateFollowerSizing', () => {
  it('accepts sane config and rejects invalid', () => {
    expect(validateFollowerSizing({ mode: 'SAME' })).toBeNull();
    expect(validateFollowerSizing({ mode: 'MULTIPLIER', multiplierMilli: 500 })).toBeNull();
    expect(validateFollowerSizing({ mode: 'MULTIPLIER', multiplierMilli: 0 })).toBeTruthy();
    expect(validateFollowerSizing({ mode: 'MULTIPLIER', multiplierMilli: 200_000 })).toBeTruthy();
    expect(validateFollowerSizing({ mode: 'FIXED', fixedQty: 2 })).toBeNull();
    expect(validateFollowerSizing({ mode: 'FIXED', fixedQty: 0 })).toBeTruthy();
    expect(validateFollowerSizing({ mode: 'FIXED', fixedQty: 5000 })).toBeTruthy();
  });
});
