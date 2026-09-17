import { describe, expect, it } from 'vitest';
import {
  analyze,
  breakdowns,
  computeStats,
  dailyResults,
  equityCurve,
  rMultiple,
  EMPTY_STATS,
  type TradeRecord,
} from './analytics.js';

const D = 1_000_000;
const MINUTE = 60_000;

let seq = 0;
function trade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  seq += 1;
  const net = overrides.netPnlMicros ?? 100 * D;
  const fees = overrides.feesMicros ?? 0;
  return {
    id: `t${String(seq).padStart(4, '0')}`,
    symbol: 'NQ',
    side: 'LONG',
    qty: 1,
    entryTime: seq * MINUTE,
    exitTime: seq * MINUTE + 5 * MINUTE,
    grossPnlMicros: net + fees,
    feesMicros: fees,
    netPnlMicros: net,
    maeMicros: -20 * D,
    mfeMicros: 150 * D,
    initialRiskMicros: 100 * D,
    tradeDate: '2026-09-15',
    ...overrides,
  };
}

describe('nothing to measure', () => {
  it('reports no statistics rather than zeroes', () => {
    const stats = computeStats([]);
    expect(stats).toEqual(EMPTY_STATS);
    expect(stats.winRate).toBeNull();
    expect(stats.profitFactor).toBeNull();
    expect(stats.expectancyMicros).toBeNull();
  });

  it('refuses to call a run with no losses infinitely profitable', () => {
    const stats = computeStats([trade({ netPnlMicros: 50 * D }), trade({ netPnlMicros: 70 * D })]);
    // Two winners and no losers is not a profit factor; it is too few trades.
    expect(stats.profitFactor).toBeNull();
    expect(stats.winRate).toBe(1);
  });
});

describe('the basic figures', () => {
  const sample = [
    trade({ netPnlMicros: 200 * D, feesMicros: 5 * D }),
    trade({ netPnlMicros: -100 * D, feesMicros: 5 * D }),
    trade({ netPnlMicros: 150 * D, feesMicros: 5 * D }),
    trade({ netPnlMicros: -50 * D, feesMicros: 5 * D }),
    trade({ netPnlMicros: 0, feesMicros: 5 * D }),
  ];

  it('counts wins, losses and scratches separately', () => {
    const stats = computeStats(sample);
    expect(stats.trades).toBe(5);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(2);
    expect(stats.scratches).toBe(1);
    // A scratch decides nothing, so it is not in the win rate.
    expect(stats.winRate).toBe(0.5);
  });

  it('computes profit factor from net results', () => {
    const stats = computeStats(sample);
    expect(stats.grossProfitMicros).toBe(350 * D);
    expect(stats.grossLossMicros).toBe(150 * D);
    expect(stats.profitFactor).toBeCloseTo(350 / 150);
  });

  it('computes expectancy over every trade, scratches included', () => {
    const stats = computeStats(sample);
    expect(stats.netPnlMicros).toBe(200 * D);
    expect(stats.expectancyMicros).toBe((200 * D) / 5);
  });

  it('reports the average and the largest of each side of the ledger', () => {
    const stats = computeStats(sample);
    expect(stats.avgWinMicros).toBe(175 * D);
    expect(stats.avgLossMicros).toBe(75 * D);
    expect(stats.largestWinMicros).toBe(200 * D);
    expect(stats.largestLossMicros).toBe(100 * D);
  });

  it('adds up fees and contracts', () => {
    const stats = computeStats(sample);
    expect(stats.feesMicros).toBe(25 * D);
    expect(stats.contracts).toBe(5);
  });
});

describe('R multiples', () => {
  it('is the net result over what the trade risked', () => {
    expect(rMultiple(trade({ netPnlMicros: 250 * D, initialRiskMicros: 100 * D }))).toBe(2.5);
    expect(rMultiple(trade({ netPnlMicros: -100 * D, initialRiskMicros: 100 * D }))).toBe(-1);
  });

  it('is undefined for a trade taken without a stop', () => {
    expect(rMultiple(trade({ initialRiskMicros: null }))).toBeNull();
    const stats = computeStats([
      trade({ netPnlMicros: 100 * D, initialRiskMicros: null }),
      trade({ netPnlMicros: 200 * D, initialRiskMicros: 100 * D }),
    ]);
    // Only the trade that risked something can be measured in R.
    expect(stats.ratedTrades).toBe(1);
    expect(stats.avgRMultiple).toBe(2);
    expect(stats.totalR).toBe(2);
  });

  it('reports expectancy in R only over the trades that have one', () => {
    const stats = computeStats([
      trade({ netPnlMicros: 300 * D, initialRiskMicros: 100 * D }),
      trade({ netPnlMicros: -100 * D, initialRiskMicros: 100 * D }),
      trade({ netPnlMicros: 999 * D, initialRiskMicros: null }),
    ]);
    expect(stats.expectancyR).toBe(1);
  });
});

