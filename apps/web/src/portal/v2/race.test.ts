/**
 * Latest-request guard (Product Rebuild Phase 2, Parts XIII/XIV — stale/race).
 * Proves rapid A → B → A navigation and out-of-order mutation responses cannot
 * paint a stale result over the newer authoritative state.
 */
import { describe, expect, it } from 'vitest';
import { latestGuard } from './race';

describe('latestGuard', () => {
  it('only the most recently issued token is latest', () => {
    const g = latestGuard();
    const a = g.issue();
    const b = g.issue();
    expect(g.isLatest(a)).toBe(false);
    expect(g.isLatest(b)).toBe(true);
  });

  it('rapid account switch A → B → A ends on the newest, discarding stale A/B responses', () => {
    const g = latestGuard();
    const applied: string[] = [];
    const apply = (token: number, label: string) => { if (g.isLatest(token)) applied.push(label); };

    const tA1 = g.issue(); // open A
    const tB = g.issue();  // switch to B
    const tA2 = g.issue(); // switch back to A

    // Responses arrive OUT OF ORDER: B (late), then original A, then newest A.
    apply(tB, 'B');   // discarded — superseded
    apply(tA1, 'A#1'); // discarded — superseded
    apply(tA2, 'A#2'); // applied — it is the latest intent

    expect(applied).toEqual(['A#2']);
  });

  it('an out-of-order mutation response never overwrites the newer state', () => {
    const g = latestGuard();
    const first = g.issue();  // mutation A
    const second = g.issue(); // newer mutation B
    // A's response comes back AFTER B was issued → must be ignored.
    expect(g.isLatest(first)).toBe(false);
    expect(g.isLatest(second)).toBe(true);
  });

  it('a retry issues a fresh token that supersedes the failed attempt', () => {
    const g = latestGuard();
    const failed = g.issue();
    const retry = g.issue();
    expect(g.isLatest(failed)).toBe(false);
    expect(g.isLatest(retry)).toBe(true);
  });
});
