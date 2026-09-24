/**
 * Trader analytics metric registry — pure, exhaustive. Every metric has one
 * definition; edge cases (no losses, breakeven, no stop, empty) are explicit and
 * never fabricated. Money is integer micros.
 */
import { describe, expect, it } from 'vitest';
import {
  computeAnalytics,
  computeBreakdowns,
  computeDayStats,
  computeEquityCurve,
  computeStreaks,
  computeTradeStats,
  downsample,
  payoutReturnMultiple,
  type TradeRow,
  type DayRow,
} from './analytics-core.js';

const M = 1_000_000;
let t = 1_000_000_000_000;
function trade(net: number, over: Partial<TradeRow> = {}): TradeRow {
  const entry = (t += 60_000);
  return {
    netPnlMicros: net * M,
    grossPnlMicros: net * M,
    feesMicros: 0,
    side: 'LONG',
    qty: 1,
    symbol: 'NQ',
    entryTimeMs: entry,
    exitTimeMs: entry + 120_000,
    tradeDate: '2026-03-01',
    initialRiskMicros: null,
    ...over,
  };
}

describe('computeTradeStats', () => {
  it('classifies win/loss/breakeven and computes rates', () => {
    const s = computeTradeStats([trade(100), trade(-50), trade(0), trade(200)]);
    expect(s.totalTrades).toBe(4);
    expect(s.winningTrades).toBe(2);
    expect(s.losingTrades).toBe(1);
    expect(s.breakevenTrades).toBe(1);
    // win rate excludes breakeven from the denominator: 2 / (2+1).
    expect(s.winRate).toBeCloseTo(2 / 3);
    expect(s.breakevenRate).toBeCloseTo(1 / 4);
  });

  it('computes P&L aggregates with fees included', () => {
    const s = computeTradeStats([
      trade(100, { feesMicros: 2 * M }),
      trade(-40, { feesMicros: 2 * M }),
    ]);
    expect(s.grossProfitMicros).toBe(100 * M);
    expect(s.grossLossMicros).toBe(-40 * M);
    expect(s.netPnlMicros).toBe(60 * M);
    expect(s.feesMicros).toBe(4 * M);
    expect(s.averageWinMicros).toBe(100 * M);
    expect(s.averageLossMicros).toBe(-40 * M);
    expect(s.largestWinMicros).toBe(100 * M);
    expect(s.largestLossMicros).toBe(-40 * M);
  });

  it('profit factor is undefined (null) with no losses, else gross/|grossLoss|', () => {
    expect(computeTradeStats([trade(100), trade(50)]).profitFactor).toBeNull();
    expect(computeTradeStats([trade(100), trade(-50)]).profitFactor).toBeCloseTo(2);
  });

  it('R-multiple only over trades with a stop at entry; null when none qualify', () => {
    const noR = computeTradeStats([trade(100), trade(-50)]);
    expect(noR.averageRMultiple).toBeNull();
    expect(noR.rSampleSize).toBe(0);
    // A +200 win risking 100 => +2R; a -100 loss risking 100 => -1R; avg +0.5R.
    const withR = computeTradeStats([
      trade(200, { initialRiskMicros: 100 * M }),
      trade(-100, { initialRiskMicros: 100 * M }),
    ]);
    expect(withR.rSampleSize).toBe(2);
    expect(withR.averageRMultiple).toBeCloseTo(0.5);
  });

  it('is total on an empty set', () => {
    const s = computeTradeStats([]);
    expect(s.totalTrades).toBe(0);
    expect(s.winRate).toBeNull();
    expect(s.profitFactor).toBeNull();
    expect(s.netPnlMicros).toBe(0);
    expect(s.expectancyMicros).toBe(0);
  });
});

