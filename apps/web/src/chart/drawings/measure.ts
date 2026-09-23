/**
 * Measure tool arithmetic (D-05).
 *
 * A professional measure communicates more than a price delta: the price
 * change, its size in points and ticks, the percentage move, the dollar value
 * per contract, the number of bars spanned, and the elapsed wall-clock time.
 * Pure and framework-free so every figure is unit-testable; paint.ts renders
 * what this returns.
 */
export interface MeasureAnchor {
  readonly time: number; // ms
  readonly price: number;
}

export interface MeasureStats {
  /** Signed price change (to − from), in price units ("points" for futures). */
  readonly priceDelta: number;
  /** The move in ticks (signed), or null when the tick size is unknown. */
  readonly ticks: number | null;
  /** Percentage move relative to the starting price (signed), or null if from=0. */
  readonly percent: number | null;
  /** Dollar value of the move for ONE contract, in micros, or null if unknown. */
  readonly valueMicros: number | null;
  /** Whole bars spanned, or null when the bar interval is unknown. */
  readonly bars: number | null;
  /** Elapsed time between the anchors, in milliseconds (always ≥ 0). */
  readonly elapsedMs: number;
  /** True when the move is up (to ≥ from). */
  readonly up: boolean;
}

export function measureStats(
  from: MeasureAnchor,
  to: MeasureAnchor,
  opts: { tickSize?: number; tickValueMicros?: number; barMs?: number } = {},
): MeasureStats {
  const priceDelta = to.price - from.price;
  const tickSize = opts.tickSize && opts.tickSize > 0 ? opts.tickSize : null;
  const ticks = tickSize === null ? null : Math.round(priceDelta / tickSize);
  const percent = from.price === 0 ? null : (priceDelta / Math.abs(from.price)) * 100;
  const valueMicros =
    ticks === null || !opts.tickValueMicros ? null : Math.round(ticks * opts.tickValueMicros);
  const elapsedMs = Math.abs(to.time - from.time);
  const bars = opts.barMs && opts.barMs > 0 ? Math.round(elapsedMs / opts.barMs) : null;
  return { priceDelta, ticks, percent, valueMicros, bars, elapsedMs, up: priceDelta >= 0 };
}

/** Human-readable elapsed time: "45m", "2h 15m", "3d 4h". */
export function formatElapsed(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

/** A timeframe label ("1m", "5m", "1h", "1D", …) to milliseconds per bar. */
export function timeframeMs(timeframe: string): number | null {
  const match = /^(\d+)\s*([mhdwMy]|min|hr)?$/i.exec(timeframe.trim());
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (match[2] ?? 'm').toLowerCase();
  const perUnit: Record<string, number> = {
    m: 60_000,
    min: 60_000,
    h: 3_600_000,
    hr: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  // Uppercase D/W/M/Y are handled case-insensitively above except month/year,
  // which are approximate; a measure's bar count over months is coarse anyway.
  if (unit === 'y') return 365 * 86_400_000 * n;
  const base = perUnit[unit];
  return base ? base * n : null;
}

/** The rows a measure readout shows, formatted. Price fields need a precision. */
export function measureReadoutLines(
  stats: MeasureStats,
  pricePrecision: number,
  formatMoneyMicros: (micros: number) => string,
): string[] {
  const sign = stats.priceDelta >= 0 ? '+' : '';
  const lines: string[] = [];
  const priceLine = `${sign}${stats.priceDelta.toFixed(pricePrecision)}`;
  lines.push(
    stats.ticks === null ? priceLine : `${priceLine}  (${sign}${stats.ticks} ticks)`,
  );
  if (stats.percent !== null) lines.push(`${sign}${stats.percent.toFixed(2)}%`);
  if (stats.valueMicros !== null) lines.push(`${formatMoneyMicros(stats.valueMicros)}/contract`);
  const time = formatElapsed(stats.elapsedMs);
  lines.push(stats.bars === null ? time : `${stats.bars} bars · ${time}`);
  return lines;
}
