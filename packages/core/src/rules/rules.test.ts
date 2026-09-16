import { describe, expect, it } from 'vitest';
import {
  advanceDrawdown,
  consistencyStatus,
  evaluateRules,
  rollTradingDay,
  type DailyHistory,
  type RuleConfig,
  type RuleMark,
  type RuleState,
} from './rules.js';

/** $1 in micro-dollars, so the numbers below read like money. */
const D = 1_000_000;

const EVAL_50K: RuleConfig = {
  accountSizeMicros: 50_000 * D,
  profitTargetMicros: 3_000 * D,
  maxLossMicros: 2_000 * D,
  drawdownType: 'INTRADAY_TRAILING',
  trailingLockAtMicros: 0,
  dailyLossLimitMicros: 1_000 * D,
  dailyLossPolicy: 'LOCK_DAY',
  consistencyFormula: 'BEST_DAY_OVER_TOTAL',
  consistencyThreshold: 0.4,
  minTradingDays: 3,
  minWinningDays: 0,
  maxTradingDays: null,
  minDailyPnlToCountMicros: 50 * D,
  minWinningDayPnlMicros: 1,
  maxContracts: 5,
  microsCountAsFraction: true,
  flattenOnBreach: true,
};

function state(overrides: Partial<RuleState> = {}): RuleState {
  const size = EVAL_50K.accountSizeMicros;
  return {
    status: 'ACTIVE',
    startingBalanceMicros: size,
    balanceMicros: size,
    highWaterMarkMicros: size,
    drawdownFloorMicros: size - EVAL_50K.maxLossMicros,
    dayStartBalanceMicros: size,
    dayStartEquityMicros: size,
    currentTradeDate: '2026-09-15',
    tradingDaysCount: 0,
    winningDaysCount: 0,
    bestDayProfitMicros: 0,
    lockedUntilDate: null,
    failedReason: null,
    ...overrides,
  };
}

function mark(balance: number, open = 0, tradingDate = '2026-09-15'): RuleMark {
  return {
    balanceMicros: balance,
    openPnlMicros: open,
    equityMicros: balance + open,
    tradingDate,
  };
}

const NO_HISTORY: DailyHistory = {
  bestDayProfitMicros: 0,
  totalProfitMicros: 0,
  tradingDaysCount: 0,
  winningDaysCount: 0,
};

// ------------------------------------------------------------- drawdown ---

describe('drawdown', () => {
  it('a static floor never moves, however well the account does', () => {
    const config = { ...EVAL_50K, drawdownType: 'STATIC' as const };
    const s = state();
    const advanced = advanceDrawdown(config, s, mark(60_000 * D));
    expect(advanced.drawdownFloorMicros).toBe(48_000 * D);
  });

  it('an intraday trailing floor follows UNREALIZED profit', () => {
    // The trade is still open. The floor moves anyway: a run that is given back
    // has still happened, and every firm that trails intraday counts it.
    const s = state();
    const advanced = advanceDrawdown(EVAL_50K, s, mark(50_000 * D, 800 * D));
    expect(advanced.highWaterMarkMicros).toBe(50_800 * D);
    expect(advanced.drawdownFloorMicros).toBe(48_800 * D);
  });

  it('never lowers a floor that has already moved up', () => {
    const s = state({ highWaterMarkMicros: 51_000 * D, drawdownFloorMicros: 49_000 * D });
    const advanced = advanceDrawdown(EVAL_50K, s, mark(50_000 * D));
    expect(advanced.drawdownFloorMicros).toBe(49_000 * D);
  });

  it('stops trailing once the buffer is locked in', () => {
    // trailingLockAt = 0: the floor may rise to the starting balance and no
    // further, which is the usual "your account can no longer be lost to
    // giving back profit" rule.
    const s = state({ highWaterMarkMicros: 55_000 * D, drawdownFloorMicros: 50_000 * D });
    const advanced = advanceDrawdown(EVAL_50K, s, mark(60_000 * D));
    expect(advanced.drawdownFloorMicros).toBe(50_000 * D);
  });

  it('trails forever when no lock is configured', () => {
    const config = { ...EVAL_50K, trailingLockAtMicros: null };
    const s = state({ highWaterMarkMicros: 55_000 * D, drawdownFloorMicros: 53_000 * D });
    const advanced = advanceDrawdown(config, s, mark(60_000 * D));
    expect(advanced.drawdownFloorMicros).toBe(58_000 * D);
  });

  it('an end-of-day floor ignores intraday highs and moves at the roll', () => {
    const config = { ...EVAL_50K, drawdownType: 'EOD_TRAILING' as const, trailingLockAtMicros: null };
    const s = state();

    // A 1,500 spike during the day must not move the floor.
    const intraday = advanceDrawdown(config, s, mark(50_000 * D, 1_500 * D));
    expect(intraday.drawdownFloorMicros).toBe(48_000 * D);

    // The day closes up 400; now it moves, to the CLOSING balance.
    const rolled = rollTradingDay(config, s, mark(50_400 * D, 0, '2026-09-16'));
    expect(rolled.state.drawdownFloorMicros).toBe(48_400 * D);
  });
});