describe('computeStreaks', () => {
  it('tracks current, best winning, worst losing', () => {
    const s = computeStreaks([trade(1), trade(1), trade(-1), trade(-1), trade(-1), trade(1)]);
    expect(s.bestWinStreak).toBe(2);
    expect(s.worstLossStreak).toBe(-3);
    expect(s.currentStreak).toBe(1);
  });
  it('breakeven resets the streak', () => {
    expect(computeStreaks([trade(1), trade(1), trade(0), trade(1)]).currentStreak).toBe(1);
  });
});

describe('computeDayStats', () => {
  const day = (net: number, counted = true): DayRow => ({ tradeDate: '2026-03-01', realizedPnlMicros: net * M, counted });
  it('counts only counted days and derives percentages', () => {
    const s = computeDayStats([day(100), day(-50), day(0), day(10, false)]);
    expect(s.totalTradingDays).toBe(3);
    expect(s.profitableDays).toBe(1);
    expect(s.losingDays).toBe(1);
    expect(s.breakevenDays).toBe(1);
    expect(s.percentProfitableDays).toBeCloseTo(1 / 3);
    expect(s.bestDayMicros).toBe(100 * M);
    expect(s.worstDayMicros).toBe(-50 * M);
  });
});

describe('computeEquityCurve — trading performance, not balance', () => {
  it('accumulates net P&L and derives drawdown from the peak', () => {
    const c = computeEquityCurve([trade(100), trade(-40), trade(-30), trade(50)], 50_000 * M);
    expect(c.finalEquityMicros).toBe((50_000 + 80) * M);
    // Peak 50,100 after t1; trough 50,030 after t3 => max drawdown 70.
    expect(c.maxDrawdownMicros).toBe(70 * M);
    expect(c.points).toHaveLength(4);
  });

  it('a payout debit is not a trade and never enters the curve (caller excludes it)', () => {
    // Only trades are passed; a withdrawal is not among them, so equity is flat
    // across the withdrawal — proving the curve is trading performance, not balance.
    const c = computeEquityCurve([trade(100), trade(100)], 0);
    expect(c.finalEquityMicros).toBe(200 * M);
    expect(c.maxDrawdownMicros).toBe(0);
  });
});

describe('downsample', () => {
  it('keeps small series intact and bounds large ones', () => {
    expect(downsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
    const big = Array.from({ length: 5000 }, (_, i) => i);
    const ds = downsample(big, 500);
    expect(ds.length).toBeLessThanOrEqual(501);
    expect(ds[0]).toBe(0);
    expect(ds[ds.length - 1]).toBe(4999);
  });
});

describe('computeBreakdowns', () => {
  it('breaks down by instrument and side', () => {
    const b = computeBreakdowns([
      trade(100, { symbol: 'NQ', side: 'LONG' }),
      trade(-50, { symbol: 'ES', side: 'SHORT' }),
      trade(30, { symbol: 'NQ', side: 'SHORT' }),
    ]);
    expect(b.byInstrument.find((x) => x.key === 'NQ')?.netPnlMicros).toBe(130 * M);
    expect(b.bySide.find((x) => x.key === 'SHORT')?.trades).toBe(2);
  });
});

describe('payoutReturnMultiple', () => {
  it('is trader-share / original cost, deterministic, null when cost unknown', () => {
    expect(payoutReturnMultiple(9210 * M, 100 * M)).toBeCloseTo(92.1);
    expect(payoutReturnMultiple(1000 * M, 0)).toBeNull();
    expect(payoutReturnMultiple(1000 * M, null)).toBeNull();
  });
});

describe('computeAnalytics bundle', () => {
  it('assembles the full registry', () => {
    const b = computeAnalytics([trade(100), trade(-50)], [{ tradeDate: '2026-03-01', realizedPnlMicros: 50 * M, counted: true }], 0);
    expect(b.trades.netPnlMicros).toBe(50 * M);
    expect(b.equity.finalEquityMicros).toBe(50 * M);
    expect(b.days.totalTradingDays).toBe(1);
    expect(b.breakdowns.byInstrument.length).toBe(1);
  });
});
