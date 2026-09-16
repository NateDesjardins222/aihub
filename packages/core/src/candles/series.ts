/**
 * An ordered, de-duplicated series of bars keyed by bucket open time.
 *
 * Keying by bucket time is the mechanism that makes duplicate candles
 * impossible: history and streaming updates for the same bucket resolve to the
 * same key and the later one revises the earlier, rather than appending a
 * second candle beside it.
 */
import type { NormalizedBar } from '@atlas/contracts';

export type BarSource = 'HISTORY' | 'STREAM';

export interface UpsertResult {
  /** True when the stored bar actually changed (new bucket or revised values). */
  readonly changed: boolean;
  /** True when this call created a bucket that did not exist before. */
  readonly created: boolean;
  readonly bar: NormalizedBar;
}

function sameBar(a: NormalizedBar, b: NormalizedBar): boolean {
  return (
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume &&
    a.closed === b.closed
  );
}

export class BarSeries {
  private readonly byTime = new Map<number, NormalizedBar>();
  /** Ascending bucket times. Kept sorted so range queries are a binary search. */
  private times: number[] = [];
  private dirty = false;

  constructor(readonly symbol: string) {}

  get size(): number {
    return this.byTime.size;
  }

  private sortIfNeeded(): void {
    if (!this.dirty) return;
    this.times.sort((a, b) => a - b);
    this.dirty = false;
  }

  /**
   * Insert or revise a bar.
   *
   * A streaming update may not resurrect a bucket that history already closed,
   * except to revise the bucket itself — vendors do restate the most recent
   * bar's volume, and refusing that would freeze a stale value on screen.
   */
  upsert(bar: NormalizedBar, source: BarSource = 'STREAM'): UpsertResult {
    const existing = this.byTime.get(bar.time);
    if (!existing) {
      this.byTime.set(bar.time, bar);
      this.times.push(bar.time);
      this.dirty = true;
      return { changed: true, created: true, bar };
    }

    // History is authoritative over a streaming guess for the same bucket.
    if (existing.closed && source === 'STREAM' && bar.closed === false) {
      // A stream cannot re-open a bar history has already settled.
      return { changed: false, created: false, bar: existing };
    }

    if (sameBar(existing, bar)) return { changed: false, created: false, bar: existing };
    this.byTime.set(bar.time, bar);
    return { changed: true, created: false, bar };
  }

  get(time: number): NormalizedBar | undefined {
    return this.byTime.get(time);
  }

  has(time: number): boolean {
    return this.byTime.has(time);
  }

  /** Ascending bars whose bucket time is in [from, to). */
  range(from = Number.NEGATIVE_INFINITY, to = Number.POSITIVE_INFINITY): NormalizedBar[] {
    this.sortIfNeeded();
    const out: NormalizedBar[] = [];
    for (const t of this.times) {
      if (t < from) continue;
      if (t >= to) break;
      const bar = this.byTime.get(t);
      if (bar) out.push(bar);
    }
    return out;
  }

  /** The most recent `count` bars strictly before `before`, ascending. */
  tail(count: number, before = Number.POSITIVE_INFINITY): NormalizedBar[] {
    this.sortIfNeeded();
    const out: NormalizedBar[] = [];
    for (let i = this.times.length - 1; i >= 0 && out.length < count; i -= 1) {
      const t = this.times[i]!;
      if (t >= before) continue;
      const bar = this.byTime.get(t);
      if (bar) out.push(bar);
    }
    return out.reverse();
  }

  all(): NormalizedBar[] {
    this.sortIfNeeded();
    return this.times.map((t) => this.byTime.get(t)!).filter(Boolean);
  }

  first(): NormalizedBar | undefined {
    this.sortIfNeeded();
    const t = this.times[0];
    return t === undefined ? undefined : this.byTime.get(t);
  }

  last(): NormalizedBar | undefined {
    this.sortIfNeeded();
    const t = this.times[this.times.length - 1];
    return t === undefined ? undefined : this.byTime.get(t);
  }

  /** Drop the oldest bars, keeping at most `max`. Guards unbounded memory growth. */
  trimTo(max: number): number {
    this.sortIfNeeded();
    if (this.times.length <= max) return 0;
    const remove = this.times.length - max;
    for (let i = 0; i < remove; i += 1) this.byTime.delete(this.times[i]!);
    this.times = this.times.slice(remove);
    return remove;
  }

  clear(): void {
    this.byTime.clear();
    this.times = [];
    this.dirty = false;
  }
}