// -------------------------------------------------------------- breaches ---

describe('breaches', () => {
  it('fails the account when equity reaches the floor', () => {
    const s = state();
    const status = evaluateRules(EVAL_50K, s, mark(48_500 * D, -500 * D), NO_HISTORY);
    expect(status.breach?.code).toBe('TRAILING_DRAWDOWN_BREACH');
    expect(status.status).toBe('FAILED');
    expect(status.canTrade).toBe(false);
  });

  it('breaches on UNREALIZED loss, not only on closed trades', () => {
    const s = state();
    const status = evaluateRules(EVAL_50K, s, mark(50_000 * D, -2_000 * D), NO_HISTORY);
    expect(status.breach?.code).toBe('TRAILING_DRAWDOWN_BREACH');
  });

  it('does not breach one tick above the floor', () => {
    // No daily limit here: a 2,000 loss would trip that one first, and this
    // test is about the boundary of the drawdown itself.
    const config = { ...EVAL_50K, dailyLossLimitMicros: null };
    const s = state();
    const status = evaluateRules(config, s, mark(48_000 * D + 1), NO_HISTORY);
    expect(status.breach).toBeNull();
    expect(status.remainingDrawdownMicros).toBe(1);
  });

  it('locks the day, without failing, when the daily loss limit is hit', () => {
    const s = state();
    const status = evaluateRules(EVAL_50K, s, mark(49_000 * D), NO_HISTORY);
    expect(status.breach?.code).toBe('DAILY_LOSS_LIMIT');
    expect(status.status).toBe('LOCKED');
    expect(status.canTrade).toBe(false);
  });

  it('fails outright when the programme says a daily breach is terminal', () => {
    const config = { ...EVAL_50K, dailyLossPolicy: 'FAIL' as const };
    const status = evaluateRules(config, state(), mark(49_000 * D), NO_HISTORY);
    expect(status.status).toBe('FAILED');
  });

  it('prefers the drawdown breach when both break at once', () => {
    // Both rules are broken by the same loss. The one that ends the programme
    // is the one to report.
    const config = { ...EVAL_50K, dailyLossLimitMicros: 500 * D };
    const status = evaluateRules(config, state(), mark(47_000 * D), NO_HISTORY);
    expect(status.breach?.code).toBe('TRAILING_DRAWDOWN_BREACH');
    expect(status.status).toBe('FAILED');
  });

  it('a failed account can never be revived by a later profit', () => {
    const s = state({ status: 'FAILED', failedReason: 'TRAILING_DRAWDOWN_BREACH' });
    const status = evaluateRules(EVAL_50K, s, mark(60_000 * D), NO_HISTORY);
    expect(status.status).toBe('FAILED');
    expect(status.canTrade).toBe(false);
  });

  it('a day lockout clears on the next trading date', () => {
    const locked = state({ status: 'LOCKED', lockedUntilDate: '2026-09-16' });
    expect(evaluateRules(EVAL_50K, locked, mark(50_000 * D, 0, '2026-09-15'), NO_HISTORY).status).toBe(
      'LOCKED',
    );

    const rolled = rollTradingDay(EVAL_50K, locked, mark(50_000 * D, 0, '2026-09-16'));
    expect(rolled.state.status).toBe('ACTIVE');
    expect(rolled.state.lockedUntilDate).toBeNull();
  });
});

