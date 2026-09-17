/**
 * The chart abstraction.
 *
 * Trading features are written against THIS interface, never against a specific
 * charting library. That is what makes it possible to move from the Apache-2.0
 * renderer used today to a commercially licensed engine later without
 * rewriting order lines, drawings, indicators or the DOM link-up.
 */
import type { NormalizedBar, Timeframe } from '@atlas/contracts';

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
  readonly timeZone: string;
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
