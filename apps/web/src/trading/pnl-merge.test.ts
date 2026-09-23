/**
 * D-13 — phantom / stale P&L from the valuation-frame merge.
 *
 * Reproduces the exact defect: a valuation frame that says a position can no
 * longer be priced (openPnlMicros/equityMicros = null, marked = false) used to
 * be coalesced away with `??`, so the terminal kept showing the last good
 * number (e.g. +$8,000) with the NOT-PRICED badge suppressed. The fix applies
 * an authoritative null so unknown stays unknown.
 */
import { describe, expect, it } from 'vitest';
import { mergePnlFrame } from './pnl-merge';
import type { ApiAccountPnl } from './api';

const BASE: ApiAccountPnl = {
  accountId: 'acc-1',
  status: 'ACTIVE',
  startingBalanceMicros: 50_000_000_000,
  balanceMicros: 50_000_000_000,
  equityMicros: 58_000_000_000,
  openPnlMicros: 8_000_000_000, // the phantom +$8,000 (UP&L)
  realizedPnlMicros: 0,
  feesMicros: 0,
  dayPnlMicros: 8_000_000_000,
  drawdownFloorMicros: 48_000_000_000,
  remainingDrawdownMicros: 10_000_000_000,
  profitTargetProgressMicros: 0,
  profitTargetMicros: 3_000_000_000,
  openContracts: 1,
  maxContracts: 10,
  marked: true,
  unmarkable: [],
  seq: 1,
};

describe('valuation-frame merge (D-13)', () => {
  it('an authoritative null clears the stale open P&L instead of keeping it', () => {
    const frame = {
      balanceMicros: 50_000_000_000,
      equityMicros: null,
      openPnlMicros: null,
      dayPnlMicros: null,
      remainingDrawdownMicros: null,
      openContracts: 1,
      rules: { marked: false },
      unmarkable: [{ symbol: 'NQ', openedAgainst: 'era-1', nowServing: 'era-2' }],
    };
    const merged = mergePnlFrame(BASE, frame);
    // The phantom is gone: unknown, not the retained +$8,000.
    expect(merged.openPnlMicros).toBeNull();
    expect(merged.equityMicros).toBeNull();
    expect(merged.dayPnlMicros).toBeNull();
    // And the badge can now fire: marked/unmarkable reflect the live frame.
    expect(merged.marked).toBe(false);
    expect(merged.unmarkable).toHaveLength(1);
    // Balance (never null) is unaffected.
    expect(merged.balanceMicros).toBe(50_000_000_000);
  });

  it('a real number in the frame replaces the previous number', () => {
    const merged = mergePnlFrame(BASE, { openPnlMicros: 1_500_000_000, rules: { marked: true } });
    expect(merged.openPnlMicros).toBe(1_500_000_000);
    expect(merged.marked).toBe(true);
  });

  it('a field the frame omits keeps its prior value', () => {
    // A sparse frame (only balance) must not wipe the rest to null.
    const merged = mergePnlFrame(BASE, { balanceMicros: 50_000_000_000 });
    expect(merged.openPnlMicros).toBe(8_000_000_000);
    expect(merged.equityMicros).toBe(58_000_000_000);
    expect(merged.marked).toBe(true);
  });

  it('zero is a real value, not "unknown" — it is applied as zero', () => {
    const merged = mergePnlFrame(BASE, { openPnlMicros: 0, equityMicros: 50_000_000_000, rules: { marked: true } });
    expect(merged.openPnlMicros).toBe(0);
    expect(merged.equityMicros).toBe(50_000_000_000);
  });
});
