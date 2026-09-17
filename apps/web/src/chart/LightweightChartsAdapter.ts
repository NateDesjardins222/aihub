/**
 * ChartAdapter implemented over `lightweight-charts` (Apache-2.0).
 *
 * The library provides the canvas renderer, the scales and the crosshair.
 * Everything trading-specific — order lines, position lines, the drawing layer,
 * indicators, session shading — is our own code built on its public API. No
 * proprietary charting source is used or reproduced.
 *
 * Nothing in this file touches React. `applyLiveBar` is called straight from the
 * market stream and writes to the chart, so a tick costs one canvas update
 * rather than a component tree render.
 */
import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { NormalizedBar, Timeframe } from '@atlas/contracts';
import type {
  ChartAdapter,
  ChartInit,
  ChartType,
  CrosshairInfo,
  OrderLineHandle,
  OrderLineSpec,
  PriceScaleMode as AdapterPriceScaleMode,
  VisibleRange,
} from './ChartAdapter';
import { isStatefulTransform, transformFor } from './transforms';

const COLORS = {
  up: '#2ec4a6',
  down: '#f2544b',
  upFill: 'rgba(46, 196, 166, 0.85)',
  downFill: 'rgba(242, 84, 75, 0.85)',
  volumeUp: 'rgba(46, 196, 166, 0.34)',
  volumeDown: 'rgba(242, 84, 75, 0.34)',
  line: '#4d8dff',
  areaTop: 'rgba(77, 141, 255, 0.34)',
  areaBottom: 'rgba(77, 141, 255, 0.02)',
  grid: '#151b26',
  border: '#242d3e',
  text: '#9aa6bd',
  background: '#0b0e14',
} as const;

function toTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

function fromTime(time: Time): number {
  return typeof time === 'number' ? time * 1000 : 0;
}

export class LightweightChartsAdapter implements ChartAdapter {
  readonly engineId = 'lightweight-charts';
  readonly engineName = 'Atlas Canvas Engine (lightweight-charts, Apache-2.0)';

  private chart: IChartApi | null = null;
  private priceSeries: ISeriesApi<SeriesType> | null = null;
  private volumeSeries: ISeriesApi<'Histogram'> | null = null;
  private container: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private chartType: ChartType = 'CANDLES';
  private timeframe: Timeframe = '1m';
  private pricePrecision = 2;
  /** Blind practice: the clock is shown, the calendar is not. */
  private datesHidden = false;
  private tickSize = 0.25;
  private volumeVisible = true;
  private autoScale = true;

  /** Real bars, untransformed. The transform is applied on the way to the canvas. */
  private bars: NormalizedBar[] = [];
  private readonly byTime = new Map<number, number>();

  private readonly orderLines = new Map<string, { line: IPriceLine; spec: OrderLineSpec }>();
  private readonly historyCallbacks = new Set<(oldest: number) => void>();
  private readonly crosshairCallbacks = new Set<(info: CrosshairInfo) => void>();
  private readonly rangeCallbacks = new Set<(range: VisibleRange | null) => void>();
  private historyRequestPending = false;

  mount(init: ChartInit): void {
    this.container = init.container;
    this.pricePrecision = init.pricePrecision;
    this.tickSize = init.tickSize;

    this.chart = createChart(init.container, {
      layout: {
        background: { type: ColorType.Solid, color: COLORS.background },
        textColor: COLORS.text,
        fontSize: 11,
        fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#4d8dff', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#2a5199' },
        horzLine: { color: '#4d8dff', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#2a5199' },
      },
      rightPriceScale: {
        borderColor: COLORS.border,
        scaleMargins: { top: 0.08, bottom: 0.22 },
        autoScale: true,
      },
      timeScale: {
        borderColor: COLORS.border,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time) =>
          this.datesHidden
            ? new Intl.DateTimeFormat('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
                timeZone: init.timeZone,
              }).format(fromTime(time))
            : undefined,
        rightOffset: 6,
        barSpacing: 7,
        // Session gaps are real and must stay visible as gaps.
        fixLeftEdge: false,
        lockVisibleTimeRangeOnResize: true,
      },
      localization: {
        locale: 'en-US',
        priceFormatter: (price: number) => price.toFixed(this.pricePrecision),
        // Blind practice hides WHICH day this is, never what happened in it:
        // the clock stays, the calendar goes. A trader who can read the date off
        // the axis can remember what the session did next, and the point of a
        // blind session is that they cannot.
        timeFormatter: (time: Time) =>
          new Intl.DateTimeFormat('en-US', {
            ...(this.datesHidden ? {} : { month: 'short', day: '2-digit' }),
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: init.timeZone,
          }).format(fromTime(time)),
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
      autoSize: false,
    });

    this.createPriceSeries();
    this.createVolumeSeries();
    this.wireEvents();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(init.container);
    this.resize();
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.orderLines.clear();
    this.historyCallbacks.clear();
    this.crosshairCallbacks.clear();
    this.rangeCallbacks.clear();
    this.chart?.remove();
    this.chart = null;
    this.priceSeries = null;
    this.volumeSeries = null;
    this.bars = [];
    this.byTime.clear();
  }

