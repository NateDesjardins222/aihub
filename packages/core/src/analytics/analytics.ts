/**
 * Trade analytics.
 *
 * Pure arithmetic over closed trades. Every figure a trader might act on has a
 * definition that can be argued with, so each one is stated here rather than
 * left to the reader of a chart: what counts as a win, what expectancy is
 * measured in, and which trades an R multiple can even be computed for.
 *
 * Three rules govern the numbers:
 *
 *   1. NET is the default. A win is a trade that made money after fees, because
 *      that is the only kind that pays. Gross figures are reported separately.
 *   2. A statistic that cannot be computed is null, never zero. Profit factor
 *      with no losses is not "infinity dollars of edge", and expectancy over
 *      zero trades is not break-even.
 *   3. Nothing is annualised, smoothed or projected. These are records of what
 *      happened.
 */

export type TradeSide = 'LONG' | 'SHORT';

/** One closed trade, as the journal records it. */
export interface TradeRecord {
  readonly id: string;
  readonly symbol: string;
  readonly side: TradeSide;
  readonly qty: number;
  readonly entryTime: number;
  readonly exitTime: number;
  readonly grossPnlMicros: number;
  readonly feesMicros: number;
  readonly netPnlMicros: number;
  /** Worst unrealized P&L while open, <= 0. */
  readonly maeMicros: number;
  /** Best unrealized P&L while open, >= 0. */
  readonly mfeMicros: number;
  /** What the trade risked at entry. Null when it had no stop. */
  readonly initialRiskMicros: number | null;
  readonly tradeDate: string;
  /** Exchange timezone hour and weekday, supplied by the caller. */
  readonly hourOfDay?: number;
  readonly dayOfWeek?: number;
}

export interface Bucket {
  readonly key: string;
  readonly label: string;
  readonly trades: number;
  readonly netPnlMicros: number;
  readonly winRate: number | null;
  readonly expectancyMicros: number | null;
}

export interface StreakInfo {
  readonly longestWins: number;
  readonly longestLosses: number;
  readonly currentWins: number;
  readonly currentLosses: number;
}

export interface TradeStats {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly scratches: number;
  /** Wins / (wins + losses). Scratches are excluded: they decide nothing. */
  readonly winRate: number | null;
  readonly grossProfitMicros: number;
  readonly grossLossMicros: number;
  readonly netPnlMicros: number;
  readonly feesMicros: number;
  /** Gross profit / gross loss. Null when nothing has been lost yet. */
  readonly profitFactor: number | null;
  /** Average net result per trade, in micro-dollars. */
  readonly expectancyMicros: number | null;
  /** Expectancy expressed in R, over the trades that had a stop. */
  readonly expectancyR: number | null;
  readonly avgWinMicros: number | null;
  readonly avgLossMicros: number | null;
  readonly largestWinMicros: number | null;
  readonly largestLossMicros: number | null;
  readonly avgHoldMs: number | null;
  readonly avgWinHoldMs: number | null;
  readonly avgLossHoldMs: number | null;
  readonly avgMaeMicros: number | null;
  readonly avgMfeMicros: number | null;
  /** How much of the best excursion was kept, on winners. 1 means all of it. */
  readonly captureRatio: number | null;
  readonly streaks: StreakInfo;
  readonly contracts: number;
  /** Trades that had a stop, so their R is defined. */
  readonly ratedTrades: number;
  readonly avgRMultiple: number | null;
  readonly totalR: number | null;
}

const EMPTY_STREAKS: StreakInfo = {
  longestWins: 0,
  longestLosses: 0,
  currentWins: 0,
  currentLosses: 0,
};

export const EMPTY_STATS: TradeStats = {
  trades: 0,
  wins: 0,
  losses: 0,
  scratches: 0,
  winRate: null,
  grossProfitMicros: 0,
  grossLossMicros: 0,
  netPnlMicros: 0,
  feesMicros: 0,
  profitFactor: null,
  expectancyMicros: null,
  expectancyR: null,
  avgWinMicros: null,
  avgLossMicros: null,
  largestWinMicros: null,
  largestLossMicros: null,
  avgHoldMs: null,
  avgWinHoldMs: null,
  avgLossHoldMs: null,
  avgMaeMicros: null,
  avgMfeMicros: null,
  captureRatio: null,
  streaks: EMPTY_STREAKS,
  contracts: 0,
  ratedTrades: 0,
  avgRMultiple: null,
  totalR: null,
};

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** R for one trade: net result divided by what it risked at entry. */
export function rMultiple(trade: TradeRecord): number | null {
  const risk = trade.initialRiskMicros;
  if (risk === null || risk <= 0) return null;
  return trade.netPnlMicros / risk;
}

