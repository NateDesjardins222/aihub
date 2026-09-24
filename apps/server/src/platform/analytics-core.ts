/**
 * Trader analytics — the metric registry (pure).
 *
 * One explicit definition per metric, computed over authoritative round-trip
 * `trades` and per-day `daily_account_stats`. No DB, no client math. Net P&L
 * always includes fees (trades carry `netPnlMicros` fees-in). A metric that
 * cannot be computed from the data returns null (never a fabricated value):
 * R-multiple only where a stop was set at entry (`initialRiskMicros`), profit
 * factor undefined when there are no losses. See docs/trader-analytics-v1.md.
 */

export interface TradeRow {
  readonly netPnlMicros: number;
  readonly grossPnlMicros: number;
  readonly feesMicros: number;
  readonly side: string; // 'LONG' | 'SHORT' (as the engine writes it)
  readonly qty: number;
  readonly symbol: string;
  readonly entryTimeMs: number;
  readonly exitTimeMs: number;
  readonly tradeDate: string; // YYYY-MM-DD
  readonly initialRiskMicros: number | null;
}

export interface DayRow {
  readonly tradeDate: string;
  readonly realizedPnlMicros: number;
  readonly counted: boolean;
}

const isWin = (t: TradeRow): boolean => t.netPnlMicros > 0;
const isLoss = (t: TradeRow): boolean => t.netPnlMicros < 0;
const isBreakeven = (t: TradeRow): boolean => t.netPnlMicros === 0;
const durationMs = (t: TradeRow): number => Math.max(0, t.exitTimeMs - t.entryTimeMs);
const avg = (nums: number[]): number => (nums.length === 0 ? 0 : Math.round(nums.reduce((a, b) => a + b, 0) / nums.length));

export interface TradeStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  /** win / (win + loss); breakeven excluded from the denominator. Null if none. */
  winRate: number | null;
  lossRate: number | null;
  breakevenRate: number | null;
  netPnlMicros: number;
  grossProfitMicros: number;
  grossLossMicros: number; // negative or 0
  feesMicros: number;
  averageTradeMicros: number;
  averageWinMicros: number;
  averageLossMicros: number; // negative or 0
  largestWinMicros: number;
  largestLossMicros: number;
  /** grossProfit / |grossLoss|. Null when there are no losses (undefined). */
  profitFactor: number | null;
  /** net / totalTrades (money expectancy per trade). */
  expectancyMicros: number;
  averageWinnerDurationMs: number;
  averageLoserDurationMs: number;
  averageTradeDurationMs: number;
  /** R stats over ONLY trades with a stop at entry; null when none qualify. */
  averageRMultiple: number | null;
  rSampleSize: number;
}

export function computeTradeStats(trades: readonly TradeRow[]): TradeStats {
  const wins = trades.filter(isWin);
  const losses = trades.filter(isLoss);
  const breakevens = trades.filter(isBreakeven);
  const decided = wins.length + losses.length;

  const grossProfit = wins.reduce((a, t) => a + t.netPnlMicros, 0);
  const grossLoss = losses.reduce((a, t) => a + t.netPnlMicros, 0); // ≤ 0
  const net = trades.reduce((a, t) => a + t.netPnlMicros, 0);
  const fees = trades.reduce((a, t) => a + t.feesMicros, 0);

  const withR = trades.filter((t) => t.initialRiskMicros != null && t.initialRiskMicros > 0);
  const rValues = withR.map((t) => t.netPnlMicros / (t.initialRiskMicros as number));

  return {
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    breakevenTrades: breakevens.length,
    winRate: decided === 0 ? null : wins.length / decided,
    lossRate: decided === 0 ? null : losses.length / decided,
    breakevenRate: trades.length === 0 ? null : breakevens.length / trades.length,
    netPnlMicros: net,
    grossProfitMicros: grossProfit,
    grossLossMicros: grossLoss,
    feesMicros: fees,
    averageTradeMicros: avg(trades.map((t) => t.netPnlMicros)),
    averageWinMicros: avg(wins.map((t) => t.netPnlMicros)),
    averageLossMicros: avg(losses.map((t) => t.netPnlMicros)),
    largestWinMicros: wins.length === 0 ? 0 : Math.max(...wins.map((t) => t.netPnlMicros)),
    largestLossMicros: losses.length === 0 ? 0 : Math.min(...losses.map((t) => t.netPnlMicros)),
    profitFactor: grossLoss === 0 ? null : grossProfit / Math.abs(grossLoss),
    expectancyMicros: trades.length === 0 ? 0 : Math.round(net / trades.length),
    averageWinnerDurationMs: avg(wins.map(durationMs)),
    averageLoserDurationMs: avg(losses.map(durationMs)),
    averageTradeDurationMs: avg(trades.map(durationMs)),
    averageRMultiple: rValues.length === 0 ? null : rValues.reduce((a, b) => a + b, 0) / rValues.length,
    rSampleSize: rValues.length,
  };
}

export interface Streaks {
  currentStreak: number; // + winning, - losing, 0 none
  bestWinStreak: number;
  worstLossStreak: number;
}

/** Streaks over trades in chronological (exit-time ascending) order. */
export function computeStreaks(tradesChrono: readonly TradeRow[]): Streaks {
  let cur = 0;
  let best = 0;
  let worst = 0;
  for (const t of tradesChrono) {
    if (isWin(t)) cur = cur > 0 ? cur + 1 : 1;
    else if (isLoss(t)) cur = cur < 0 ? cur - 1 : -1;
    else cur = 0;
    if (cur > best) best = cur;
    if (cur < worst) worst = cur;
  }
  return { currentStreak: cur, bestWinStreak: best, worstLossStreak: worst };
}

