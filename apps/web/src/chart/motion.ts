/**
 * The visual market-motion layer.
 *
 * A delayed feed arrives in steps: a price, then nothing for five seconds, then
 * another price. Drawn literally, the chart jumps. Traders read momentum from
 * how a price MOVES, so a stepping chart is harder to read than a moving one -
 * which is why every professional platform animates between the prints it gets.
 *
 * The line this module must not cross is equally important: interpolation is a
 * DRAWING choice and nothing else. Nothing produced here is ever sent to the
 * server, matched against an order, recorded, or used in a calculation. The
 * engine fills, triggers and marks exclusively on genuine observations; this
 * decides what the eye sees between two of them.
 *
 * Three guarantees make that safe, and each has a test:
 *
 *   1. Every value emitted lies BETWEEN two genuine observations. Nothing is
 *      extrapolated past the newest print, in either direction.
 *   2. The visual value always converges on the newest observation, within a
 *      bounded time, whatever the settings.
 *   3. Switching modes cannot produce a value the raw feed did not justify.
 */
import type { NormalizedBar } from '@atlas/contracts';

export type MotionMode =
  /** Draw every observation exactly when it arrives. No animation at all. */
  | 'RAW'
  /** Ease between observations. The default for a delayed feed. */
  | 'SMOOTH';

export interface MotionSettings {
  readonly mode: MotionMode;
  /**
   * How hard to smooth, 0 to 1.
   *
   * 0 is indistinguishable from RAW. 1 is the slowest, most fluid approach.
   * It sets the fraction of the remaining gap closed each frame, before the
   * speed multiplier.
   */
  readonly smoothing: number;
  /** Multiplier on the approach rate. 2 covers the gap twice as fast. */
  readonly animationSpeed: number;
  /**
   * The hard deadline, in milliseconds, by which the visual price must equal
   * the genuine one.
   *
   * This is what stops a heavy smoothing setting from leaving the chart
   * permanently behind the market. The visual price can lag; it cannot lie.
   */
  readonly maxCatchUpMs: number;
}

export const RAW_MOTION: MotionSettings = {
  mode: 'RAW',
  smoothing: 0,
  animationSpeed: 1,
  maxCatchUpMs: 0,
};

export const DEFAULT_MOTION: MotionSettings = {
  mode: 'SMOOTH',
  smoothing: 0.55,
  animationSpeed: 1,
  maxCatchUpMs: 1_200,
};