describe('streaks', () => {
  it('finds the longest run each way', () => {
    const stats = computeStats([
      trade({ netPnlMicros: 10 * D }),
      trade({ netPnlMicros: 10 * D }),
      trade({ netPnlMicros: 10 * D }),
      trade({ netPnlMicros: -10 * D }),
      trade({ netPnlMicros: -10 * D }),
      trade({ netPnlMicros: 10 * D }),
    ]);
    expect(stats.streaks.longestWins).toBe(3);
    expect(stats.streaks.longestLosses).toBe(2);
    expect(stats.streaks.currentWins).toBe(1);
    expect(stats.streaks.currentLosses).toBe(0);
  });

  it('lets a scratch break a run without starting one', () => {
    const stats = computeStats([
      trade({ netPnlMicros: 10 * D }),
      trade({ netPnlMicros: 0 }),
      trade({ netPnlMicros: 10 * D }),
    ]);
    expect(stats.streaks.longestWins).toBe(1);
    expect(stats.streaks.currentWins).toBe(1);
  });

  it('counts streaks in the order the trades closed, not the order given', () => {
    const later = trade({ netPnlMicros: -10 * D, exitTime: 900 * MINUTE });
    const earlier = trade({ netPnlMicros: 10 * D, exitTime: 100 * MINUTE });
    const stats = computeStats([later, earlier]);
    expect(stats.streaks.currentLosses).toBe(1);
  });
});

describe('excursions', () => {
  it('averages how far trades went against and for the trader', () => {
    const stats = computeStats([
      trade({ maeMicros: -40 * D, mfeMicros: 100 * D }),
      trade({ maeMicros: -80 * D, mfeMicros: 200 * D }),
    ]);
    expect(stats.avgMaeMicros).toBe(-60 * D);
    expect(stats.avgMfeMicros).toBe(150 * D);
  });

  it('measures how much of the best excursion a winner kept', () => {
    const stats = computeStats([
      trade({ netPnlMicros: 50 * D, mfeMicros: 100 * D }),
      trade({ netPnlMicros: 100 * D, mfeMicros: 100 * D }),
    ]);
    expect(stats.captureRatio).toBe(0.75);
  });

  it('never claims more than all of an excursion was captured', () => {
    // Fees can make a net result exceed the gross excursion on paper; the
    // ratio is still capped, because you cannot keep more than there was.
    const stats = computeStats([trade({ netPnlMicros: 120 * D, mfeMicros: 100 * D })]);
    expect(stats.captureRatio).toBe(1);
  });
});

describe('hold times', () => {
  it('separates how long winners and losers are held', () => {
    const stats = computeStats([
      trade({ netPnlMicros: 10 * D, entryTime: 0, exitTime: 10 * MINUTE }),
      trade({ netPnlMicros: -10 * D, entryTime: 0, exitTime: 60 * MINUTE }),
    ]);
    expect(stats.avgHoldMs).toBe(35 * MINUTE);
    expect(stats.avgWinHoldMs).toBe(10 * MINUTE);
    expect(stats.avgLossHoldMs).toBe(60 * MINUTE);
  });
});

describe('the equity curve', () => {
  it('walks the balance through the trades in order', () => {
    const curve = equityCurve(
      [
        trade({ netPnlMicros: 100 * D, exitTime: 1 }),
        trade({ netPnlMicros: -300 * D, exitTime: 2 }),
        trade({ netPnlMicros: 50 * D, exitTime: 3 }),
      ],
      50_000 * D,
    );
    expect(curve.points.map((p) => p.equityMicros)).toEqual([
      50_100 * D,
      49_800 * D,
      49_850 * D,
    ]);
    expect(curve.endMicros).toBe(49_850 * D);
    expect(curve.peakMicros).toBe(50_100 * D);
  });

  it('measures the deepest fall from a peak, not from the start', () => {
    const curve = equityCurve(
      [
        trade({ netPnlMicros: 1_000 * D, exitTime: 1 }),
        trade({ netPnlMicros: -400 * D, exitTime: 2 }),
        trade({ netPnlMicros: -200 * D, exitTime: 3 }),
        trade({ netPnlMicros: 900 * D, exitTime: 4 }),
      ],
      10_000 * D,
    );
    expect(curve.maxDrawdownMicros).toBe(600 * D);
    expect(curve.maxDrawdownPct).toBeCloseTo((600 * D) / (11_000 * D));
  });

  it('has no drawdown when nothing ever fell', () => {
    const curve = equityCurve([trade({ netPnlMicros: 10 * D })], 1_000 * D);
    expect(curve.maxDrawdownMicros).toBe(0);
  });
});

