/**
 * The chart legend, driven by direct DOM writes.
 *
 * This is intentionally not a React component. It updates on every tick and on
 * every crosshair move; as JSX it would re-render the panel dozens of times a
 * second and fight the canvas for frame budget. Instead it owns a handful of
 * text nodes and writes into them, which costs nothing measurable.
 */
import type { NormalizedBar } from '@atlas/contracts';

export interface LegendFields {
  readonly price: HTMLElement;
  readonly change: HTMLElement;
  readonly open: HTMLElement;
  readonly high: HTMLElement;
  readonly low: HTMLElement;
  readonly close: HTMLElement;
  readonly volume: HTMLElement;
  readonly barTime: HTMLElement;
  readonly updatedAt: HTMLElement;
}

export class ChartLegend {
  private precision: number;
  private timeZone: string;
  /** Bar under the crosshair; null means "follow the live bar". */
  private hovered: NormalizedBar | null = null;
  private live: NormalizedBar | null = null;
  private previousClose: number | null = null;
  private datesHidden = false;

  constructor(
    private readonly fields: LegendFields,
    options: { precision: number; timeZone: string },
  ) {
    this.precision = options.precision;
    this.timeZone = options.timeZone;
  }

  configure(options: { precision: number; timeZone: string }): void {
    this.precision = options.precision;
    this.timeZone = options.timeZone;
  }

  /** The bar before the newest one, used for the session change figure. */
  setReference(bar: NormalizedBar | null): void {
    this.previousClose = bar?.close ?? null;
    this.render();
  }

  setLive(bar: NormalizedBar): void {
    this.live = bar;
    if (!this.hovered) this.render();
    this.fields.updatedAt.textContent = this.formatClock(bar.time);
  }

  setHovered(bar: NormalizedBar | null): void {
    this.hovered = bar;
    this.render();
  }

  clear(): void {
    this.live = null;
    this.hovered = null;
    this.previousClose = null;
    for (const key of ['price', 'open', 'high', 'low', 'close', 'volume', 'barTime'] as const) {
      this.fields[key].textContent = '—';
    }
    this.fields.change.textContent = '';
    this.fields.change.className = 'legend-change';
  }

  private render(): void {
    const bar = this.hovered ?? this.live;
    if (!bar) return;

    const price = bar.close.toFixed(this.precision);
    this.fields.price.textContent = price;
    this.fields.open.textContent = bar.open.toFixed(this.precision);
    this.fields.high.textContent = bar.high.toFixed(this.precision);
    this.fields.low.textContent = bar.low.toFixed(this.precision);
    this.fields.close.textContent = bar.close.toFixed(this.precision);
    this.fields.volume.textContent = bar.volume.toLocaleString('en-US');
    this.fields.barTime.textContent = this.formatBarTime(bar.time);

    // Direction colour follows the bar itself, not the session, so the legend
    // agrees with the candle the user is looking at.
    const up = bar.close >= bar.open;
    this.fields.price.className = `num legend-price ${up ? 'pos' : 'neg'}`;

    if (this.previousClose !== null) {
      const delta = bar.close - this.previousClose;
      const percent = (delta / this.previousClose) * 100;
      const sign = delta > 0 ? '+' : '';
      this.fields.change.textContent = `${sign}${delta.toFixed(this.precision)} (${sign}${percent.toFixed(2)}%)`;
      this.fields.change.className = `num legend-change ${delta >= 0 ? 'pos' : 'neg'}`;
    }
  }

  /**
   * Blind practice hides the calendar here too, for the same reason.
   *
   * It redraws at once rather than waiting for the next bar: with a replay
   * paused, the next bar may never come, and a legend still showing the date
   * would defeat the whole mode.
   */
  setDatesHidden(hidden: boolean): void {
    if (this.datesHidden === hidden) return;
    this.datesHidden = hidden;
    this.render();
  }

  private formatBarTime(ms: number): string {
    return new Intl.DateTimeFormat('en-US', {
      ...(this.datesHidden ? {} : { month: 'short' as const, day: '2-digit' as const }),
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: this.timeZone,
    }).format(ms);
  }

  private formatClock(ms: number): string {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: this.timeZone,
    }).format(ms);
  }
}
