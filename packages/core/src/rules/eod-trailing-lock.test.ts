/**
 * Phase 3.5 — LOCKED EOD-trailing drawdown semantics (Happy Trader V1).
 *
 * Encodes the brief's exact CORE 50K sequence: the floor ratchets only at the
 * finalized day roll, off the finalized closing balance; it never moves backward;
 * and it LOCKS at the starting balance once the high-water mark has risen by the
 * full drawdown amount (trailingLockAtMicros = 0). Intraday unrealized gains never
 * ratchet the floor, but the CURRENT floor is enforced intraday against equity.
 */
import { describe, expect, it } from 'vitest';
import {
  advanceDrawdown,
  evaluateRules,
  rollTradingDay,
  type DailyHistory,
  type RuleConfig,
  type RuleMark,
  type RuleState,
} from './rules.js';

const D = 1_000_000;

// CORE 50K as locked in @atlas/contracts: $2,000 EOD-trailing DD, lock at start.
const CORE_50K: RuleConfig = {
  accountSizeMicros: 50_000 * D,
  profitTargetMicros: 3_000 * D,
  maxLossMicros: 2_000 * D,
  drawdownType: 'EOD_TRAILING',
  trailingLockAtMicros: 0,
  dailyLossLimitMicros: null,
  dailyLossPolicy: 'LOCK_DAY',
  consistencyFormula: 'BEST_DAY_OVER_TOTAL',
  consistencyThreshold: 0.5,
  minTradingDays: 0,
  minWinningDays: 0,
  maxTradingDays: null,
  minDailyPnlToCountMicros: 0,
  minWinningDayPnlMicros: 150 * D,
  maxContracts: 5,
  microsCountAsFraction: true,
  flattenOnBreach: true,
};

function freshState(): RuleState {
  const size = CORE_50K.accountSizeMicros;
  return {
    status: 'ACTIVE',
    startingBalanceMicros: size,
    balanceMicros: size,
    highWaterMarkMicros: size,
    drawdownFloorMicros: size - CORE_50K.maxLossMicros, // 48,000
    dayStartBalanceMicros: size,
    dayStartEquityMicros: size,
    currentTradeDate: '2026-09-15',
    tradingDaysCount: 0,
    winningDaysCount: 0,
    bestDayProfitMicros: 0,
    lockedUntilDate: null,
    failedReason: null,
  };
}

const mark = (balance: number, open = 0, tradingDate = '2026-09-15'): RuleMark => ({
  balanceMicros: balance,
  openPnlMicros: open,
  equityMicros: balance + open,
  tradingDate,
});

const NO_HISTORY: DailyHistory = { bestDayProfitMicros: 0, totalProfitMicros: 0, tradingDaysCount: 0, winningDaysCount: 0 };

describe('CORE 50K EOD-trailing floor — ratchet, lock, never backward', () => {
  it('1. starts with a floor of $48,000', () => {
    expect(freshState().drawdownFloorMicros).toBe(48_000 * D);
  });

  it('2. an intraday unrealized gain to $52,000 does NOT move the floor', () => {
    const s = freshState();
    const advanced = advanceDrawdown(CORE_50K, s, mark(50_000 * D, 2_000 * D));
    expect(advanced.drawdownFloorMicros).toBe(48_000 * D);
  });

  it('3. a finalized EOD close of $51,000 ratchets the floor to $49,000', () => {
    const roll = rollTradingDay(CORE_50K, freshState(), mark(51_000 * D, 0, '2026-09-16'));
    expect(roll.state.drawdownFloorMicros).toBe(49_000 * D);
  });

  it('4. a finalized EOD close of $52,000 ratchets the floor to $50,000 (starting balance)', () => {
    const s = { ...freshState(), highWaterMarkMicros: 51_000 * D, drawdownFloorMicros: 49_000 * D };
    const roll = rollTradingDay(CORE_50K, s, mark(52_000 * D, 0, '2026-09-16'));
    expect(roll.state.drawdownFloorMicros).toBe(50_000 * D);
  });

  it('5. a further HWM of $55,000 keeps the floor LOCKED at $50,000', () => {
    const s = { ...freshState(), highWaterMarkMicros: 52_000 * D, drawdownFloorMicros: 50_000 * D };
    const roll = rollTradingDay(CORE_50K, s, mark(55_000 * D, 0, '2026-09-16'));
    expect(roll.state.drawdownFloorMicros).toBe(50_000 * D);
  });

  it('6. the floor never moves backward on a losing day', () => {
    const s = { ...freshState(), highWaterMarkMicros: 55_000 * D, drawdownFloorMicros: 50_000 * D };
    const roll = rollTradingDay(CORE_50K, s, mark(51_000 * D, 0, '2026-09-16'));
    expect(roll.state.drawdownFloorMicros).toBe(50_000 * D);
  });

  it('7. a losing day does not loosen the floor (floor stays, does not drop)', () => {
    const s = { ...freshState(), highWaterMarkMicros: 52_000 * D, drawdownFloorMicros: 50_000 * D };
    const roll = rollTradingDay(CORE_50K, s, mark(50_500 * D, 0, '2026-09-16'));
    expect(roll.state.drawdownFloorMicros).toBe(50_000 * D);
  });
});

describe('CORE 50K breach — current floor enforced intraday on equity', () => {
  it('17. equity reaching the current floor intraday is a breach', () => {
    const s = freshState(); // floor 48,000
    const r = evaluateRules(CORE_50K, s, mark(48_500 * D, -600 * D), NO_HISTORY); // equity 47,900
    expect(r.remainingDrawdownMicros).toBeLessThanOrEqual(0);
    expect(r.breach).not.toBeNull();
    expect(r.canTrade).toBe(false);
  });

  it('18. an intraday unrealized gain does not ratchet the EOD floor (still 48,000)', () => {
    const s = freshState();
    const r = evaluateRules(CORE_50K, s, mark(50_000 * D, 3_000 * D), NO_HISTORY); // equity 53,000
    expect(r.drawdownFloorMicros).toBe(48_000 * D);
    expect(r.breach).toBeNull();
  });
});