export function computeStats(trades: readonly TradeRecord[]): TradeStats {
  if (trades.length === 0) return EMPTY_STATS;

  let wins = 0;
  let losses = 0;
  let scratches = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let net = 0;
  let fees = 0;
  let contracts = 0;

  const winSizes: number[] = [];
  const lossSizes: number[] = [];
  const holds: number[] = [];
  const winHolds: number[] = [];
  const lossHolds: number[] = [];
  const maes: number[] = [];
  const mfes: number[] = [];
  const rs: number[] = [];
  const captures: number[] = [];

  let longestWins = 0;
  let longestLosses = 0;
  let runWins = 0;
  let runLosses = 0;

  // Chronological, because streaks are about sequence.
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime || a.id.localeCompare(b.id));

  for (const trade of ordered) {
    const result = trade.netPnlMicros;
    const hold = Math.max(0, trade.exitTime - trade.entryTime);
    net += result;
    fees += trade.feesMicros;
    contracts += trade.qty;
    holds.push(hold);
    maes.push(trade.maeMicros);
    mfes.push(trade.mfeMicros);

    const r = rMultiple(trade);
    if (r !== null) rs.push(r);

    if (result > 0) {
      wins += 1;
      grossProfit += result;
      winSizes.push(result);
      winHolds.push(hold);
      runWins += 1;
      runLosses = 0;
      longestWins = Math.max(longestWins, runWins);
      // How much of the best excursion the trade actually kept.
      if (trade.mfeMicros > 0) captures.push(Math.min(1, result / trade.mfeMicros));
    } else if (result < 0) {
      losses += 1;
      grossLoss += -result;
      lossSizes.push(-result);
      lossHolds.push(hold);
      runLosses += 1;
      runWins = 0;
      longestLosses = Math.max(longestLosses, runLosses);
    } else {
      // A scratch breaks a streak without starting one: it is neither.
      scratches += 1;
      runWins = 0;
      runLosses = 0;
    }
  }

  const decided = wins + losses;
  const avgWin = mean(winSizes);
  const avgLoss = mean(lossSizes);

  return {
    trades: ordered.length,
    wins,
    losses,
    scratches,
    winRate: decided === 0 ? null : wins / decided,
    grossProfitMicros: grossProfit,
    grossLossMicros: grossLoss,
    netPnlMicros: net,
    feesMicros: fees,
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
    expectancyMicros: net / ordered.length,
    expectancyR: rs.length === 0 ? null : rs.reduce((a, b) => a + b, 0) / rs.length,
    avgWinMicros: avgWin,
    avgLossMicros: avgLoss,
    largestWinMicros: winSizes.length ? Math.max(...winSizes) : null,
    largestLossMicros: lossSizes.length ? Math.max(...lossSizes) : null,
    avgHoldMs: mean(holds),
    avgWinHoldMs: mean(winHolds),
    avgLossHoldMs: mean(lossHolds),
    avgMaeMicros: mean(maes),
    avgMfeMicros: mean(mfes),
    captureRatio: mean(captures),
    streaks: {
      longestWins,
      longestLosses,
      currentWins: runWins,
      currentLosses: runLosses,
    },
    contracts,
    ratedTrades: rs.length,
    avgRMultiple: rs.length === 0 ? null : rs.reduce((a, b) => a + b, 0) / rs.length,
    totalR: rs.length === 0 ? null : rs.reduce((a, b) => a + b, 0),
  };
}

// ---------------------------------------------------------------------------
// The equity curve
// ---------------------------------------------------------------------------

export interface EquityPoint {
  readonly at: number;
  readonly tradeId: string;
  readonly equityMicros: number;
  /** Distance below the running peak at this point, <= 0. */
  readonly drawdownMicros: number;
}

export interface EquityCurve {
  readonly points: readonly EquityPoint[];
  readonly startMicros: number;
  readonly endMicros: number;
  readonly peakMicros: number;
  /** Deepest peak-to-trough fall, as a positive magnitude. */
  readonly maxDrawdownMicros: number;
  readonly maxDrawdownPct: number | null;
}

/**
 * Realized equity after each closed trade.
 *
 * Trade-by-trade rather than mark-to-market: this is the curve a trader can
 * reconcile against their own statement. The intraday excursions of open
 * positions are reported by MAE/MFE instead, where they belong.
 */