  resize(): void {
    if (!this.chart || !this.container) return;
    const { clientWidth, clientHeight } = this.container;
    if (clientWidth > 0 && clientHeight > 0) this.chart.resize(clientWidth, clientHeight);
  }

  // -- series construction -------------------------------------------------

  private createPriceSeries(): void {
    if (!this.chart) return;
    if (this.priceSeries) {
      this.chart.removeSeries(this.priceSeries);
      this.priceSeries = null;
    }

    const priceFormat = {
      type: 'price' as const,
      precision: this.pricePrecision,
      minMove: this.tickSize,
    };

    switch (this.chartType) {
      case 'BARS':
        this.priceSeries = this.chart.addSeries(BarSeries, {
          upColor: COLORS.up,
          downColor: COLORS.down,
          thinBars: false,
          priceFormat,
        });
        break;

      case 'LINE':
      case 'LINE_WITH_MARKERS':
        this.priceSeries = this.chart.addSeries(LineSeries, {
          color: COLORS.line,
          lineWidth: 2,
          pointMarkersVisible: this.chartType === 'LINE_WITH_MARKERS',
          priceFormat,
        });
        break;

      case 'AREA':
        this.priceSeries = this.chart.addSeries(AreaSeries, {
          lineColor: COLORS.line,
          topColor: COLORS.areaTop,
          bottomColor: COLORS.areaBottom,
          lineWidth: 2,
          priceFormat,
        });
        break;

      case 'BASELINE':
        this.priceSeries = this.chart.addSeries(BaselineSeries, {
          topLineColor: COLORS.up,
          topFillColor1: 'rgba(46,196,166,0.28)',
          topFillColor2: 'rgba(46,196,166,0.03)',
          bottomLineColor: COLORS.down,
          bottomFillColor1: 'rgba(242,84,75,0.03)',
          bottomFillColor2: 'rgba(242,84,75,0.28)',
          priceFormat,
        });
        break;

      case 'HOLLOW_CANDLES':
        // Hollow candles: up bars are outlined, down bars filled.
        this.priceSeries = this.chart.addSeries(CandlestickSeries, {
          upColor: 'rgba(0,0,0,0)',
          downColor: COLORS.downFill,
          borderUpColor: COLORS.up,
          borderDownColor: COLORS.down,
          wickUpColor: COLORS.up,
          wickDownColor: COLORS.down,
          priceFormat,
        });
        break;

      default:
        this.priceSeries = this.chart.addSeries(CandlestickSeries, {
          upColor: COLORS.upFill,
          downColor: COLORS.downFill,
          borderUpColor: COLORS.up,
          borderDownColor: COLORS.down,
          wickUpColor: COLORS.up,
          wickDownColor: COLORS.down,
          priceFormat,
        });
    }

    this.priceSeries.priceScale().applyOptions({
      autoScale: this.autoScale,
      scaleMargins: { top: 0.08, bottom: 0.22 },
    });
  }