// ---------------------------------------------------------------- passing ---

describe('passing the programme', () => {
  it('reaching the target alone is GOAL_REACHED, not PASSED', () => {
    const s = state({ balanceMicros: 53_000 * D });
    const status = evaluateRules(EVAL_50K, s, mark(53_000 * D), NO_HISTORY);
    expect(status.profitTargetMet).toBe(true);
    expect(status.status).toBe('GOAL_REACHED');
    // And trading continues: the days still have to be put in.
    expect(status.canTrade).toBe(true);
  });

  it('passes once every requirement is met', () => {
    const s = state({ balanceMicros: 53_000 * D });
    const history: DailyHistory = {
      bestDayProfitMicros: 1_000 * D,
      totalProfitMicros: 3_000 * D,
      tradingDaysCount: 3,
      winningDaysCount: 3,
    };
    const status = evaluateRules(EVAL_50K, s, mark(53_000 * D), history);
    expect(status.status).toBe('PASSED');
    expect(status.requirements.every((r) => r.met)).toBe(true);
  });

  it('withholds the pass while consistency is out of range', () => {
    const s = state({ balanceMicros: 53_000 * D });
    const history: DailyHistory = {
      bestDayProfitMicros: 2_500 * D,
      totalProfitMicros: 3_000 * D,
      tradingDaysCount: 3,
      winningDaysCount: 3,
    };
    const status = evaluateRules(EVAL_50K, s, mark(53_000 * D), history);
    expect(status.status).toBe('GOAL_REACHED');
    expect(status.consistency?.passing).toBe(false);
    expect(status.requirements.find((r) => r.key === 'CONSISTENCY')?.met).toBe(false);
  });

  it('puts a goal-reached account back to work if it gives the profit back', () => {
    const s = state({ status: 'GOAL_REACHED', balanceMicros: 51_000 * D });
    const status = evaluateRules(EVAL_50K, s, mark(51_000 * D), NO_HISTORY);
    expect(status.status).toBe('ACTIVE');
  });

  it('fails an account that runs past its maximum trading days', () => {
    const config = { ...EVAL_50K, maxTradingDays: 5 };
    const history = { ...NO_HISTORY, tradingDaysCount: 6 };
    const status = evaluateRules(config, state(), mark(50_000 * D), history);
    expect(status.breach?.code).toBe('MAX_TRADING_DAYS');
  });
});

// ------------------------------------------------------------ consistency ---

describe('consistency', () => {
  it('is satisfied by a spread-out run', () => {
    const c = consistencyStatus(EVAL_50K, {
      bestDayProfitMicros: 1_000 * D,
      totalProfitMicros: 3_000 * D,
      tradingDaysCount: 4,
      winningDaysCount: 4,
    })!;
    expect(c.ratio).toBeCloseTo(1 / 3);
    expect(c.passing).toBe(true);
    expect(c.additionalProfitNeededMicros).toBe(0);
  });

  it('says how much more profit brings a lopsided run back in range', () => {
    const c = consistencyStatus(EVAL_50K, {
      bestDayProfitMicros: 2_000 * D,
      totalProfitMicros: 3_000 * D,
      tradingDaysCount: 2,
      winningDaysCount: 2,
    })!;
    expect(c.passing).toBe(false);
    // 2,000 / (3,000 + x) <= 0.4  =>  x >= 2,000
    expect(c.additionalProfitNeededMicros).toBe(2_000 * D);
  });

  it('cannot fail before anything has been traded', () => {
    const c = consistencyStatus(EVAL_50K, NO_HISTORY)!;
    expect(c.ratio).toBeNull();
    expect(c.passing).toBe(true);
  });

  it('is absent when the programme has no consistency rule', () => {
    expect(consistencyStatus({ ...EVAL_50K, consistencyThreshold: null }, NO_HISTORY)).toBeNull();
  });
});

// ------------------------------------------------------------ the day roll ---