describe('breakdowns', () => {
  const mixed = [
    trade({ symbol: 'NQ', side: 'LONG', netPnlMicros: 100 * D, hourOfDay: 9, dayOfWeek: 1 }),
    trade({ symbol: 'NQ', side: 'SHORT', netPnlMicros: -50 * D, hourOfDay: 9, dayOfWeek: 1 }),
    trade({ symbol: 'CL', side: 'LONG', netPnlMicros: 200 * D, hourOfDay: 14, dayOfWeek: 3 }),
  ];

  it('splits by instrument', () => {
    const cl = breakdowns(mixed).bySymbol.find((b) => b.key === 'CL')!;
    expect(cl.trades).toBe(1);
    expect(cl.netPnlMicros).toBe(200 * D);
  });

  it('splits long from short', () => {
    const byside = breakdowns(mixed).bySide;
    expect(byside.find((b) => b.key === 'LONG')!.netPnlMicros).toBe(300 * D);
    expect(byside.find((b) => b.key === 'SHORT')!.netPnlMicros).toBe(-50 * D);
  });

  it('splits by hour and weekday when the caller supplies them', () => {
    const { byHour, byWeekday } = breakdowns(mixed);
    expect(byHour.map((b) => b.label)).toEqual(['09:00', '14:00']);
    expect(byWeekday.map((b) => b.label)).toEqual(['Monday', 'Wednesday']);
  });

  it('leaves out trades with no hour rather than bucketing them as midnight', () => {
    const { byHour } = breakdowns([trade({ hourOfDay: undefined })]);
    expect(byHour).toHaveLength(0);
  });
});

describe('daily results', () => {
  it('adds up each trading date', () => {
    const days = dailyResults([
      trade({ tradeDate: '2026-09-15', netPnlMicros: 100 * D }),
      trade({ tradeDate: '2026-09-15', netPnlMicros: -40 * D }),
      trade({ tradeDate: '2026-09-16', netPnlMicros: 70 * D }),
    ]);
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ tradeDate: '2026-09-15', netPnlMicros: 60 * D, trades: 2, wins: 1, losses: 1 });
    expect(days[1]!.netPnlMicros).toBe(70 * D);
  });
});

describe('at scale', () => {
  it('analyses ten thousand trades quickly and consistently', () => {
    // Deterministic pseudo-random results: a journal has to stay usable when a
    // trader has years of history in it.
    let seedState = 12345;
    const next = (): number => {
      seedState = (seedState * 1103515245 + 12345) % 2147483648;
      return seedState / 2147483648;
    };

    const many: TradeRecord[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const win = next() > 0.45;
      const size = Math.round((win ? 1 : -1) * (20 + next() * 400)) * D;
      many.push(
        trade({
          netPnlMicros: size,
          feesMicros: 5 * D,
          exitTime: i * MINUTE,
          entryTime: i * MINUTE - 3 * MINUTE,
          symbol: i % 3 === 0 ? 'CL' : 'NQ',
          side: i % 2 === 0 ? 'LONG' : 'SHORT',
          hourOfDay: 8 + (i % 7),
          dayOfWeek: 1 + (i % 5),
          tradeDate: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`,
        }),
      );
    }

    const started = performance.now();
    const result = analyze(many, 100_000 * D);
    const elapsed = performance.now() - started;

    expect(result.stats.trades).toBe(10_000);
    expect(result.curve.points).toHaveLength(10_000);
    expect(result.days.length).toBeGreaterThan(20);
    expect(result.breakdowns.bySymbol).toHaveLength(2);
    // The whole journal, analysed, well inside a frame budget.
    expect(elapsed).toBeLessThan(1_500);

    // And the arithmetic still reconciles: the curve ends where the sum says.
    expect(result.curve.endMicros).toBe(100_000 * D + result.stats.netPnlMicros);
  });
});
