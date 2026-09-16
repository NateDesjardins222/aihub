/**
 * The prop-firm rule engine.
 *
 * Pure arithmetic over integers: it takes an account's rule configuration, its
 * persisted state and a mark of the market, and returns what the account's
 * status should be and how much room is left under every rule. It performs no
 * I/O, so the server can run it inside a transaction and the tests can run
 * thousands of days of trading in milliseconds.
 *
 * Three principles decide the details:
 *
 *   1. Rules are DATA. Every firm words its programme differently, so nothing
 *      here is specific to one of them - the shape below is what the differences
 *      are expressed in.
 *   2. A breach is decided on equity, continuously, not on the closing balance.
 *      A trailing drawdown that is only checked at the end of the day teaches a
 *      trader that an intraday excursion is free. It is not.
 *   3. Where a rule could be read two ways, take the reading that fails the
 *      trader earlier. A simulator that is more forgiving than the firm is
 *      worse than no simulator: it certifies habits that will fail live.
 */

export type DrawdownType = 'STATIC' | 'INTRADAY_TRAILING' | 'EOD_TRAILING';

export type ConsistencyFormula = 'BEST_DAY_OVER_TOTAL' | 'BEST_DAY_OVER_TARGET';

/** What happens when the daily loss limit is hit. */
export type DailyLossPolicy =
  /** Trading stops for the rest of the day; the account survives. */
  | 'LOCK_DAY'
  /** The account fails outright. */
  | 'FAIL';

export type AccountRuleStatus = 'ACTIVE' | 'GOAL_REACHED' | 'PASSED' | 'FAILED' | 'LOCKED';

export interface RuleConfig {
  readonly accountSizeMicros: number;
  /** Profit above the starting balance that completes the programme. 0 = none. */
  readonly profitTargetMicros: number;
  /** Total permitted loss from the drawdown anchor, positive magnitude. */
  readonly maxLossMicros: number;
  readonly drawdownType: DrawdownType;
  /**
   * Where a trailing drawdown stops following, as profit above the starting
   * balance.
   *
   * 0 means the floor stops at the starting balance, which is how most funded
   * programmes work: once you are `maxLoss` in profit, the buffer is locked and
   * you can no longer lose the account by giving back a winning run. Null means
   * the floor trails forever.
   */
  readonly trailingLockAtMicros: number | null;
  /** Daily loss limit, positive magnitude. Null = no daily limit. */
  readonly dailyLossLimitMicros: number | null;
  readonly dailyLossPolicy: DailyLossPolicy;
  readonly consistencyFormula: ConsistencyFormula;
  /** 0.4 = the best day may not exceed 40%. Null = no consistency rule. */
  readonly consistencyThreshold: number | null;
  readonly minTradingDays: number;
  readonly minWinningDays: number;
  readonly maxTradingDays: number | null;
  /** A day only counts toward minTradingDays if its net P&L reaches this. */
  readonly minDailyPnlToCountMicros: number;
  /** A day is a WINNING day when its net P&L reaches this. */
  readonly minWinningDayPnlMicros: number;
  readonly maxContracts: number;
  readonly microsCountAsFraction: boolean;
  /** Close everything when a rule breaches. Off only for study accounts. */
  readonly flattenOnBreach: boolean;
}

export const PRACTICE_RULES: RuleConfig = {
  accountSizeMicros: 100_000_000_000,
  profitTargetMicros: 0,
  maxLossMicros: 0,
  drawdownType: 'STATIC',
  trailingLockAtMicros: null,
  dailyLossLimitMicros: null,
  dailyLossPolicy: 'LOCK_DAY',
  consistencyFormula: 'BEST_DAY_OVER_TOTAL',
  consistencyThreshold: null,
  minTradingDays: 0,
  minWinningDays: 0,
  maxTradingDays: null,
  minDailyPnlToCountMicros: 0,
  minWinningDayPnlMicros: 1,
  maxContracts: 50,
  microsCountAsFraction: false,
  flattenOnBreach: true,
};

/** The persisted part of an account the rules read and advance. */
export interface RuleState {
  readonly status: AccountRuleStatus;
  readonly startingBalanceMicros: number;
  readonly balanceMicros: number;
  readonly highWaterMarkMicros: number;
  readonly drawdownFloorMicros: number;
  readonly dayStartBalanceMicros: number;
  readonly dayStartEquityMicros: number;
  readonly currentTradeDate: string | null;
  readonly tradingDaysCount: number;
  readonly winningDaysCount: number;
  /** Best single day's net profit so far, for the consistency rule. */
  readonly bestDayProfitMicros: number;
  /** Trading date the account is locked out until, exclusive. */
  readonly lockedUntilDate: string | null;
  readonly failedReason: string | null;
}