export function equityCurve(
  trades: readonly TradeRecord[],
  startingBalanceMicros: number,
): EquityCurve {
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime || a.id.localeCompare(b.id));
  const points: EquityPoint[] = [];

  let equity = startingBalanceMicros;
  let peak = startingBalanceMicros;
  let maxDrawdown = 0;

  for (const trade of ordered) {
    equity += trade.netPnlMicros;
    peak = Math.max(peak, equity);
    const drawdown = equity - peak;
    maxDrawdown = Math.max(maxDrawdown, -drawdown);
    points.push({
      at: trade.exitTime,
      tradeId: trade.id,
      equityMicros: equity,
      drawdownMicros: drawdown,
    });
  }

  return {
    points,
    startMicros: startingBalanceMicros,
    endMicros: equity,
    peakMicros: peak,
    maxDrawdownMicros: maxDrawdown,
    maxDrawdownPct: peak > 0 ? maxDrawdown / peak : null,
  };
}

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------

function bucketFrom(key: string, label: string, trades: readonly TradeRecord[]): Bucket {
  const stats = computeStats(trades);
  return {
    key,
    label,
    trades: stats.trades,
    netPnlMicros: stats.netPnlMicros,
    winRate: stats.winRate,
    expectancyMicros: stats.expectancyMicros,
  };
}

function group(
  trades: readonly TradeRecord[],
  keyOf: (trade: TradeRecord) => string | null,
  labelOf: (key: string) => string,
): Bucket[] {
  const groups = new Map<string, TradeRecord[]>();
  for (const trade of trades) {
    const key = keyOf(trade);
    if (key === null) continue;
    const list = groups.get(key);
    if (list) list.push(trade);
    else groups.set(key, [trade]);
  }
  return [...groups.entries()]
    .map(([key, list]) => bucketFrom(key, labelOf(key), list))
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface Breakdowns {
  readonly bySymbol: readonly Bucket[];
  readonly bySide: readonly Bucket[];
  readonly byHour: readonly Bucket[];
  readonly byWeekday: readonly Bucket[];
  readonly byDate: readonly Bucket[];
}

export function breakdowns(trades: readonly TradeRecord[]): Breakdowns {
  return {
    bySymbol: group(
      trades,
      (t) => t.symbol,
      (key) => key,
    ),
    bySide: group(
      trades,
      (t) => t.side,
      (key) => (key === 'LONG' ? 'Long' : 'Short'),
    ),
    byHour: group(
      trades,
      (t) => (t.hourOfDay === undefined ? null : String(t.hourOfDay).padStart(2, '0')),
      (key) => `${key}:00`,
    ),
    byWeekday: group(
      trades,
      (t) => (t.dayOfWeek === undefined ? null : String(t.dayOfWeek)),
      (key) => WEEKDAYS[Number(key)] ?? key,
    ),
    byDate: group(
      trades,
      (t) => t.tradeDate,
      (key) => key,
    ),
  };
}

/** Net result per trading date, for a calendar. */
export interface DayResult {
  readonly tradeDate: string;
  readonly netPnlMicros: number;
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
}

export function dailyResults(trades: readonly TradeRecord[]): DayResult[] {
  const days = new Map<string, DayResult>();
  for (const trade of trades) {
    const current = days.get(trade.tradeDate) ?? {
      tradeDate: trade.tradeDate,
      netPnlMicros: 0,
      trades: 0,
      wins: 0,
      losses: 0,
    };
    days.set(trade.tradeDate, {
      tradeDate: trade.tradeDate,
      netPnlMicros: current.netPnlMicros + trade.netPnlMicros,
      trades: current.trades + 1,
      wins: current.wins + (trade.netPnlMicros > 0 ? 1 : 0),
      losses: current.losses + (trade.netPnlMicros < 0 ? 1 : 0),
    });
  }
  return [...days.values()].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

/** Everything a journal view needs, computed in one pass over the trades. */
export interface JournalAnalytics {
  readonly stats: TradeStats;
  readonly curve: EquityCurve;
  readonly breakdowns: Breakdowns;
  readonly days: readonly DayResult[];
}

export function analyze(
  trades: readonly TradeRecord[],
  startingBalanceMicros: number,
): JournalAnalytics {
  return {
    stats: computeStats(trades),
    curve: equityCurve(trades, startingBalanceMicros),
    breakdowns: breakdowns(trades),
    days: dailyResults(trades),
  };
}
