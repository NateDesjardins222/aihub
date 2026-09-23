/**
 * D-01 — multi-chart divider proportions: clamp + persistence.
 *
 * The interactive drag itself is covered by a real-browser test; this pins the
 * pure logic: a divider never collapses a pane, and the proportion survives a
 * snapshot/restore round trip (workspace persistence).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { useLayout, clampSplit } from './layout-store';

describe('multi-chart divider proportions (D-01)', () => {
  beforeEach(() => {
    useLayout.getState().setColSplit(0.5);
    useLayout.getState().setRowSplit(0.5);
  });

  it('clamps a divider away from the edges so a pane never collapses', () => {
    expect(clampSplit(0)).toBe(0.15);
    expect(clampSplit(1)).toBe(0.85);
    expect(clampSplit(0.7)).toBe(0.7);
    expect(clampSplit(Number.NaN)).toBe(0.5);
  });

  it('setColSplit / setRowSplit store the clamped fraction', () => {
    useLayout.getState().setColSplit(0.7);
    expect(useLayout.getState().colSplit).toBe(0.7);
    useLayout.getState().setColSplit(0.02); // below the minimum
    expect(useLayout.getState().colSplit).toBe(0.15);
    useLayout.getState().setRowSplit(0.35);
    expect(useLayout.getState().rowSplit).toBe(0.35);
  });

  it('proportions persist through a snapshot/restore round trip', () => {
    useLayout.getState().setColSplit(0.65);
    useLayout.getState().setRowSplit(0.3);
    const snap = useLayout.getState().snapshot();
    // Reset, then restore — the 65/35 division must come back.
    useLayout.getState().setColSplit(0.5);
    useLayout.getState().setRowSplit(0.5);
    useLayout.getState().restore(snap);
    expect(useLayout.getState().colSplit).toBe(0.65);
    expect(useLayout.getState().rowSplit).toBe(0.3);
  });

  it('a corrupt stored proportion restores to an even split, never a collapsed pane', () => {
    useLayout.getState().restore({ colSplit: 'nonsense', rowSplit: 999 });
    expect(useLayout.getState().colSplit).toBe(0.5);
    expect(useLayout.getState().rowSplit).toBe(0.85); // clamped, not 999
  });
});

describe('apply chart config to other charts (D-04)', () => {
  beforeEach(() => {
    useLayout.getState().restore({}); // reset panes to defaults
    useLayout.getState().setLayout('TWO_V');
  });

  it('copies chart type and indicators, but never symbol or interval', () => {
    // Give the two panes distinct instruments/intervals and configs.
    useLayout.getState().setPaneSymbol('p1', 'NQ');
    useLayout.getState().setPaneSymbol('p2', 'ES');
    useLayout.getState().setPaneTimeframe('p2', '15m');
    useLayout.getState().setPaneChartType('p1', 'HEIKIN_ASHI');
    useLayout.getState().addIndicator('p1', 'EMA');

    useLayout.getState().applyConfigToOtherPanes('p1');

    const p1 = useLayout.getState().panes.find((p) => p.id === 'p1')!;
    const p2 = useLayout.getState().panes.find((p) => p.id === 'p2')!;
    // Chart config propagated.
    expect(p2.chartType).toBe('HEIKIN_ASHI');
    expect(p2.indicators.map((i) => i.kind)).toEqual(['EMA']);
    // Instances are the pane's own (distinct ids), not shared references.
    expect(p2.indicators[0]!.id).not.toBe(p1.indicators[0]!.id);
    // Instrument-specific state is untouched.
    expect(p2.symbol).toBe('ES');
    expect(p2.timeframe).toBe('15m');
  });

  it('does not touch panes the layout is not showing', () => {
    useLayout.getState().setPaneChartType('p1', 'BARS');
    useLayout.getState().applyConfigToOtherPanes('p1');
    // p3/p4 are not visible in TWO_V, so they keep their defaults.
    const p3 = useLayout.getState().panes.find((p) => p.id === 'p3')!;
    expect(p3.chartType).toBe('CANDLES');
  });
});
