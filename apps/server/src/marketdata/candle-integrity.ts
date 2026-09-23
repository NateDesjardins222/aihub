/**
 * Candle integrity checker (D-17/D-18).
 *
 * A reusable audit of a bar SERIES against the invariants a candle chart must
 * never violate, independent of the provider. It separates a DATA error (an
 * OHLC that cannot be right, a duplicate or mis-bucketed timestamp) from a
 * render/time-scale question, by proving the data itself is sound. Point it at
 * any series — a REST history page, a recorded fixture, or a live aggregate —
 * and it reports exactly which bar broke which rule.
 *
 * Pure and dependency-free, so it runs in a unit test and in the audit script.
 */
export interface AuditBar {
  readonly time: number; // ms, the bucket's start
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume?: number;
  /** False for the still-forming last bar; its extremes are not yet final. */
  readonly closed?: boolean;
}

export type CandleViolationKind =
  | 'HIGH_BELOW_BODY' // high < max(open, close)
  | 'LOW_ABOVE_BODY' // low > min(open, close)
  | 'HIGH_BELOW_LOW' // high < low
  | 'NON_FINITE' // a non-finite OHLC value
  | 'NEGATIVE_VOLUME'
  | 'TIME_NOT_INCREASING' // timestamps not strictly increasing
  | 'DUPLICATE_TIME'
  | 'MISALIGNED_BUCKET' // time not on a timeframe boundary
  | 'GAP'; // a missing bucket in a contiguous session run (informational)

export interface CandleViolation {
  readonly kind: CandleViolationKind;
  readonly index: number;
  readonly time: number;
  readonly detail: string;
}

export interface CandleAuditResult {
  readonly bars: number;
  readonly violations: CandleViolation[];
  /** Violations excluding GAP, which is informational (sessions have real gaps). */
  readonly hardViolations: CandleViolation[];
  readonly ok: boolean;
}

export interface CandleAuditOptions {
  /** Milliseconds per bar, to check bucket alignment. */
  readonly barMs?: number;
  /**
   * Report GAP for a missing bucket between two consecutive bars. Off by
   * default: a real market has session gaps (overnight, weekend) that are NOT
   * errors. Turn on only for a run known to be within one contiguous session.
   */
  readonly reportGaps?: boolean;
  /** Alignment epoch; bucket boundaries are measured from here (default 0 = UTC). */
  readonly epochMs?: number;
}

export function auditCandles(bars: readonly AuditBar[], opts: CandleAuditOptions = {}): CandleAuditResult {
  const violations: CandleViolation[] = [];
  const push = (kind: CandleViolationKind, index: number, time: number, detail: string): void => {
    violations.push({ kind, index, time, detail });
  };
  const barMs = opts.barMs && opts.barMs > 0 ? opts.barMs : null;
  const epoch = opts.epochMs ?? 0;

  let previousTime: number | null = null;
  bars.forEach((bar, index) => {
    const { open, high, low, close, time } = bar;

    if (![open, high, low, close, time].every((v) => Number.isFinite(v))) {
      push('NON_FINITE', index, time, `OHLC/time not all finite: ${JSON.stringify(bar)}`);
      return; // the remaining numeric checks would be meaningless
    }
    if (high < low) push('HIGH_BELOW_LOW', index, time, `high ${high} < low ${low}`);
    if (high < Math.max(open, close)) {
      push('HIGH_BELOW_BODY', index, time, `high ${high} < max(open,close) ${Math.max(open, close)}`);
    }
    if (low > Math.min(open, close)) {
      push('LOW_ABOVE_BODY', index, time, `low ${low} > min(open,close) ${Math.min(open, close)}`);
    }
    if (bar.volume !== undefined && bar.volume < 0) {
      push('NEGATIVE_VOLUME', index, time, `volume ${bar.volume} < 0`);
    }
    if (barMs !== null && (time - epoch) % barMs !== 0) {
      push('MISALIGNED_BUCKET', index, time, `time not on a ${barMs}ms boundary`);
    }
    if (previousTime !== null) {
      if (time === previousTime) push('DUPLICATE_TIME', index, time, `duplicate bucket time ${time}`);
      else if (time < previousTime) {
        push('TIME_NOT_INCREASING', index, time, `time ${time} < previous ${previousTime}`);
      } else if (opts.reportGaps && barMs !== null && time - previousTime !== barMs) {
        push('GAP', index, time, `gap: ${(time - previousTime) / barMs} buckets since previous`);
      }
    }
    previousTime = time;
  });

  const hardViolations = violations.filter((v) => v.kind !== 'GAP');
  return { bars: bars.length, violations, hardViolations, ok: hardViolations.length === 0 };
}