  private createVolumeSeries(): void {
    if (!this.chart) return;
    this.volumeSeries = this.chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      visible: this.volumeVisible,
    });
    // Volume occupies the lower fifth, overlaid on the same pane.
    this.chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
      visible: false,
    });
  }

  private wireEvents(): void {
    if (!this.chart) return;

    this.chart.subscribeCrosshairMove((param) => {
      if (this.crosshairCallbacks.size === 0) return;
      const timeMs = param.time !== undefined ? fromTime(param.time) : null;
      const index = timeMs === null ? undefined : this.byTime.get(timeMs);
      const bar = index === undefined ? null : (this.bars[index] ?? null);
      const price =
        this.priceSeries && param.point
          ? (this.priceSeries.coordinateToPrice(param.point.y) ?? null)
          : null;
      const info: CrosshairInfo = { time: timeMs, price, bar };
      for (const callback of this.crosshairCallbacks) callback(info);
    });

    this.chart.timeScale().subscribeVisibleLogicalRangeChange((logical) => {
      if (!logical) return;

      // Scrolled past the left edge of what is loaded: ask for older bars.
      if (logical.from < 8 && this.bars.length > 0 && !this.historyRequestPending) {
        this.historyRequestPending = true;
        const oldest = this.bars[0]!.time;
        for (const callback of this.historyCallbacks) callback(oldest);
      }

      if (this.rangeCallbacks.size > 0) {
        const range = this.chart!.timeScale().getVisibleRange();
        const value: VisibleRange | null = range
          ? { from: fromTime(range.from), to: fromTime(range.to) }
          : null;
        for (const callback of this.rangeCallbacks) callback(value);
      }
    });
  }

  // -- data ----------------------------------------------------------------

  setChartType(type: ChartType): void {
    if (type === this.chartType) return;
    this.chartType = type;
    this.createPriceSeries();
    this.redraw();
  }

  getChartType(): ChartType {
    return this.chartType;
  }

  setTimeframe(tf: Timeframe): void {
    this.timeframe = tf;
    // Sub-minute timeframes need seconds on the axis to be readable.
    this.chart?.applyOptions({
      timeScale: { secondsVisible: tf.endsWith('s') },
    });
  }

  setPriceScaleMode(mode: AdapterPriceScaleMode): void {
    const map: Record<AdapterPriceScaleMode, PriceScaleMode> = {
      NORMAL: PriceScaleMode.Normal,
      LOGARITHMIC: PriceScaleMode.Logarithmic,
      PERCENTAGE: PriceScaleMode.Percentage,
      INDEXED_TO_100: PriceScaleMode.IndexedTo100,
    };
    this.priceSeries?.priceScale().applyOptions({ mode: map[mode] });
  }

  applyHistory(bars: readonly NormalizedBar[]): void {
    this.bars = [...bars];
    this.reindex();
    this.historyRequestPending = false;
    this.redraw();
  }

  prependHistory(bars: readonly NormalizedBar[]): void {
    if (bars.length === 0) {
      this.historyRequestPending = false;
      return;
    }
    const timeScale = this.chart?.timeScale();
    const before = timeScale?.getVisibleLogicalRange() ?? null;

    const existing = new Set(this.bars.map((b) => b.time));
    const older = bars.filter((b) => !existing.has(b.time));
    if (older.length === 0) {
      this.historyRequestPending = false;
      return;
    }

    this.bars = [...older, ...this.bars].sort((a, b) => a.time - b.time);
    this.reindex();
    this.redraw();

    // Keep the viewport anchored on the same bars the user was looking at:
    // prepending N bars shifts every logical index by N.
    if (before && timeScale) {
      timeScale.setVisibleLogicalRange({
        from: before.from + older.length,
        to: before.to + older.length,
      });
    }
    this.historyRequestPending = false;
  }

  /**
   * Apply a single bar from the market stream.
   *
   * Called outside React. A same-bucket update revises the last candle; a new
   * bucket appends. Both are single-series updates, not full redraws — except
   * for transforms whose values depend on prior bars.
   */
  applyLiveBar(bar: NormalizedBar): void {
    if (!this.priceSeries) return;

    const index = this.byTime.get(bar.time);
    const lastIndex = this.bars.length - 1;

    if (index !== undefined) {
      this.bars[index] = bar;
      // The renderer's incremental `update` only accepts the newest point.
      // Revising an interior bar has to go through a full redraw, or the
      // library throws and the chart stops taking updates altogether.
      if (index !== lastIndex) {
        this.redraw();
        return;
      }
    } else {
      const last = this.bars[lastIndex];
      if (last && bar.time < last.time) return; // stale: never rewind the series
      this.bars.push(bar);
      this.byTime.set(bar.time, this.bars.length - 1);
    }

    if (isStatefulTransform(this.chartType)) {
      // Heikin Ashi's open depends on the previous bar, so the tail must be
      // recomputed rather than patched in place.
      this.redraw();
      return;
    }

    this.priceSeries.update(this.toSeriesPoint(bar));
    if (this.volumeVisible && this.volumeSeries) {
      this.volumeSeries.update(this.toVolumePoint(bar));
    }
  }

  private reindex(): void {
    this.byTime.clear();
    for (let i = 0; i < this.bars.length; i += 1) this.byTime.set(this.bars[i]!.time, i);
  }

  private redraw(): void {
    if (!this.priceSeries) return;
    const transformed = transformFor(this.chartType)(this.bars);
    this.priceSeries.setData(transformed.map((b) => this.toSeriesPoint(b)));
    if (this.volumeSeries) {
      this.volumeSeries.setData(this.bars.map((b) => this.toVolumePoint(b)));
    }
  }

  private toSeriesPoint(bar: NormalizedBar): never {
    const time = toTime(bar.time);
    const isLineLike =
      this.chartType === 'LINE' ||
      this.chartType === 'LINE_WITH_MARKERS' ||
      this.chartType === 'AREA' ||
      this.chartType === 'BASELINE';

    if (isLineLike) return { time, value: bar.close } as never;
    return {
      time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    } as never;
  }

  private toVolumePoint(bar: NormalizedBar): never {
    return {
      time: toTime(bar.time),
      value: bar.volume,
      color: bar.close >= bar.open ? COLORS.volumeUp : COLORS.volumeDown,
    } as never;
  }

  // -- view controls -------------------------------------------------------

  setVolumeVisible(visible: boolean): void {
    this.volumeVisible = visible;
    this.volumeSeries?.applyOptions({ visible });
  }

  setSessionBreaksVisible(): void {
    // Session gaps are inherent: bars simply do not exist during the break, so
    // the gap is already visible. Explicit shading arrives with the drawing
    // layer in Milestone 4.
  }

  fitContent(): void {
    this.chart?.timeScale().fitContent();
  }

  scrollToRealtime(): void {
    this.chart?.timeScale().scrollToRealTime();
  }

  resetScale(): void {
    this.chart?.timeScale().resetTimeScale();
    this.priceSeries?.priceScale().applyOptions({ autoScale: true });
    this.autoScale = true;
  }

  setAutoScale(enabled: boolean): void {
    this.autoScale = enabled;
    this.priceSeries?.priceScale().applyOptions({ autoScale: enabled });
  }

  goToTime(time: number): void {
    const timeScale = this.chart?.timeScale();
    if (!timeScale) return;
    const index = this.bars.findIndex((b) => b.time >= time);
    if (index < 0) return;
    timeScale.setVisibleLogicalRange({ from: index - 60, to: index + 60 });
  }

  getVisibleRange(): VisibleRange | null {
    const range = this.chart?.timeScale().getVisibleRange();
    return range ? { from: fromTime(range.from), to: fromTime(range.to) } : null;
  }

  onNeedMoreHistory(callback: (oldest: number) => void): () => void {
    this.historyCallbacks.add(callback);
    return () => this.historyCallbacks.delete(callback);
  }

  onCrosshairMove(callback: (info: CrosshairInfo) => void): () => void {
    this.crosshairCallbacks.add(callback);
    return () => this.crosshairCallbacks.delete(callback);
  }

  onVisibleRangeChange(callback: (range: VisibleRange | null) => void): () => void {
    this.rangeCallbacks.add(callback);
    return () => this.rangeCallbacks.delete(callback);
  }

  /** Release the history latch, e.g. when a request returned nothing. */
  releaseHistoryLatch(): void {
    this.historyRequestPending = false;
  }

  // -- trading overlays ----------------------------------------------------

  addOrderLine(spec: OrderLineSpec): OrderLineHandle {
    if (!this.priceSeries) throw new Error('CHART_NOT_MOUNTED');
    const colour = spec.side === 'BUY' ? COLORS.up : COLORS.down;
    const line = this.priceSeries.createPriceLine({
      price: spec.price,
      color: colour,
      lineWidth: 1,
      lineStyle: spec.kind === 'ENTRY' ? LineStyle.Solid : LineStyle.Dashed,
      axisLabelVisible: true,
      title: spec.label,
    });
    this.orderLines.set(spec.id, { line, spec });

    return {
      update: (patch) => {
        const entry = this.orderLines.get(spec.id);
        if (!entry) return;
        const next = { ...entry.spec, ...patch };
        entry.line.applyOptions({
          price: next.price,
          title: next.label,
          color: next.side === 'BUY' ? COLORS.up : COLORS.down,
        });
        this.orderLines.set(spec.id, { line: entry.line, spec: next });
      },
      remove: () => {
        const entry = this.orderLines.get(spec.id);
        if (!entry) return;
        this.priceSeries?.removePriceLine(entry.line);
        this.orderLines.delete(spec.id);
      },
    };
  }

  clearOrderLines(): void {
    for (const { line } of this.orderLines.values()) this.priceSeries?.removePriceLine(line);
    this.orderLines.clear();
  }

  async screenshot(): Promise<Blob | null> {
    const canvas = this.chart?.takeScreenshot();
    if (!canvas) return null;
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
  }

  /**
   * Hide or show the calendar on the time axis and in the crosshair.
   *
   * Only the LABELS change. The bars, their timestamps and everything computed
   * from them are untouched - this is a mask, not a different chart.
   */
  setDatesHidden(hidden: boolean): void {
    if (this.datesHidden === hidden) return;
    this.datesHidden = hidden;
    // Re-applying the option makes the chart re-render its labels through the
    // formatters above.
    this.chart?.applyOptions({ timeScale: { timeVisible: true } });
  }

  priceToY(price: number): number | null {
    return this.priceSeries?.priceToCoordinate(price) ?? null;
  }

  yToPrice(y: number): number | null {
    return this.priceSeries?.coordinateToPrice(y) ?? null;
  }

  get barCount(): number {
    return this.bars.length;
  }

  get oldestBarTime(): number | null {
    return this.bars[0]?.time ?? null;
  }
}