/** A mark of the market: what the account is worth right now. */
export interface RuleMark {
  readonly balanceMicros: number;
  readonly openPnlMicros: number;
  readonly equityMicros: number;
  /** The EXCHANGE's trading date, never the server's calendar date. */
  readonly tradingDate: string;
}

export type BreachCode =
  | 'MAX_LOSS_LIMIT'
  | 'TRAILING_DRAWDOWN_BREACH'
  | 'DAILY_LOSS_LIMIT'
  | 'MAX_TRADING_DAYS';

/** What each breach means, in the words the trader sees. */
const BREACH_MESSAGE: Record<BreachCode, string> = {
  MAX_LOSS_LIMIT: 'Maximum loss reached: equity fell to the account floor.',
  TRAILING_DRAWDOWN_BREACH: 'Trailing drawdown breached: equity fell to the drawdown floor.',
  DAILY_LOSS_LIMIT: 'Daily loss limit reached.',
  MAX_TRADING_DAYS: 'The programme ran past its maximum number of trading days.',
};

export interface Breach {
  readonly code: BreachCode;
  readonly message: string;
  /** What the account becomes. LOCKED is recoverable; FAILED is not. */
  readonly status: 'FAILED' | 'LOCKED';
  readonly detail: Record<string, number | string | null>;
}

export interface Requirement {
  readonly key: string;
  readonly label: string;
  readonly met: boolean;
  readonly current: number;
  readonly required: number;
  /** MICROS for money, COUNT for days, RATIO for consistency. */
  readonly unit: 'MICROS' | 'COUNT' | 'RATIO';
}

export interface ConsistencyStatus {
  readonly formula: ConsistencyFormula;
  readonly threshold: number;
  readonly bestDayProfitMicros: number;
  readonly denominatorMicros: number;
  /** Null until there is a positive denominator to divide by. */
  readonly ratio: number | null;
  readonly passing: boolean;
  /**
   * Profit still needed elsewhere before the best day is within threshold.
   *
   * This is the number a trader can act on: "make this much more, spread out,
   * and the consistency rule is satisfied".
   */
  readonly additionalProfitNeededMicros: number;
}

export interface RuleStatus {
  readonly status: AccountRuleStatus;
  readonly balanceMicros: number;
  readonly equityMicros: number;
  readonly openPnlMicros: number;
  readonly dayPnlMicros: number;
  readonly dayRealizedPnlMicros: number;
  readonly highWaterMarkMicros: number;
  readonly drawdownFloorMicros: number;
  readonly remainingDrawdownMicros: number;
  readonly dailyLossLimitMicros: number | null;
  readonly remainingDailyLossMicros: number | null;
  readonly profitTargetMicros: number;
  readonly profitProgressMicros: number;
  readonly profitTargetMet: boolean;
  readonly consistency: ConsistencyStatus | null;
  readonly tradingDaysCount: number;
  readonly winningDaysCount: number;
  readonly requirements: readonly Requirement[];
  readonly breach: Breach | null;
  /** True while the account may send orders. */
  readonly canTrade: boolean;
}

// ---------------------------------------------------------------------------
// Drawdown
// ---------------------------------------------------------------------------

/**
 * Where a trailing floor is allowed to stop.
 *
 * Above this the floor no longer follows the high-water mark, which is what
 * turns a trailing drawdown into a locked buffer once the account is far enough
 * ahead.
 */
function trailCeiling(config: RuleConfig, state: RuleState): number | null {
  if (config.trailingLockAtMicros === null) return null;
  return state.startingBalanceMicros + config.trailingLockAtMicros;
}

function floorFor(config: RuleConfig, state: RuleState, anchorMicros: number): number {
  const raw = anchorMicros - config.maxLossMicros;
  const ceiling = trailCeiling(config, state);
  return ceiling === null ? raw : Math.min(raw, ceiling);
}

/**
 * Advance the drawdown anchor for a new mark.
 *
 * INTRADAY_TRAILING follows equity as it happens, including unrealized profit:
 * an open trade that goes 20 handles your way and comes back has moved the
 * floor, and no amount of "but I did not bank it" changes that. EOD_TRAILING
 * only moves at the day roll, and STATIC never moves at all.
 */