export function normalizeMotion(patch: Partial<MotionSettings> | null | undefined): MotionSettings {
  const merged = { ...DEFAULT_MOTION, ...(patch ?? {}) };
  return {
    mode: merged.mode === 'RAW' ? 'RAW' : 'SMOOTH',
    smoothing: clamp(merged.smoothing, 0, 1),
    animationSpeed: clamp(merged.animationSpeed, 0.25, 8),
    maxCatchUpMs: clamp(merged.maxCatchUpMs, 0, 10_000),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Eases a forming bar's close between genuine observations.
 *
 * Only the CLOSE is animated. The open, high, low and volume are the vendor's
 * numbers and are passed through untouched - an interpolated extreme would be a
 * price that never traded, which is exactly what this platform must never draw.
 * No animated value can leave the bar's real range either, because it always
 * lies between two closes that are themselves inside it.
 */
export class MarketMotion {
  private settings: MotionSettings;
  /** The newest genuine observation. The only thing the engine ever sees. */
  private target: NormalizedBar | null = null;
  /** Where the drawn price currently is. */
  private visual: number | null = null;
  /** Where the drawn price was when the current target arrived. */
  private origin: number | null = null;
  private targetAt = 0;
  private tickSize: number;
  /**
   * How often observations have been arriving, in milliseconds.
   *
   * This is what makes the animation feel the same at every replay speed. At
   * 100x a print lands every few hundred milliseconds and the easing has to be
   * quick; at half speed they are minutes apart and it can be languid. A fixed
   * rate would either stutter at speed or crawl at rest, so the duration of
   * each move is derived from the cadence actually being observed.
   */
  private cadenceMs = 1_000;
  private lastObservedAt: number | null = null;
  /** The duration of the move currently in flight. */
  private moveMs = 250;
  /**
   * Something has changed that the chart has not drawn yet.
   *
   * Without this the class cannot tell "converged, nothing to do" from "just
   * snapped to the truth and the chart is still showing the old value", and the
   * second one must always produce a frame.
   */
  private dirty = false;

  constructor(settings: MotionSettings = DEFAULT_MOTION, tickSize = 0.25) {
    this.settings = normalizeMotion(settings);
    this.tickSize = tickSize;
  }

  /**
   * Change settings without resetting the animation.
   *
   * Switching to RAW snaps to the genuine price immediately, which is the whole
   * point of RAW: it must never keep showing an interpolated value.
   */
  setSettings(settings: Partial<MotionSettings>): void {
    this.settings = normalizeMotion({ ...this.settings, ...settings });
    if (this.settings.mode === 'RAW' && this.target) {
      this.visual = this.target.close;
      this.dirty = true;
    }
  }

  getSettings(): MotionSettings {
    return this.settings;
  }

  setTickSize(tickSize: number): void {
    this.tickSize = tickSize > 0 ? tickSize : 0.25;
  }

  /** Forget everything. Used on a symbol or timeframe change. */
  reset(): void {
    this.target = null;
    this.visual = null;
    this.origin = null;
    this.targetAt = 0;
    this.dirty = false;
    this.lastObservedAt = null;
    this.cadenceMs = 1_000;
  }

  /**
   * Accept a genuine observation.
   *
   * A bar with a different time is a new bucket: the animation restarts from
   * that bar's own open rather than dragging the previous bar's close into it.
   */
  observe(bar: NormalizedBar, now: number): void {
    const previous = this.target;
    const sameBucket = previous !== null && previous.time === bar.time;

    // Cadence is measured, not assumed, and smoothed so one late print does not
    // stretch the next animation.
    if (this.lastObservedAt !== null) {
      const gap = Math.max(16, now - this.lastObservedAt);
      this.cadenceMs = this.cadenceMs * 0.7 + Math.min(gap, 30_000) * 0.3;
    }
    this.lastObservedAt = now;

    this.origin = this.visual !== null && sameBucket ? this.visual : bar.open;
    this.target = bar;
    this.targetAt = now;
    this.dirty = true;
    // Arrive before the next print is due, and never later than the deadline.
    this.moveMs = Math.max(
      16,
      Math.min(
        this.settings.maxCatchUpMs,
        (this.cadenceMs * this.settings.smoothing) / this.settings.animationSpeed,
      ),
    );

    // A settled bar is history. Animating toward a close that is already final
    // would leave the chart showing a candle that differs from the data behind
    // it, so a closed bar is drawn exactly, immediately, in every mode.
    if (bar.closed) {
      this.visual = bar.close;
      return;
    }

    if (this.settings.mode === 'RAW' || this.settings.smoothing <= 0) {
      this.visual = bar.close;
      return;
    }
    if (this.visual === null || !sameBucket) this.visual = this.origin;
  }

  /** The newest genuine bar, exactly as it arrived. */
  genuine(): NormalizedBar | null {
    return this.target;
  }

  /**
   * The bar to draw right now.
   *
   * Returns null when there is nothing new to draw, so the caller can skip the
   * frame entirely rather than re-rendering an unchanged chart.
   */
  sample(now: number): NormalizedBar | null {
    const target = this.target;
    if (!target) return null;

    // RAW, no smoothing, or a bar that has already settled: draw the truth.
    // A closed bar is history, and history is not animated.
    if (this.settings.mode === 'RAW' || this.settings.smoothing <= 0 || target.closed) {
      if (this.visual === target.close && !this.dirty) return null;
      this.visual = target.close;
      this.dirty = false;
      return target;
    }

    const origin = this.origin ?? this.visual ?? target.close;
    const gap = target.close - origin;
    const elapsed = now - this.targetAt;

    // Converged, or past the deadline: show the truth and stop animating.
    if (Math.abs(gap) < this.tickSize / 8 || elapsed >= this.moveMs) {
      if (this.visual === target.close && !this.dirty) return null;
      this.visual = target.close;
      this.dirty = false;
      return target;
    }

    // Eased interpolation over a measured duration. Time-based rather than
    // frame-based, so the motion is identical on a 60Hz screen and a 144Hz one,
    // and it lands exactly on the genuine price at the end of the move rather
    // than approaching it forever.
    const progress = Math.min(1, Math.max(0, elapsed / this.moveMs));
    const eased = 1 - (1 - progress) ** 3;
    let next = origin + gap * eased;

    // Never past the genuine price, in either direction. This is the guarantee
    // that keeps every drawn value inside the data.
    if ((gap > 0 && next > target.close) || (gap < 0 && next < target.close)) {
      next = target.close;
    }

    if (this.visual !== null && Math.abs(next - this.visual) < this.tickSize / 64 && !this.dirty) {
      return null;
    }

    this.visual = next;
    this.dirty = false;
    return { ...target, close: next };
  }

  /** How often prints have been arriving. Diagnostics and tests only. */
  observedCadenceMs(): number {
    return this.cadenceMs;
  }

  /** How long the move in flight will take. Diagnostics and tests only. */
  moveDurationMs(): number {
    return this.moveMs;
  }

  /** The value currently drawn. Diagnostics and tests only. */
  visualPrice(): number | null {
    return this.visual;
  }
}