describe('the trading day', () => {
  it('counts a day only when it moved enough to matter', () => {
    const s = state({ balanceMicros: 50_020 * D });
    const roll = rollTradingDay(EVAL_50K, s, mark(50_020 * D, 0, '2026-09-16'));
    expect(roll.closed?.counted).toBe(false);
    expect(roll.state.tradingDaysCount).toBe(0);
  });

  it('counts a day that cleared the threshold, and marks a winner', () => {
    const s = state({ balanceMicros: 50_400 * D });
    const roll = rollTradingDay(EVAL_50K, s, mark(50_400 * D, 0, '2026-09-16'));
    expect(roll.closed).toMatchObject({ counted: true, winning: true, netProfitMicros: 400 * D });
    expect(roll.state.tradingDaysCount).toBe(1);
    expect(roll.state.winningDaysCount).toBe(1);
    expect(roll.state.bestDayProfitMicros).toBe(400 * D);
  });

  it('counts a losing day toward trading days but not winning days', () => {
    const s = state({ balanceMicros: 49_700 * D });
    const roll = rollTradingDay(EVAL_50K, s, mark(49_700 * D, 0, '2026-09-16'));
    expect(roll.state.tradingDaysCount).toBe(1);
    expect(roll.state.winningDaysCount).toBe(0);
    expect(roll.state.bestDayProfitMicros).toBe(0);
  });

  it('starts the new day from the closed balance, not from open profit', () => {
    const s = state({ balanceMicros: 50_200 * D });
    // A position is still open and 900 up. The new day's baseline ignores it.
    const roll = rollTradingDay(EVAL_50K, s, mark(50_200 * D, 900 * D, '2026-09-16'));
    expect(roll.state.dayStartBalanceMicros).toBe(50_200 * D);
    expect(roll.state.dayStartEquityMicros).toBe(50_200 * D);
  });

  it('resets the daily loss limit', () => {
    const s = state({ balanceMicros: 49_500 * D });
    const before = evaluateRules(EVAL_50K, s, mark(49_500 * D), NO_HISTORY);
    expect(before.remainingDailyLossMicros).toBe(500 * D);

    const roll = rollTradingDay(EVAL_50K, s, mark(49_500 * D, 0, '2026-09-16'));
    const after = evaluateRules(EVAL_50K, roll.state, mark(49_500 * D, 0, '2026-09-16'), NO_HISTORY);
    expect(after.remainingDailyLossMicros).toBe(1_000 * D);
  });

  it('does nothing when the date has not changed', () => {
    const s = state();
    const roll = rollTradingDay(EVAL_50K, s, mark(50_000 * D, 0, '2026-09-15'));
    expect(roll.closed).toBeNull();
    expect(roll.state).toBe(s);
  });
});

// ------------------------------------------------------- a whole programme ---

describe('a whole evaluation, day by day', () => {
  it('tracks an account from first trade to pass', () => {
    const config = { ...EVAL_50K, minWinningDays: 2 };
    let s = state({ currentTradeDate: null, tradingDaysCount: 0 });
    let history: DailyHistory = { ...NO_HISTORY };

    const day = (date: string, profit: number): void => {
      const m = mark(s.balanceMicros + profit, 0, date);
      const advanced = advanceDrawdown(config, s, m);
      s = { ...s, ...advanced, balanceMicros: m.balanceMicros };
      const roll = rollTradingDay(config, s, { ...m, tradingDate: nextDate(date) });
      s = roll.state;
      if (roll.closed?.counted) {
        history = {
          bestDayProfitMicros: Math.max(history.bestDayProfitMicros, roll.closed.netProfitMicros),
          totalProfitMicros: history.totalProfitMicros + Math.max(0, roll.closed.netProfitMicros),
          tradingDaysCount: s.tradingDaysCount,
          winningDaysCount: s.winningDaysCount,
        };
      }
    };

    s = rollTradingDay(config, s, mark(50_000 * D, 0, '2026-09-15')).state;
    day('2026-09-15', 1_100 * D);
    day('2026-09-16', -400 * D);
    day('2026-09-17', 1_200 * D);
    day('2026-09-18', 1_200 * D);

    expect(s.tradingDaysCount).toBe(4);
    expect(s.winningDaysCount).toBe(3);

    const final = evaluateRules(config, s, mark(s.balanceMicros, 0, '2026-09-19'), history);
    expect(final.profitProgressMicros).toBe(3_100 * D);
    expect(final.status).toBe('PASSED');
    // The floor trailed up with the profit and then locked at the start balance.
    expect(s.drawdownFloorMicros).toBe(50_000 * D);
  });
});

function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
