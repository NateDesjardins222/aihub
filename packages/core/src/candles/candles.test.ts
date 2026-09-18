import { describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { requireInstrument } from '@atlas/instruments';
import type { NormalizedBar } from '@atlas/contracts';
import { bucketEnd, bucketStart, isDivisible, secondsToBucketClose } from './timeframe.js';
import { BarSeries } from './series.js';
import { foldBars, foldBucket } from './fold.js';
import { CandleAggregator } from './aggregator.js';
import { findMarketGaps, hasTailGap } from './gaps.js';

const NQ = requireInstrument('NQ');
const GC = requireInstrument('GC');

function ct(iso: string): number {
  const dt = DateTime.fromISO(iso, { zone: 'America/Chicago' });
  if (!dt.isValid) throw new Error(`bad instant ${iso}: ${dt.invalidReason}`);
  return dt.toMillis();
}

function bar(time: number, o: number, h: number, l: number, c: number, v = 10, closed = true): NormalizedBar {
  return { symbol: 'NQ', time, open: o, high: h, low: l, close: c, volume: v, closed };
}

describe('bucket alignment', () => {
  it('aligns minute buckets to the minute', () => {
    const t = ct('2026-09-15T09:30:47');
    expect(bucketStart(NQ, t, '1m')).toBe(ct('2026-09-15T09:30:00'));
  });

  it('aligns 3m and 5m buckets consistently', () => {
    expect(bucketStart(NQ, ct('2026-09-15T09:34:30'), '3m')).toBe(ct('2026-09-15T09:33:00'));
    expect(bucketStart(NQ, ct('2026-09-15T09:34:30'), '5m')).toBe(ct('2026-09-15T09:30:00'));
    expect(bucketStart(NQ, ct('2026-09-15T09:44:59'), '15m')).toBe(ct('2026-09-15T09:30:00'));
    expect(bucketStart(NQ, ct('2026-09-15T09:44:59'), '30m')).toBe(ct('2026-09-15T09:30:00'));
  });

  /**
   * The behaviour that distinguishes a futures chart from an equities chart:
   * 4h buckets start at the 17:00 CT session open, not at UTC midnight.
   */
  it('anchors 4h buckets to the session open, not to UTC', () => {
    expect(bucketStart(NQ, ct('2026-09-14T17:00:00'), '4h')).toBe(ct('2026-09-14T17:00:00'));
    expect(bucketStart(NQ, ct('2026-09-14T20:59:59'), '4h')).toBe(ct('2026-09-14T17:00:00'));
    expect(bucketStart(NQ, ct('2026-09-14T21:00:00'), '4h')).toBe(ct('2026-09-14T21:00:00'));
    expect(bucketStart(NQ, ct('2026-09-15T09:30:00'), '4h')).toBe(ct('2026-09-15T09:00:00'));
  });

  it('gives a 1h bucket the same answer under session and clock alignment', () => {
    // The session opens on the hour, so these must not diverge.
    expect(bucketStart(NQ, ct('2026-09-15T09:30:00'), '1h')).toBe(ct('2026-09-15T09:00:00'));
    expect(bucketStart(NQ, ct('2026-09-15T02:45:00'), '1h')).toBe(ct('2026-09-15T02:00:00'));
  });

  it('makes a daily bar one full overnight session', () => {
    // Everything from Monday 17:00 through Tuesday 16:00 is Tuesday's daily bar.
    const evening = bucketStart(NQ, ct('2026-09-14T18:30:00'), '1D');
    const morning = bucketStart(NQ, ct('2026-09-15T09:30:00'), '1D');
    expect(evening).toBe(morning);
    expect(evening).toBe(ct('2026-09-14T17:00:00'));
  });

  it('starts a new daily bar at the next session open', () => {
    const tue = bucketStart(NQ, ct('2026-09-15T09:30:00'), '1D');
    const wed = bucketStart(NQ, ct('2026-09-16T09:30:00'), '1D');
    expect(wed).toBeGreaterThan(tue);
    expect(wed).toBe(ct('2026-09-15T17:00:00'));
  });

  it('anchors weekly bars to the Sunday session open', () => {
    const mon = bucketStart(NQ, ct('2026-09-15T09:30:00'), '1W');
    const fri = bucketStart(NQ, ct('2026-09-18T09:30:00'), '1W');
    expect(mon).toBe(fri);
    expect(mon).toBe(ct('2026-09-13T17:00:00')); // Sunday evening
  });

  it('computes the exclusive bucket end', () => {
    const t = ct('2026-09-15T09:30:00');
    expect(bucketEnd(NQ, t, '5m')).toBe(ct('2026-09-15T09:35:00'));
    expect(bucketEnd(NQ, t, '1D')).toBe(ct('2026-09-15T17:00:00'));
  });

  it('counts down to the bar close', () => {
    const now = ct('2026-09-15T09:31:20');
    expect(secondsToBucketClose(NQ, now, '1m')).toBe(40);
    expect(secondsToBucketClose(NQ, now, '5m')).toBe(3 * 60 + 40);
  });

  it('knows which timeframes fold losslessly into which', () => {
    expect(isDivisible('1m', '5m')).toBe(true);
    expect(isDivisible('1m', '3m')).toBe(true);
    expect(isDivisible('5m', '15m')).toBe(true);
    expect(isDivisible('5m', '3m')).toBe(false);
    expect(isDivisible('1h', '4h')).toBe(true);
  });

  it('uses each instrument’s own session, not a shared one', () => {
    // Gold has no 15:15 equity halt, so its session bounds differ from NQ's.
    expect(bucketStart(GC, ct('2026-09-15T15:20:00'), '1h')).toBe(ct('2026-09-15T15:00:00'));
  });
});

describe('bar series de-duplication', () => {
  it('revises rather than appends when the same bucket arrives twice', () => {
    const series = new BarSeries('NQ');
    const t = ct('2026-09-15T09:30:00');
    series.upsert(bar(t, 100, 101, 99, 100, 5, false));
    series.upsert(bar(t, 100, 103, 99, 102, 9, false));
    expect(series.size).toBe(1);
    expect(series.last()!.high).toBe(103);
    expect(series.last()!.volume).toBe(9);
  });

  it('reports no change when an identical bar is replayed', () => {
    const series = new BarSeries('NQ');
    const t = ct('2026-09-15T09:30:00');
    series.upsert(bar(t, 100, 101, 99, 100));
    const second = series.upsert(bar(t, 100, 101, 99, 100));
    expect(second.changed).toBe(false);
    expect(second.created).toBe(false);
  });

  it('does not let a streaming bar re-open a bucket history already closed', () => {
    const series = new BarSeries('NQ');
    const t = ct('2026-09-15T09:30:00');
    series.upsert(bar(t, 100, 101, 99, 100, 20, true), 'HISTORY');
    const result = series.upsert(bar(t, 100, 105, 90, 95, 3, false), 'STREAM');
    expect(result.changed).toBe(false);
    expect(series.get(t)!.high).toBe(101);
    expect(series.get(t)!.closed).toBe(true);
  });

  it('keeps bars ordered regardless of arrival order', () => {
    const series = new BarSeries('NQ');
    const base = ct('2026-09-15T09:30:00');
    series.upsert(bar(base + 120_000, 3, 3, 3, 3));
    series.upsert(bar(base, 1, 1, 1, 1));
    series.upsert(bar(base + 60_000, 2, 2, 2, 2));
    expect(series.all().map((b) => b.open)).toEqual([1, 2, 3]);
  });

  it('returns the newest N bars before a cursor, for pagination', () => {
    const series = new BarSeries('NQ');
    const base = ct('2026-09-15T09:30:00');
    for (let i = 0; i < 10; i += 1) series.upsert(bar(base + i * 60_000, i, i, i, i));
    expect(series.tail(3).map((b) => b.open)).toEqual([7, 8, 9]);
    expect(series.tail(3, base + 5 * 60_000).map((b) => b.open)).toEqual([2, 3, 4]);
  });

  it('trims to a bound without disturbing order', () => {
    const series = new BarSeries('NQ');
    const base = ct('2026-09-15T09:30:00');
    for (let i = 0; i < 100; i += 1) series.upsert(bar(base + i * 60_000, i, i, i, i));
    expect(series.trimTo(10)).toBe(90);
    expect(series.size).toBe(10);
    expect(series.first()!.open).toBe(90);
    expect(series.last()!.open).toBe(99);
  });
});

describe('folding', () => {
  it('takes first open, max high, min low, last close and summed volume', () => {
    const t = ct('2026-09-15T09:30:00');
    const folded = foldBucket(
      [
        bar(t, 100, 104, 99, 103, 5),
        bar(t + 60_000, 103, 110, 102, 108, 7),
        bar(t + 120_000, 108, 109, 95, 97, 3),
      ],
      t,
    );
    expect(folded).toEqual({
      symbol: 'NQ',
      time: t,
      open: 100,
      high: 110,
      low: 95,
      close: 97,
      volume: 15,
      closed: true,
    });
  });

  it('leaves a bucket unsettled while any constituent bar is still forming', () => {
    const t = ct('2026-09-15T09:30:00');
    const folded = foldBucket([bar(t, 1, 1, 1, 1, 1, true), bar(t + 60_000, 1, 1, 1, 1, 1, false)], t);
    expect(folded!.closed).toBe(false);
  });

  it('folds a minute series into 5m buckets', () => {
    const start = ct('2026-09-15T09:30:00');
    const minutes: NormalizedBar[] = [];
    for (let i = 0; i < 15; i += 1) {
      minutes.push(bar(start + i * 60_000, 100 + i, 100 + i + 2, 100 + i - 2, 100 + i, 1));
    }
    const folded = foldBars(NQ, minutes, '5m');
    expect(folded).toHaveLength(3);
    expect(folded[0]!.time).toBe(start);
    expect(folded[0]!.open).toBe(100);
    expect(folded[0]!.close).toBe(104);
    expect(folded[0]!.volume).toBe(5);
    expect(folded[1]!.time).toBe(start + 5 * 60_000);
    expect(folded[2]!.close).toBe(114);
  });

  it('never emits two candles for the same bucket', () => {
    const start = ct('2026-09-15T09:30:00');
    const minutes: NormalizedBar[] = [];
    for (let i = 0; i < 240; i += 1) minutes.push(bar(start + i * 60_000, 1, 1, 1, 1, 1));
    for (const tf of ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D'] as const) {
      const folded = foldBars(NQ, minutes, tf);
      const times = folded.map((b) => b.time);
      expect(new Set(times).size, `${tf} produced duplicate buckets`).toBe(times.length);
      // And strictly ascending.
      for (let i = 1; i < times.length; i += 1) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    }
  });

  it('splits a fold across the session boundary', () => {
    // 16:00 CT close, 17:00 CT reopen: the hour-long gap must not merge bars.
    const bars = [
      bar(ct('2026-09-15T15:58:00'), 1, 1, 1, 1),
      bar(ct('2026-09-15T15:59:00'), 2, 2, 2, 2),
      bar(ct('2026-09-15T17:00:00'), 3, 3, 3, 3),
      bar(ct('2026-09-15T17:01:00'), 4, 4, 4, 4),
    ];
    const folded = foldBars(NQ, bars, '1D');
    expect(folded).toHaveLength(2);
    expect(folded[0]!.close).toBe(2);
    expect(folded[1]!.open).toBe(3);
  });
});

describe('candle aggregator', () => {
  function makeAggregator(): CandleAggregator {
    return new CandleAggregator(NQ, { baseTimeframe: '1m' });
  }

  it('seeds history then streams without creating a duplicate candle', () => {
    const agg = makeAggregator();
    const start = ct('2026-09-15T09:30:00');
    const history: NormalizedBar[] = [];
    for (let i = 0; i < 10; i += 1) history.push(bar(start + i * 60_000, 100, 101, 99, 100, 5));
    agg.seed(history);
    expect(agg.fineBarCount).toBe(10);

    // The stream re-sends the last two history bars, as a reconnect would.
    agg.ingestBar(bar(start + 8 * 60_000, 100, 101, 99, 100, 5));
    agg.ingestBar(bar(start + 9 * 60_000, 100, 101, 99, 100, 5));
    agg.ingestBar(bar(start + 10 * 60_000, 100, 102, 99, 101, 2, false));

    expect(agg.fineBarCount).toBe(11);
    const series = agg.series('1m');
    expect(new Set(series.map((b) => b.time)).size).toBe(series.length);
  });

  it('notifies subscribers of the forming bar and flags the roll', () => {
    const agg = makeAggregator();
    const updates: Array<{ time: number; rolled: boolean; closed: boolean }> = [];
    agg.subscribe('5m', (u) => updates.push({ time: u.bar.time, rolled: u.rolled, closed: u.bar.closed }));

    const start = ct('2026-09-15T09:30:00');
    for (let i = 0; i < 6; i += 1) {
      agg.ingestBar(bar(start + i * 60_000, 100, 101, 99, 100, 1, i < 5));
    }

    expect(updates.length).toBe(6);
    // First five minutes are one 5m bucket; the sixth opens the next one.
    expect(updates.slice(0, 5).every((u) => u.time === start)).toBe(true);
    expect(updates[4]!.rolled).toBe(false);
    expect(updates[5]!.time).toBe(start + 5 * 60_000);
    expect(updates[5]!.rolled).toBe(true);
  });

  it('ignores an out-of-order duplicate that carries no new information', () => {
    const agg = makeAggregator();
    const t = ct('2026-09-15T09:30:00');
    const listener = vi.fn();
    agg.subscribe('1m', listener);

    expect(agg.ingestBar(bar(t, 100, 101, 99, 100, 5, false))).toBe(true);
    expect(agg.ingestBar(bar(t, 100, 101, 99, 100, 5, false))).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('builds candles from trade prints as well as from bars', () => {
    const agg = makeAggregator();
    const t = ct('2026-09-15T09:30:10');
    agg.ingestTrade({ symbol: 'NQ', exchangeTs: t, price: 100, size: 2, seq: 1, aggressor: 'BUY' });
    agg.ingestTrade({ symbol: 'NQ', exchangeTs: t + 5_000, price: 104, size: 3, seq: 2, aggressor: 'BUY' });
    agg.ingestTrade({ symbol: 'NQ', exchangeTs: t + 9_000, price: 98, size: 1, seq: 3, aggressor: 'SELL' });

    const latest = agg.latest('1m')!;
    expect(latest.time).toBe(ct('2026-09-15T09:30:00'));
    expect(latest.open).toBe(100);
    expect(latest.high).toBe(104);
    expect(latest.low).toBe(98);
    expect(latest.close).toBe(98);
    expect(latest.volume).toBe(6);
    expect(latest.closed).toBe(false);
  });

  it('settles a stale forming bar once its bucket has passed', () => {
    const agg = makeAggregator();
    const t = ct('2026-09-15T09:30:00');
    agg.ingestBar(bar(t, 100, 101, 99, 100, 5, false));
    const settled = agg.settleBefore(ct('2026-09-15T09:35:00'));
    expect(settled).toHaveLength(1);
    expect(agg.series('1m')[0]!.closed).toBe(true);
  });

  it('derives every required timeframe from one minute series', () => {
    const agg = makeAggregator();
    const start = ct('2026-09-14T17:00:00');
    for (let i = 0; i < 600; i += 1) {
      agg.ingestBar(bar(start + i * 60_000, 100 + i, 100 + i, 100 + i, 100 + i, 1));
    }
    for (const tf of ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D'] as const) {
      const series = agg.series(tf);
      expect(series.length, `${tf} empty`).toBeGreaterThan(0);
      expect(new Set(series.map((b) => b.time)).size).toBe(series.length);
      const totalVolume = series.reduce((sum, b) => sum + b.volume, 0);
      expect(totalVolume, `${tf} volume must be conserved`).toBe(600);
    }
  });
});

describe('forming-bucket reconciliation', () => {
  const NQ_SPEC = requireInstrument('NQ');

  it('never shrinks the range of a bucket that is still forming', () => {
    // A vendor snapshot can arrive with a narrower range than we already saw.
    // Accepting it would erase a high that genuinely traded.
    const agg = new CandleAggregator(NQ_SPEC, { baseTimeframe: '1m' });
    const t = ct('2026-09-15T09:30:00');
    agg.ingestBar(bar(t, 100, 110, 90, 105, 50, false));
    agg.ingestBar(bar(t, 100, 104, 99, 103, 40, false));

    const live = agg.series('1m')[0]!;
    expect(live.high).toBe(110);
    expect(live.low).toBe(90);
    expect(live.volume).toBe(50);
    expect(live.close).toBe(103);
    expect(live.open).toBe(100);
  });

  it('accepts a settled bar verbatim, including a corrected range', () => {
    const agg = new CandleAggregator(NQ_SPEC, { baseTimeframe: '1m' });
    const t = ct('2026-09-15T09:30:00');
    agg.ingestBar(bar(t, 100, 110, 90, 105, 50, false));
    agg.ingestBar(bar(t, 100, 108, 95, 106, 61, true));

    const settled = agg.series('1m')[0]!;
    expect(settled.closed).toBe(true);
    expect(settled.high).toBe(108);
    expect(settled.volume).toBe(61);
  });

  it('updates the forming close from a price print without inventing volume', () => {
    const agg = new CandleAggregator(NQ_SPEC, { baseTimeframe: '1m' });
    const t = ct('2026-09-15T09:30:00');
    agg.ingestBar(bar(t, 100, 101, 99, 100, 42, false));
    agg.ingestPrice(103, t + 31_000);

    const live = agg.series('1m')[0]!;
    expect(live.close).toBe(103);
    expect(live.high).toBe(103);
    expect(live.volume).toBe(42); // unchanged: the print carried no size
    expect(live.closed).toBe(false);
  });

  it('refuses to reopen a bucket the feed has settled', () => {
    const agg = new CandleAggregator(NQ_SPEC, { baseTimeframe: '1m' });
    const t = ct('2026-09-15T09:30:00');
    agg.ingestBar(bar(t, 100, 101, 99, 100, 42, true));
    expect(agg.ingestPrice(150, t + 31_000)).toBe(false);
    expect(agg.series('1m')[0]!.high).toBe(101);
  });

  it('opens a bar from a print when no bar exists yet', () => {
    const agg = new CandleAggregator(NQ_SPEC, { baseTimeframe: '1m' });
    const t = ct('2026-09-15T09:30:20');
    expect(agg.ingestPrice(99.5, t)).toBe(true);
    const live = agg.series('1m')[0]!;
    expect(live.open).toBe(99.5);
    expect(live.close).toBe(99.5);
    expect(live.volume).toBe(0);
  });
});

describe('price prints beat republished bars inside a forming bucket', () => {
  const NQ_SPEC = requireInstrument('NQ');
  const T = ct('2026-09-15T09:30:00');

  it('does not let a republished bar roll the live close backwards', () => {
    // A delayed feed republishes its bar array less often than its last price.
    // Without print precedence the candle's close would oscillate between the
    // current price and a stale one on every poll.
    const agg = new CandleAggregator(NQ_SPEC, { baseTimeframe: '1m' });

    agg.ingestPrice(100, T + 5_000);
    agg.ingestBar(bar(T, 100, 100, 100, 98, 10, false)); // bar lags: close 98
    expect(agg.series('1m')[0]!.close).toBe(100);

    agg.ingestPrice(104, T + 20_000);
    agg.ingestBar(bar(T, 100, 101, 99, 99, 20, false)); // lags again
    const live = agg.series('1m')[0]!;
    expect(live.close).toBe(104);
    expect(live.high).toBe(104); // the print extends the range too
    expect(live.low).toBe(99);
    expect(live.volume).toBe(20); // volume still comes from the feed
  });

  it('hands the close back to the feed once the bucket settles', () => {
    const agg = new CandleAggregator(NQ_SPEC, { baseTimeframe: '1m' });
    agg.ingestPrice(104, T + 20_000);
    agg.ingestBar(bar(T, 100, 106, 97, 101, 55, true)); // settled

    const settled = agg.series('1m')[0]!;
    expect(settled.closed).toBe(true);
    expect(settled.close).toBe(101); // the exchange's own close, not our print
    expect(settled.high).toBe(106);
    expect(settled.volume).toBe(55);
  });

  it('keeps prints scoped to their own bucket', () => {
    const agg = new CandleAggregator(NQ_SPEC, { baseTimeframe: '1m' });
    agg.ingestPrice(104, T + 20_000);
    agg.ingestBar(bar(T, 100, 106, 97, 101, 55, true));
    // Next minute: no print yet, so the feed's close stands.
    agg.ingestBar(bar(T + 60_000, 101, 102, 100, 100.5, 3, false));
    expect(agg.series('1m')[1]!.close).toBe(100.5);
  });
});

describe('missing-interval detection', () => {
  const NQ_SPEC = requireInstrument('NQ');
  const BAR_MS = 5 * 60_000;

  function series(times: number[]): NormalizedBar[] {
    return times.map((t) => bar(t, 100, 101, 99, 100, 1));
  }

  it('ignores the daily maintenance break', () => {
    // Last bar opens 15:55 CT and covers to 16:00; trading resumes at 17:00.
    // That 65-minute hole is the market being shut, not missing data.
    const gaps = findMarketGaps(
      NQ_SPEC,
      series([ct('2026-09-15T15:55:00'), ct('2026-09-15T17:00:00')]),
      { barMs: BAR_MS },
    );
    expect(gaps).toEqual([]);
  });

  it('ignores the weekend', () => {
    const gaps = findMarketGaps(
      NQ_SPEC,
      series([ct('2026-09-18T15:55:00'), ct('2026-09-20T17:00:00')]),
      { barMs: BAR_MS },
    );
    expect(gaps).toEqual([]);
  });

  it('ignores a full exchange holiday', () => {
    const gaps = findMarketGaps(
      NQ_SPEC,
      series([ct('2026-12-24T15:55:00'), ct('2026-12-26T09:00:00')]),
      { barMs: BAR_MS },
    );
    expect(gaps).toEqual([]);
  });

  /** The case that produced a silently wrong chart: an outage mid-session. */
  it('reports a hole spanning an open market', () => {
    const from = ct('2026-09-15T10:00:00');
    const to = ct('2026-09-15T11:35:00'); // 95 minutes, market open throughout
    const gaps = findMarketGaps(NQ_SPEC, series([from, to]), { barMs: BAR_MS });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.from).toBe(from);
    expect(gaps[0]!.to).toBe(to);
    expect(gaps[0]!.durationMs).toBe(95 * 60_000);
  });

  it('tolerates a single missing bar in a quiet stretch', () => {
    const start = ct('2026-09-15T02:00:00');
    const gaps = findMarketGaps(
      NQ_SPEC,
      series([start, start + BAR_MS * 2]),
      { barMs: BAR_MS },
    );
    expect(gaps).toEqual([]);
  });

  it('finds every interior hole, not just the first', () => {
    const gaps = findMarketGaps(
      NQ_SPEC,
      series([
        ct('2026-09-15T09:00:00'),
        ct('2026-09-15T10:00:00'),
        ct('2026-09-15T10:05:00'),
        ct('2026-09-15T12:00:00'),
      ]),
      { barMs: BAR_MS },
    );
    expect(gaps).toHaveLength(2);
  });

  describe('tail gap', () => {
    it('does not flag a delayed feed that is simply delayed', () => {
      // feedNow is the feed's own view of market time, already delay-adjusted.
      const feedNow = ct('2026-09-15T10:00:00');
      const bars = series([feedNow - BAR_MS, feedNow]);
      expect(hasTailGap(NQ_SPEC, bars, feedNow, BAR_MS)).toBe(false);
    });

    it('flags a series that stopped advancing while the market was open', () => {
      const feedNow = ct('2026-09-15T11:00:00');
      const bars = series([ct('2026-09-15T09:55:00'), ct('2026-09-15T10:00:00')]);
      expect(hasTailGap(NQ_SPEC, bars, feedNow, BAR_MS)).toBe(true);
    });

    it('does not flag a stale tail when the market is closed', () => {
      // Saturday: nothing new is expected, so the tail is correct.
      const feedNow = ct('2026-09-19T10:00:00');
      const bars = series([ct('2026-09-18T15:55:00')]);
      expect(hasTailGap(NQ_SPEC, bars, feedNow, BAR_MS)).toBe(false);
    });
  });
});

describe('a stale print does not invent a bar in the past', () => {
  it('ignores a price stamped before the newest bucket', () => {
    const spec = requireInstrument('NQ');
    const agg = new CandleAggregator(spec, { baseTimeframe: '1m' });
    const minute = 60_000;
    const t0 = Date.UTC(2026, 8, 17, 15, 0, 0);

    agg.ingestBar(
      { symbol: 'NQ', time: t0, open: 20_000, high: 20_010, low: 19_990, close: 20_005, volume: 10, closed: true },
      'HISTORY',
    );
    agg.ingestBar(
      { symbol: 'NQ', time: t0 + minute, open: 20_005, high: 20_020, low: 20_000, close: 20_015, volume: 12, closed: false },
      'STREAM',
    );

    // A print from an hour ago, re-published by the feed. It used to create a
    // bar of its own - one price, no volume - in the middle of the history.
    const before = agg.fineSeries().length;
    expect(agg.ingestPrice(19_500, t0 - 60 * minute)).toBe(false);
    expect(agg.fineSeries().length).toBe(before);
    expect(agg.fineSeries().some((b) => b.close === 19_500)).toBe(false);

    // A print for the bucket that is still forming is still welcome.
    expect(agg.ingestPrice(20_018, t0 + minute + 30_000)).toBe(true);
    expect(agg.latest('1m')!.close).toBe(20_018);
  });
});

describe('the forming bar\'s open belongs to the feed', () => {
  const spec = requireInstrument('GC');

  it('a print opens the bucket when the feed has not published one', () => {
    const agg = new CandleAggregator(spec, { baseTimeframe: '1m' });
    agg.ingestPrice(4388.3, 1789700885000);
    expect(agg.latest('1m')).toMatchObject({ open: 4388.3, close: 4388.3 });
  });

  it("but the feed's bar takes the open back the moment it arrives", () => {
    /*
     * The defect this proves fixed, measured on the live feed at 22:08 CT:
     * gold's real open for the minute was 4387.50 and Atlas was showing
     * 4388.30 - the first price it happened to see - eight ticks away on a
     * candle a trader was looking at.
     */
    const agg = new CandleAggregator(spec, { baseTimeframe: '1m' });
    agg.ingestPrice(4388.3, 1789700885000);
    agg.ingestBar({
      symbol: 'GC',
      time: 1789700880000,
      open: 4387.5,
      high: 4388.3,
      low: 4385.9,
      close: 4385.9,
      volume: 0,
      closed: false,
    });
    const bar = agg.latest('1m')!;
    expect(bar.open).toBe(4387.5);
    // The print is still newer than the feed's snapshot, so it keeps the close,
    // and the range covers everything either source saw.
    expect(bar.close).toBe(4388.3);
    expect(bar.high).toBe(4388.3);
    expect(bar.low).toBe(4385.9);
  });

  it('a later print cannot move the open again', () => {
    const agg = new CandleAggregator(spec, { baseTimeframe: '1m' });
    agg.ingestBar({
      symbol: 'GC',
      time: 1789700880000,
      open: 4387.5,
      high: 4387.6,
      low: 4387.4,
      close: 4387.5,
      volume: 10,
      closed: false,
    });
    agg.ingestPrice(4390.0, 1789700890000);
    expect(agg.latest('1m')).toMatchObject({ open: 4387.5, high: 4390, close: 4390 });
  });
});
