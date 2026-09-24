/**
 * Trader analytics service — loads a single account's authoritative round-trip
 * trades and per-day stats in bounded, indexed queries and computes the metric
 * registry (`analytics-core.ts`). No N+1, no client math; ownership is enforced
 * by the caller (the portal route). Filters: date range, instrument, side.
 */
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts, dailyAccountStats, trades } from '../db/schema.js';
import {
  computeAnalytics,
  downsample,
  type AnalyticsBundle,
  type DayRow,
  type TradeRow,
} from './analytics-core.js';

export interface AnalyticsFilter {
  fromDate?: string | null; // YYYY-MM-DD inclusive
  toDate?: string | null; // YYYY-MM-DD inclusive
  instrument?: string | null; // symbol root
  side?: 'LONG' | 'SHORT' | null;
}

export interface AccountAnalytics extends AnalyticsBundle {
  accountId: string;
  startingBalanceMicros: number;
  currentBalanceMicros: number;
  highWaterMarkMicros: number;
  drawdownFloorMicros: number;
  /** current drawdown = HWM − balance, never negative. */
  currentDrawdownMicros: number;
  /** MLL headroom = balance − drawdown floor. */
  mllHeadroomMicros: number;
  generatedAt: number;
}

export async function accountAnalytics(
  db: Database,
  accountId: string,
  filter: AnalyticsFilter = {},
): Promise<AccountAnalytics | null> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) return null;

  const conds = [eq(trades.accountId, accountId)];
  if (filter.fromDate) conds.push(gte(trades.tradeDate, filter.fromDate));
  if (filter.toDate) conds.push(lte(trades.tradeDate, filter.toDate));
  if (filter.instrument) conds.push(eq(trades.symbol, filter.instrument));
  if (filter.side) conds.push(eq(trades.side, filter.side));

  const rows = await db
    .select()
    .from(trades)
    .where(and(...conds))
    .orderBy(asc(trades.exitTime));

  const tradeRows: TradeRow[] = rows.map((r) => ({
    netPnlMicros: r.netPnlMicros,
    grossPnlMicros: r.grossPnlMicros,
    feesMicros: r.feesMicros,
    side: r.side,
    qty: r.qty,
    symbol: r.symbol,
    entryTimeMs: r.entryTime.getTime(),
    exitTimeMs: r.exitTime.getTime(),
    tradeDate: r.tradeDate,
    initialRiskMicros: r.initialRiskMicros ?? null,
  }));

  const dayConds = [eq(dailyAccountStats.accountId, accountId)];
  if (filter.fromDate) dayConds.push(gte(dailyAccountStats.tradeDate, filter.fromDate));
  if (filter.toDate) dayConds.push(lte(dailyAccountStats.tradeDate, filter.toDate));
  const dayRowsRaw = await db
    .select()
    .from(dailyAccountStats)
    .where(and(...dayConds))
    .orderBy(asc(dailyAccountStats.tradeDate));
  const dayRows: DayRow[] = dayRowsRaw.map((d) => ({
    tradeDate: d.tradeDate,
    realizedPnlMicros: d.realizedPnlMicros,
    counted: d.counted,
  }));

  const bundle = computeAnalytics(tradeRows, dayRows, account.startingBalanceMicros);
  // Downsample the equity curve for transport on long histories.
  bundle.equity.points = downsample(bundle.equity.points, 500);

  const currentDrawdown = Math.max(0, account.highWaterMarkMicros - account.balanceMicros);
  return {
    ...bundle,
    accountId,
    startingBalanceMicros: account.startingBalanceMicros,
    currentBalanceMicros: account.balanceMicros,
    highWaterMarkMicros: account.highWaterMarkMicros,
    drawdownFloorMicros: account.drawdownFloorMicros,
    currentDrawdownMicros: currentDrawdown,
    mllHeadroomMicros: account.balanceMicros - account.drawdownFloorMicros,
    generatedAt: Date.now(),
  };
}