export interface DayStats {
  totalTradingDays: number;
  profitableDays: number;
  losingDays: number;
  breakevenDays: number;
  percentProfitableDays: number | null;
  bestDayMicros: number;
  worstDayMicros: number;
  averageDailyPnlMicros: number;
}

export function computeDayStats(days: readonly DayRow[]): DayStats {
  const counted = days.filter((d) => d.counted);
  const profitable = counted.filter((d) => d.realizedPnlMicros > 0);
  const losing = counted.filter((d) => d.realizedPnlMicros < 0);
  const breakeven = counted.filter((d) => d.realizedPnlMicros === 0);
  return {
    totalTradingDays: counted.length,
    profitableDays: profitable.length,
    losingDays: losing.length,
    breakevenDays: breakeven.length,
    percentProfitableDays: counted.length === 0 ? null : profitable.length / counted.length,
    bestDayMicros: counted.length === 0 ? 0 : Math.max(...counted.map((d) => d.realizedPnlMicros)),
    worstDayMicros: counted.length === 0 ? 0 : Math.min(...counted.map((d) => d.realizedPnlMicros)),
    averageDailyPnlMicros: avg(counted.map((d) => d.realizedPnlMicros)),
  };
}

export interface EquityPoint {
  readonly tExitMs: number;
  /** Cumulative trading-performance equity (Σ net P&L), starting at `base`. */
  readonly equityMicros: number;
  /** Peak-to-here drawdown (≥ 0). */
  readonly drawdownMicros: number;
}

export interface EquityCurve {
  points: EquityPoint[];
  maxDrawdownMicros: number;
  finalEquityMicros: number;
}

/**
 * The TRADING-PERFORMANCE equity curve: cumulative net P&L over trades, starting
 * at `baseMicros` (the starting balance for display, or 0). A payout debit is
 * NOT a trade and never appears here; a reset partitions curves by lifecycle (the
 * caller passes one lifecycle's trades). Drawdown is derived from this curve, so
 * a withdrawal never shows as drawdown.
 */
export function computeEquityCurve(tradesChrono: readonly TradeRow[], baseMicros = 0): EquityCurve {
  let equity = baseMicros;
  let peak = baseMicros;
  let maxDd = 0;
  const points: EquityPoint[] = [];
  for (const t of tradesChrono) {
    equity += t.netPnlMicros;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    points.push({ tExitMs: t.exitTimeMs, equityMicros: equity, drawdownMicros: dd });
  }
  return { points, maxDrawdownMicros: maxDd, finalEquityMicros: equity };
}

/** Downsample a curve to at most `max` points (keeps first/last, evenly spaced). */
export function downsample<T>(points: readonly T[], max = 500): T[] {
  if (points.length <= max) return [...points];
  const step = points.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) out.push(points[Math.floor(i * step)]!);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]!);
  return out;
}

export interface Breakdown {
  key: string;
  trades: number;
  netPnlMicros: number;
  winRate: number | null;
}

function breakdownBy(trades: readonly TradeRow[], keyOf: (t: TradeRow) => string): Breakdown[] {
  const map = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const k = keyOf(t);
    (map.get(k) ?? map.set(k, []).get(k)!).push(t);
  }
  return [...map.entries()]
    .map(([key, rows]) => {
      const s = computeTradeStats(rows);
      return { key, trades: rows.length, netPnlMicros: s.netPnlMicros, winRate: s.winRate };
    })
    .sort((a, b) => b.netPnlMicros - a.netPnlMicros);
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface Breakdowns {
  byInstrument: Breakdown[];
  bySide: Breakdown[];
  byDayOfWeek: Breakdown[];
  byDuration: Breakdown[];
}

export function computeBreakdowns(trades: readonly TradeRow[]): Breakdowns {
  const durationBucket = (t: TradeRow): string => {
    const m = durationMs(t) / 60_000;
    if (m < 1) return '<1m';
    if (m < 5) return '1–5m';
    if (m < 30) return '5–30m';
    if (m < 120) return '30m–2h';
    return '>2h';
  };
  return {
    byInstrument: breakdownBy(trades, (t) => t.symbol),
    bySide: breakdownBy(trades, (t) => (t.side.toUpperCase().startsWith('S') ? 'SHORT' : 'LONG')),
    byDayOfWeek: breakdownBy(trades, (t) => DOW[new Date(t.exitTimeMs).getUTCDay()] ?? '?'),
    byDuration: breakdownBy(trades, durationBucket),
  };
}

/**
 * Payout return multiple for a completed funded account:
 * total TRADER SHARE paid / original account purchase cost. Deterministic.
 * Null when the original cost is unknown or zero (cannot divide).
 */
export function payoutReturnMultiple(
  traderShareTotalMicros: number,
  originalCostMicros: number | null,
): number | null {
  if (!originalCostMicros || originalCostMicros <= 0) return null;
  return traderShareTotalMicros / originalCostMicros;
}

/** The full metric registry over one lifecycle's data. */
export interface AnalyticsBundle {
  trades: TradeStats;
  streaks: Streaks;
  days: DayStats;
  equity: EquityCurve;
  breakdowns: Breakdowns;
}

export function computeAnalytics(
  tradesChrono: readonly TradeRow[],
  days: readonly DayRow[],
  baseMicros = 0,
): AnalyticsBundle {
  return {
    trades: computeTradeStats(tradesChrono),
    streaks: computeStreaks(tradesChrono),
    days: computeDayStats(days),
    equity: computeEquityCurve(tradesChrono, baseMicros),
    breakdowns: computeBreakdowns(tradesChrono),
  };
}