export function advanceDrawdown(
  config: RuleConfig,
  state: RuleState,
  mark: RuleMark,
): { highWaterMarkMicros: number; drawdownFloorMicros: number } {
  if (config.maxLossMicros <= 0) {
    // No drawdown rule: keep the floor far below anything reachable.
    return {
      highWaterMarkMicros: Math.max(state.highWaterMarkMicros, mark.equityMicros),
      drawdownFloorMicros: state.drawdownFloorMicros,
    };
  }

  if (config.drawdownType === 'STATIC') {
    return {
      highWaterMarkMicros: Math.max(state.highWaterMarkMicros, mark.equityMicros),
      drawdownFloorMicros: state.startingBalanceMicros - config.maxLossMicros,
    };
  }

  if (config.drawdownType === 'EOD_TRAILING') {
    // The anchor only moves at the roll, so the mark cannot raise it here. The
    // high-water mark is still tracked, for display and for the roll to use.
    return {
      highWaterMarkMicros: Math.max(state.highWaterMarkMicros, mark.equityMicros),
      drawdownFloorMicros: state.drawdownFloorMicros,
    };
  }

  const hwm = Math.max(state.highWaterMarkMicros, mark.equityMicros);
  return {
    highWaterMarkMicros: hwm,
    // Never lower a floor that has already moved up: a drawdown buffer that
    // gives ground back is not a drawdown buffer.
    drawdownFloorMicros: Math.max(state.drawdownFloorMicros, floorFor(config, state, hwm)),
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Aggregates of the account's completed trading days. */
export interface DailyHistory {
  /** Net profit of the best single day. */
  readonly bestDayProfitMicros: number;
  /** Sum of the positive days, which is what a consistency rule divides into. */
  readonly totalProfitMicros: number;
  readonly tradingDaysCount: number;
  readonly winningDaysCount: number;
}

export function consistencyStatus(
  config: RuleConfig,
  history: DailyHistory,
): ConsistencyStatus | null {
  const threshold = config.consistencyThreshold;
  if (threshold === null || threshold <= 0) return null;

  const denominator =
    config.consistencyFormula === 'BEST_DAY_OVER_TARGET'
      ? config.profitTargetMicros
      : history.totalProfitMicros;

  const best = history.bestDayProfitMicros;
  const ratio = denominator > 0 ? best / denominator : null;

  // How much more profit, made on OTHER days, brings the ratio within range.
  // best / (total + x) <= threshold  =>  x >= best/threshold - total
  const needed =
    best <= 0 ? 0 : Math.max(0, Math.ceil(best / threshold) - Math.max(0, denominator));

  return {
    formula: config.consistencyFormula,
    threshold,
    bestDayProfitMicros: best,
    denominatorMicros: denominator,
    ratio,
    // Nothing traded yet cannot fail a consistency rule.
    passing: ratio === null ? true : ratio <= threshold + 1e-9,
    additionalProfitNeededMicros:
      config.consistencyFormula === 'BEST_DAY_OVER_TARGET' ? 0 : needed,
  };
}

/**
 * Evaluate every rule against one mark.
 *
 * The drawdown anchor must already have been advanced for this mark (see
 * `advanceDrawdown`), because the floor a breach is judged against is the one
 * that includes the profit just made.
 */
export function evaluateRules(
  config: RuleConfig,
  state: RuleState,
  mark: RuleMark,
  history: DailyHistory,
): RuleStatus {
  const dayPnl = mark.equityMicros - state.dayStartEquityMicros;
  const dayRealized = mark.balanceMicros - state.dayStartBalanceMicros;
  const remainingDrawdown = mark.equityMicros - state.drawdownFloorMicros;

  const remainingDaily =
    config.dailyLossLimitMicros === null ? null : config.dailyLossLimitMicros + dayPnl;

  const profitProgress = mark.balanceMicros - state.startingBalanceMicros;
  const profitTargetMet =
    config.profitTargetMicros > 0 && profitProgress >= config.profitTargetMicros;

  const consistency = consistencyStatus(config, history);

  const breach = firstBreach(config, state, mark, {
    remainingDrawdown,
    remainingDaily,
    tradingDaysCount: history.tradingDaysCount,
  });

  const requirements = buildRequirements(config, history, profitProgress, consistency);

  let status: AccountRuleStatus = state.status;
  if (breach) {
    status = breach.status;
  } else if (state.status === 'FAILED') {
    status = 'FAILED';
  } else if (profitTargetMet) {
    status = requirements.every((r) => r.met) ? 'PASSED' : 'GOAL_REACHED';
  } else if (state.status === 'GOAL_REACHED' || state.status === 'PASSED') {
    // Giving profit back after reaching the goal puts the account back to work.
    status = 'ACTIVE';
  } else if (state.status === 'LOCKED') {
    status = lockExpired(state, mark.tradingDate) ? 'ACTIVE' : 'LOCKED';
  }

  return {
    status,
    balanceMicros: mark.balanceMicros,
    equityMicros: mark.equityMicros,
    openPnlMicros: mark.openPnlMicros,
    dayPnlMicros: dayPnl,
    dayRealizedPnlMicros: dayRealized,
    highWaterMarkMicros: state.highWaterMarkMicros,
    drawdownFloorMicros: state.drawdownFloorMicros,
    remainingDrawdownMicros: remainingDrawdown,
    dailyLossLimitMicros: config.dailyLossLimitMicros,
    remainingDailyLossMicros: remainingDaily,
    profitTargetMicros: config.profitTargetMicros,
    profitProgressMicros: profitProgress,
    profitTargetMet,
    consistency,
    tradingDaysCount: history.tradingDaysCount,
    winningDaysCount: history.winningDaysCount,
    requirements,
    breach,
    canTrade: status === 'ACTIVE' || status === 'GOAL_REACHED' || status === 'PASSED',
  };
}

/** Has a day lockout run out? A lockout ends when the trading date changes. */
export function lockExpired(state: RuleState, tradingDate: string): boolean {
  if (state.lockedUntilDate === null) return true;
  return tradingDate >= state.lockedUntilDate;
}

function firstBreach(
  config: RuleConfig,
  state: RuleState,
  mark: RuleMark,
  computed: {
    remainingDrawdown: number;
    remainingDaily: number | null;
    tradingDaysCount: number;
  },
): Breach | null {
  // An account already failed stays failed; nothing can un-fail it. It keeps
  // reporting the rule that ENDED it rather than a generic "already failed",
  // because the reason is the only part a trader can learn anything from.
  if (state.status === 'FAILED') {
    const code = (state.failedReason as BreachCode | null) ?? 'MAX_LOSS_LIMIT';
    return {
      code,
      message: BREACH_MESSAGE[code] ?? BREACH_MESSAGE.MAX_LOSS_LIMIT,
      status: 'FAILED',
      detail: { reason: state.failedReason },
    };
  }

  // Drawdown first: it is the rule that ends the programme.
  if (config.maxLossMicros > 0 && computed.remainingDrawdown <= 0) {
    const trailing = config.drawdownType !== 'STATIC';
    return {
      code: trailing ? 'TRAILING_DRAWDOWN_BREACH' : 'MAX_LOSS_LIMIT',
      message: trailing
        ? BREACH_MESSAGE.TRAILING_DRAWDOWN_BREACH
        : BREACH_MESSAGE.MAX_LOSS_LIMIT,
      status: 'FAILED',
      detail: {
        equityMicros: mark.equityMicros,
        floorMicros: state.drawdownFloorMicros,
        highWaterMarkMicros: state.highWaterMarkMicros,
      },
    };
  }

  if (computed.remainingDaily !== null && computed.remainingDaily <= 0) {
    const fails = config.dailyLossPolicy === 'FAIL';
    return {
      code: 'DAILY_LOSS_LIMIT',
      message: fails
        ? 'Daily loss limit reached. The account has failed.'
        : 'Daily loss limit reached. Trading is locked for the rest of the trading day.',
      status: fails ? 'FAILED' : 'LOCKED',
      detail: {
        dayPnlMicros: mark.equityMicros - state.dayStartEquityMicros,
        limitMicros: config.dailyLossLimitMicros,
        tradingDate: mark.tradingDate,
      },
    };
  }

  if (config.maxTradingDays !== null && computed.tradingDaysCount > config.maxTradingDays) {
    return {
      code: 'MAX_TRADING_DAYS',
      message: BREACH_MESSAGE.MAX_TRADING_DAYS,
      status: 'FAILED',
      detail: { tradingDaysCount: computed.tradingDaysCount, maxTradingDays: config.maxTradingDays },
    };
  }

  return null;
}

function buildRequirements(
  config: RuleConfig,
  history: DailyHistory,
  profitProgressMicros: number,
  consistency: ConsistencyStatus | null,
): Requirement[] {
  const out: Requirement[] = [];

  if (config.profitTargetMicros > 0) {
    out.push({
      key: 'PROFIT_TARGET',
      label: 'Profit target',
      met: profitProgressMicros >= config.profitTargetMicros,
      current: profitProgressMicros,
      required: config.profitTargetMicros,
      unit: 'MICROS',
    });
  }
  if (config.minTradingDays > 0) {
    out.push({
      key: 'MIN_TRADING_DAYS',
      label: 'Trading days',
      met: history.tradingDaysCount >= config.minTradingDays,
      current: history.tradingDaysCount,
      required: config.minTradingDays,
      unit: 'COUNT',
    });
  }
  if (config.minWinningDays > 0) {
    out.push({
      key: 'MIN_WINNING_DAYS',
      label: 'Winning days',
      met: history.winningDaysCount >= config.minWinningDays,
      current: history.winningDaysCount,
      required: config.minWinningDays,
      unit: 'COUNT',
    });
  }
  if (consistency) {
    out.push({
      key: 'CONSISTENCY',
      label: 'Consistency',
      met: consistency.passing,
      current: consistency.ratio ?? 0,
      required: consistency.threshold,
      unit: 'RATIO',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The trading day
// ---------------------------------------------------------------------------

export interface DayRoll {
  readonly state: RuleState;
  /** The day that just ended, for the daily statistics row. */
  readonly closed: {
    readonly tradeDate: string;
    readonly startingBalanceMicros: number;
    readonly endingBalanceMicros: number;
    readonly netProfitMicros: number;
    readonly counted: boolean;
    readonly winning: boolean;
  } | null;
}

/**
 * Roll the account into a new trading date.
 *
 * Everything day-scoped resets here: the day's starting balance and equity, the
 * daily loss limit, and any lockout the previous day imposed. An EOD trailing
 * drawdown moves its anchor now, and only now, using the balance the day
 * actually closed at.
 */
export function rollTradingDay(
  config: RuleConfig,
  state: RuleState,
  mark: RuleMark,
): DayRoll {
  if (state.currentTradeDate === mark.tradingDate) return { state, closed: null };

  const closingBalance = mark.balanceMicros;
  const net = closingBalance - state.dayStartBalanceMicros;
  const hadDay = state.currentTradeDate !== null;
  const counted = hadDay && net !== 0 && Math.abs(net) >= config.minDailyPnlToCountMicros;
  const winning = hadDay && net >= config.minWinningDayPnlMicros;

  let highWaterMarkMicros = Math.max(state.highWaterMarkMicros, closingBalance);
  let drawdownFloorMicros = state.drawdownFloorMicros;
  if (config.maxLossMicros > 0 && config.drawdownType === 'EOD_TRAILING') {
    drawdownFloorMicros = Math.max(
      drawdownFloorMicros,
      floorFor(config, state, Math.max(state.highWaterMarkMicros, closingBalance)),
    );
  }
  if (config.maxLossMicros > 0 && config.drawdownType === 'STATIC') {
    drawdownFloorMicros = state.startingBalanceMicros - config.maxLossMicros;
    highWaterMarkMicros = Math.max(state.highWaterMarkMicros, closingBalance);
  }

  const status: AccountRuleStatus =
    state.status === 'LOCKED' && lockExpired({ ...state }, mark.tradingDate)
      ? 'ACTIVE'
      : state.status;

  return {
    state: {
      ...state,
      status,
      highWaterMarkMicros,
      drawdownFloorMicros,
      currentTradeDate: mark.tradingDate,
      dayStartBalanceMicros: closingBalance,
      // A new day starts from the CLOSED balance, not from equity: an open
      // position's unrealized profit is not a day's starting capital.
      dayStartEquityMicros: closingBalance,
      tradingDaysCount: state.tradingDaysCount + (counted ? 1 : 0),
      winningDaysCount: state.winningDaysCount + (counted && winning ? 1 : 0),
      bestDayProfitMicros: counted ? Math.max(state.bestDayProfitMicros, net) : state.bestDayProfitMicros,
      lockedUntilDate: status === 'LOCKED' ? state.lockedUntilDate : null,
    },
    closed: hadDay
      ? {
          tradeDate: state.currentTradeDate!,
          startingBalanceMicros: state.dayStartBalanceMicros,
          endingBalanceMicros: closingBalance,
          netProfitMicros: net,
          counted,
          winning: counted && winning,
        }
      : null,
  };
}
