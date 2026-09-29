/**
 * The concurrency attack harness itself (Resilience Phase 1, Part III). If the
 * harness doesn't actually rendezvous and classify, every race test built on it is
 * meaningless — so it is tested first.
 */
import { describe, expect, it } from 'vitest';
import { Barrier, race, settleAll } from './attack-harness.js';

describe('Barrier', () => {
  it('releases all parties only once the last arrives', async () => {
    const b = new Barrier(3);
    const order: string[] = [];
    const p1 = b.arrive().then(() => order.push('a'));
    const p2 = b.arrive().then(() => order.push('b'));
    // Not released yet — only 2 of 3 arrived.
    await Promise.resolve();
    expect(order).toEqual([]);
    const p3 = b.arrive().then(() => order.push('c'));
    await Promise.all([p1, p2, p3]);
    expect(order.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('settleAll', () => {
  it('splits fulfilled and rejected deterministically', async () => {
    const { fulfilled, rejected } = await settleAll([
      async () => 1,
      async () => { throw new Error('boom'); },
      async () => 3,
    ]);
    expect(fulfilled.sort()).toEqual([1, 3]);
    expect(rejected).toHaveLength(1);
  });
});

describe('race', () => {
  it('runs exactly n contenders and classifies the winner', async () => {
    // A shared "slot" only one contender may claim (a stand-in for a DB unique guard).
    let claimed = false;
    const { fulfilled, rejected } = await race(20, async () => {
      // The barrier means all 20 are past the gate before any claims — but claiming
      // is synchronous here, so exactly one wins.
      if (claimed) throw new Error('TAKEN');
      claimed = true;
      return 'won';
    });
    expect(fulfilled).toEqual(['won']);
    expect(rejected).toHaveLength(19);
  });
});
