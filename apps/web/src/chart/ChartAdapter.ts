/**
 * The chart abstraction.
 *
 * Trading features are written against THIS interface, never against a specific
 * charting library. That is what makes it possible to move from the Apache-2.0
 * renderer used today to a commercially licensed engine later without
 * rewriting order lines, drawings, indicators or the DOM link-up.
 */
import type { NormalizedBar, Timeframe } from '@atlas/contracts';
import type { ChartAppearance } from './appearance';
import type { IndicatorInstance } from './indicators/registry';

export type ChartType =
  | 'CANDLES'
  | 'HOLLOW_CANDLES'
  | 'BARS'
  | 'LINE'
  | 'LINE_WITH_MARKERS'
  | 'AREA'
  | 'BASELINE'
  | 'HEIKIN_ASHI'
  // Phase 2 targets. The transform interface exists so these are additive.
  | 'RENKO'
  | 'KAGI'
  | 'LINE_BREAK'
  | 'POINT_AND_FIGURE'
  | 'HIGH_LOW';

export const PHASE_1_CHART_TYPES: readonly ChartType[] = [
  'CANDLES',
  'HOLLOW_CANDLES',
  'BARS',
  'LINE',
  'LINE_WITH_MARKERS',
  'AREA',
  'BASELINE',
  'HEIKIN_ASHI',
];

export type PriceScaleMode = 'NORMAL' | 'LOGARITHMIC' | 'PERCENTAGE' | 'INDEXED_TO_100';

export interface ChartInit {
  readonly container: HTMLElement;
  readonly pricePrecision: number;
  readonly tickSize: number;
  /** The instrument's own zone. Appearance may override which zone is shown. */
  readonly timeZone: string;
  readonly appearance: ChartAppearance;
}

/**
 * Screen geometry, for anything drawn over the chart.
 *
 * Order markers and drawings both need to convert between market coordinates
 * and pixels, and neither should know what charting library is underneath.
 */
export interface ChartProjection {
  readonly timeToX: (timeMs: number) => number | null;
  readonly xToTime: (x: number) => number | null;
  readonly priceToY: (price: number) => number | null;
  readonly yToPrice: (y: number) => number | null;
  /**
   * Bar INDEX conversions, fractional, extrapolated past either end.
   *
   * A chart lays bars out by index, not by the clock: a weekend is no wider
   * than a minute. So moving a drawing "three bars to the right" is an index
   * operation, and doing it in milliseconds instead makes an object jump
   * whenever it crosses a session gap.
   */
  readonly xToIndex: (x: number) => number | null;
  readonly indexToTime: (index: number) => number | null;
  readonly timeToIndex: (timeMs: number) => number | null;
  readonly width: number;
  readonly height: number;
}

export interface CrosshairInfo {
  readonly time: number | null;
  readonly price: number | null;
  readonly bar: NormalizedBar | null;
}

export interface VisibleRange {
  readonly from: number;
  readonly to: number;
}

/** A working order drawn on the chart. Draggable in Milestone 6. */
export interface OrderLineSpec {
  readonly id: string;
  readonly price: number;
  readonly label: string;
  readonly side: 'BUY' | 'SELL';
  readonly kind: 'LIMIT' | 'STOP' | 'TARGET' | 'ENTRY';
  readonly draggable: boolean;
}

export interface OrderLineHandle {
  update(spec: Partial<OrderLineSpec>): void;
  remove(): void;
}

export interface ChartAdapter {
  readonly engineId: string;
  readonly engineName: string;

  mount(init: ChartInit): void;
  destroy(): void;
  resize(): void;

  setChartType(type: ChartType): void;
  getChartType(): ChartType;
  setPriceScaleMode(mode: PriceScaleMode): void;
  setTimeframe(tf: Timeframe): void;

  /** Replace the whole series. Used on symbol or timeframe change. */
  applyHistory(bars: readonly NormalizedBar[]): void;
  /** Prepend older bars without disturbing the viewport. */
  prependHistory(bars: readonly NormalizedBar[]): void;
  /**
   * Apply one bar. Called from the market stream, off the React tree — it must
   * not trigger a component render.
   */
  applyLiveBar(bar: NormalizedBar): void;

  setVolumeVisible(visible: boolean): void;
  setSessionBreaksVisible(visible: boolean): void;

  /**
   * Apply the whole appearance in one call.
   *
   * One call rather than thirty setters, because a partial application looks
   * like a flash of the wrong theme, and because the settings dialog edits an
   * object rather than a list of properties.
   */
  applyAppearance(appearance: ChartAppearance): void;

  /**
   * Replace the set of indicators.
   *
   * The adapter holds the bars, so it computes the indicator values itself on
   * every redraw and every live bar. That is deliberate: it keeps a tick from
   * passing through React just because a moving average is on the chart.
   */
  setIndicators(indicators: readonly IndicatorInstance[]): void;

  /** Titles and current values for the status line, in display order. */
  indicatorLegend(): ReadonlyArray<{ id: string; label: string; color: string; value: string }>;

  /** Pixel geometry for the overlay layers. Null before the chart is mounted. */
  projection(): ChartProjection | null;

  /** The genuine bar nearest a time, for the drawing magnet. Never interpolated. */
  barNear(timeMs: number): NormalizedBar | null;

  /**
   * Width of the price axis, in pixels.
   *
   * The overlay layers are inset by it so a label or a drawing never paints
   * over the scale's own numbers.
   */
  priceScaleWidth(): number;

  fitContent(): void;
  scrollToRealtime(): void;
  resetScale(): void;
  setAutoScale(enabled: boolean): void;
  goToTime(time: number): void;

  getVisibleRange(): VisibleRange | null;
  /** Fires when the user scrolls back past the loaded history. */
  onNeedMoreHistory(callback: (oldestLoadedTime: number) => void): () => void;
  onCrosshairMove(callback: (info: CrosshairInfo) => void): () => void;
  onVisibleRangeChange(callback: (range: VisibleRange | null) => void): () => void;

  addOrderLine(spec: OrderLineSpec): OrderLineHandle;
  clearOrderLines(): void;

  screenshot(): Promise<Blob | null>;

  /** Hide the calendar (not the clock) on the axis, for blind practice. */
  setDatesHidden(hidden: boolean): void;

  priceToY(price: number): number | null;
  yToPrice(y: number): number | null;
}
