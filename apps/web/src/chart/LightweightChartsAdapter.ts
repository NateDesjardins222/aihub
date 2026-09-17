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
  ChartProjection,
  ChartType,
  CrosshairInfo,
  OrderLineHandle,
  OrderLineSpec,
  PriceScaleMode as AdapterPriceScaleMode,
  VisibleRange,
} from './ChartAdapter';
import { isStatefulTransform, transformFor } from './transforms';
import {
  DEFAULT_APPEARANCE,
  resolveZone,
  timeFormatter,
  type ChartAppearance,
} from './appearance';
import { indicatorDef, type IndicatorInstance, type Plot } from './indicators/registry';


/**
 * Re-alpha a colour for the derived fills.
 *
 * Accepts the hex and rgb/rgba forms the settings dialog can produce. Anything
 * it cannot parse is returned unchanged rather than replaced by a guess, so an
 * unusual but valid CSS colour still renders as the trader chose.
 */
function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const body = hex[1]!;
    const full =
      body.length === 3
        ? body
            .split('')
            .map((c) => c + c)
            .join('')
        : body;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const parts = rgb[1]!.split(',').map((part) => part.trim());
    const [r, g, b] = parts;
    if (r && g && b) return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

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

  private appearance: ChartAppearance = DEFAULT_APPEARANCE;
  /** The instrument's own zone. The appearance decides which one is displayed. */
  private exchangeZone = 'America/Chicago';
  private indicators: readonly IndicatorInstance[] = [];
  /**
   * One rendered series per indicator plot, keyed `instanceId:plotId`.
   *
   * Kept beside the price series rather than inside it: an indicator is drawn
   * FROM the bars and is never allowed to become one of them.
   */
  private readonly indicatorSeries = new Map<
    string,
    { series: ISeriesApi<SeriesType>; plot: Plot; pane: number }
  >();
  private readonly indicatorGuides = new Map<string, IPriceLine[]>();
  private readonly legendValues = new Map<string, string>();
  /** Pane index per indicator instance. 0 is the price pane. */
  private readonly panes = new Map<string, number>();

  private readonly orderLines = new Map<string, { line: IPriceLine; spec: OrderLineSpec }>();
  private readonly historyCallbacks = new Set<(oldest: number) => void>();
  private readonly crosshairCallbacks = new Set<(info: CrosshairInfo) => void>();
  private readonly rangeCallbacks = new Set<(range: VisibleRange | null) => void>();
  private historyRequestPending = false;

  mount(init: ChartInit): void {
    this.exchangeZone = init.timeZone;
    this.appearance = init.appearance;
    this.container = init.container;
    this.pricePrecision = init.pricePrecision;
    this.tickSize = init.tickSize;
    this.volumeVisible = init.appearance.symbol.volumeVisible;

    this.chart = createChart(init.container, {
      ...this.layoutOptions(),
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

  /**
   * Everything about the chart that is appearance rather than data.
   *
   * Built as one object so it can be handed to `createChart` on mount and to
   * `applyOptions` on every settings change, which means there is exactly one
   * description of how the chart looks.
   */
  private layoutOptions() {
    const a = this.appearance;
    const zone = resolveZone(a, this.exchangeZone);
    const background = a.canvas.backgroundGradientTo
      ? {
          type: ColorType.VerticalGradient as const,
          topColor: a.canvas.background,
          bottomColor: a.canvas.backgroundGradientTo,
        }
      : { type: ColorType.Solid as const, color: a.canvas.background };

    const crosshairMode =
      a.scales.crosshairStyle === 'MAGNET'
        ? CrosshairMode.Magnet
        : a.scales.crosshairStyle === 'HIDDEN'
          ? CrosshairMode.Hidden
          : CrosshairMode.Normal;

    return {
      layout: {
        background,
        textColor: a.canvas.textColor,
        fontSize: a.canvas.fontSize,
        fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
        attributionLogo: false,
        panes: { separatorColor: a.scales.paneSeparatorColor, separatorHoverColor: a.scales.scaleLineColor },
      },
      grid: {
        vertLines: { color: a.scales.gridColor, visible: a.scales.gridVerticalVisible },
        horzLines: { color: a.scales.gridColor, visible: a.scales.gridHorizontalVisible },
      },
      crosshair: {
        mode: crosshairMode,
        vertLine: {
          color: a.scales.crosshairColor,
          width: 1 as const,
          style: LineStyle.Dashed,
          labelBackgroundColor: a.scales.crosshairLabelBackground,
        },
        horzLine: {
          color: a.scales.crosshairColor,
          width: 1 as const,
          style: LineStyle.Dashed,
          labelBackgroundColor: a.scales.crosshairLabelBackground,
        },
      },
      rightPriceScale: {
        visible: a.scales.priceScaleVisible && a.scales.priceScaleSide === 'RIGHT',
        borderColor: a.scales.scaleLineColor,
        scaleMargins: { top: a.scales.scaleMarginTop, bottom: a.scales.scaleMarginBottom },
        autoScale: a.scales.autoScale,
      },
      leftPriceScale: {
        visible: a.scales.priceScaleVisible && a.scales.priceScaleSide === 'LEFT',
        borderColor: a.scales.scaleLineColor,
        scaleMargins: { top: a.scales.scaleMarginTop, bottom: a.scales.scaleMarginBottom },
        autoScale: a.scales.autoScale,
      },
      timeScale: {
        visible: a.scales.timeScaleVisible,
        borderColor: a.scales.scaleLineColor,
        timeVisible: true,
        secondsVisible: this.timeframe.endsWith('s'),
        rightOffset: 6,
        barSpacing: 7,
        fixLeftEdge: false,
        lockVisibleTimeRangeOnResize: true,
        // The axis formatter is installed unconditionally, because the default
        // is 24-hour and 12-hour with AM/PM is what this platform shows. It
        // must always return a string: a formatter that returns undefined does
        // not fall back to the library's labels, it prints "undefined".
        tickMarkFormatter: (time: Time): string => this.axisLabel(fromTime(time)),
      },
      localization: {
        locale: 'en-US',
        priceFormatter: (price: number) => price.toFixed(this.pricePrecision),
        // Blind practice hides WHICH day this is, never what happened in it:
        // the clock stays, the calendar goes. A trader who can read the date off
        // the axis can remember what the session did next, and the point of a
        // blind session is that they cannot.
        timeFormatter: (time: Time) =>
          timeFormatter(this.appearance, this.exchangeZone, { date: !this.datesHidden }).format(
            fromTime(time),
          ),
      },
      ...(zone ? {} : {}),
    };
  }

  /**
   * One tick label on the time axis.
   *
   * Always a string. The date half is dropped in blind practice, and the time
   * half follows the 12/24-hour setting.
   */
  private axisLabel(ms: number): string {
    return timeFormatter(this.appearance, this.exchangeZone, {
      date: false,
    }).format(ms);
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.orderLines.clear();
    this.historyCallbacks.clear();
    this.crosshairCallbacks.clear();
    this.rangeCallbacks.clear();
    this.indicatorSeries.clear();
    this.indicatorGuides.clear();
    this.legendValues.clear();
    this.panes.clear();
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

    const a = this.appearance.symbol;
    const priceFormat = {
      type: 'price' as const,
      precision: this.pricePrecision,
      minMove: this.tickSize,
    };
    const common = {
      priceFormat,
      priceLineVisible: a.lastPriceLineVisible,
      priceScaleId: this.appearance.scales.priceScaleSide === 'LEFT' ? 'left' : 'right',
    };

    switch (this.chartType) {
      case 'BARS':
        this.priceSeries = this.chart.addSeries(BarSeries, {
          ...common,
          upColor: a.upColor,
          downColor: a.downColor,
          thinBars: false,
        });
        break;

      case 'LINE':
      case 'LINE_WITH_MARKERS':
        this.priceSeries = this.chart.addSeries(LineSeries, {
          ...common,
          color: a.lineColor,
          lineWidth: a.lineWidth as 1 | 2 | 3 | 4,
          pointMarkersVisible: this.chartType === 'LINE_WITH_MARKERS',
        });
        break;

      case 'AREA':
        this.priceSeries = this.chart.addSeries(AreaSeries, {
          ...common,
          lineColor: a.lineColor,
          topColor: a.areaTopColor,
          bottomColor: a.areaBottomColor,
          lineWidth: a.lineWidth as 1 | 2 | 3 | 4,
        });
        break;

      case 'BASELINE':
        this.priceSeries = this.chart.addSeries(BaselineSeries, {
          ...common,
          topLineColor: a.upColor,
          topFillColor1: withAlpha(a.upColor, 0.28),
          topFillColor2: withAlpha(a.upColor, 0.03),
          bottomLineColor: a.downColor,
          bottomFillColor1: withAlpha(a.downColor, 0.03),
          bottomFillColor2: withAlpha(a.downColor, 0.28),
        });
        break;

      case 'HOLLOW_CANDLES':
        // Up bars outlined, down bars filled.
        this.priceSeries = this.chart.addSeries(CandlestickSeries, {
          ...common,
          upColor: 'rgba(0,0,0,0)',
          downColor: a.bodyVisible ? a.downColor : 'rgba(0,0,0,0)',
          borderVisible: true,
          borderUpColor: a.borderUpColor,
          borderDownColor: a.borderDownColor,
          wickVisible: a.wickVisible,
          wickUpColor: a.wickUpColor,
          wickDownColor: a.wickDownColor,
        });
        break;

      default:
        this.priceSeries = this.chart.addSeries(CandlestickSeries, {
          ...common,
          upColor: a.bodyVisible ? a.upColor : 'rgba(0,0,0,0)',
          downColor: a.bodyVisible ? a.downColor : 'rgba(0,0,0,0)',
          borderVisible: a.borderVisible,
          borderUpColor: a.borderUpColor,
          borderDownColor: a.borderDownColor,
          wickVisible: a.wickVisible,
          wickUpColor: a.wickUpColor,
          wickDownColor: a.wickDownColor,
        });
    }

    this.priceSeries.priceScale().applyOptions({
      autoScale: this.autoScale && this.appearance.scales.autoScale,
      scaleMargins: {
        top: this.appearance.scales.scaleMarginTop,
        bottom: this.appearance.scales.scaleMarginBottom,
      },
    });
    this.applyScaleMode();
  }

  /** Log / percent / normal, from the appearance rather than a separate toggle. */
  private applyScaleMode(): void {
    const a = this.appearance.scales;
    const mode = a.percentScale
      ? PriceScaleMode.Percentage
      : a.logScale
        ? PriceScaleMode.Logarithmic
        : PriceScaleMode.Normal;
    this.priceSeries?.priceScale().applyOptions({ mode });
  }

  private createVolumeSeries(): void {
    if (!this.chart) return;
    this.volumeSeries = this.chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      visible: this.volumeVisible,
      // Volume has its own hidden scale, so its "last value" would print a
      // meaningless price label on the price axis.
      lastValueVisible: false,
      priceLineVisible: false,
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

  /**
   * Apply a whole appearance.
   *
   * The series is rebuilt only when something structural changed - the candle
   * colours, the scale side. Rebuilding on every keystroke of a colour picker
   * would drop the viewport and flash the chart.
   */
  applyAppearance(appearance: ChartAppearance): void {
    const previous = this.appearance;
    this.appearance = appearance;
    if (!this.chart) return;

    this.chart.applyOptions(this.layoutOptions() as never);

    const structural =
      JSON.stringify(previous.symbol) !== JSON.stringify(appearance.symbol) ||
      previous.scales.priceScaleSide !== appearance.scales.priceScaleSide;
    if (structural) {
      this.createPriceSeries();
      this.volumeVisible = appearance.symbol.volumeVisible;
      this.volumeSeries?.applyOptions({ visible: this.volumeVisible });
      this.redraw();
    } else {
      this.applyScaleMode();
      this.priceSeries?.priceScale().applyOptions({
        autoScale: appearance.scales.autoScale,
        scaleMargins: {
          top: appearance.scales.scaleMarginTop,
          bottom: appearance.scales.scaleMarginBottom,
        },
      });
    }
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
    // Indicators are recomputed from the bars, so the newest one has to reach
    // them. Only when something is actually drawn: with no indicators on the
    // chart this costs nothing, which is the common case.
    if (this.indicatorSeries.size > 0) this.renderIndicators();
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
    this.renderIndicators();
  }

  // -- indicators ----------------------------------------------------------

  /**
   * Replace the indicator set.
   *
   * Panes are allocated in the order the indicators were added, so adding an
   * oscillator does not reshuffle the one already below the chart.
   */
  setIndicators(indicators: readonly IndicatorInstance[]): void {
    this.indicators = [...indicators];

    // Drop the series of anything no longer present.
    const live = new Set(this.indicators.filter((i) => i.visible).map((i) => i.id));
    for (const [key, entry] of [...this.indicatorSeries]) {
      const instanceId = key.slice(0, key.lastIndexOf(':'));
      if (live.has(instanceId)) continue;
      this.chart?.removeSeries(entry.series);
      this.indicatorSeries.delete(key);
      this.legendValues.delete(key);
    }
    for (const [key] of [...this.indicatorGuides]) {
      if (!live.has(key)) this.indicatorGuides.delete(key);
    }

    this.panes.clear();
    let nextPane = 1;
    for (const instance of this.indicators) {
      if (!instance.visible) continue;
      const def = indicatorDef(instance.kind);
      if (!def) continue;
      this.panes.set(instance.id, def.overlay ? 0 : nextPane++);
    }

    this.renderIndicators();
  }

  /**
   * Compute and draw every indicator.
   *
   * The computation happens HERE, from the bars the adapter already holds,
   * which is what keeps a moving average from turning every tick into a React
   * render. It reads bars and writes series; it can never write a bar.
   */
  private renderIndicators(): void {
    if (!this.chart || this.bars.length === 0) return;

    for (const instance of this.indicators) {
      if (!instance.visible) continue;
      const def = indicatorDef(instance.kind);
      if (!def) continue;
      const pane = this.panes.get(instance.id) ?? 0;

      let output;
      try {
        output = def.compute(this.bars, { ...def.defaults, ...instance.params }, {
          pane: def.overlay ? 'PRICE' : pane,
          isSessionStart: (_bar, index) => this.isSessionStart(index),
        });
      } catch {
        // A bad parameter must not take the chart down with it. The indicator
        // simply does not draw, and the trader can fix or remove it.
        continue;
      }

      for (const plot of output.plots) {
        const key = `${instance.id}:${plot.id}`;
        let entry = this.indicatorSeries.get(key);

        if (!entry) {
          const series =
            plot.kind === 'HISTOGRAM'
              ? this.chart.addSeries(
                  HistogramSeries,
                  {
                    color: plot.color,
                    priceLineVisible: false,
                    lastValueVisible: false,
                    priceScaleId: pane === 0 ? 'indicator-overlay' : 'right',
                  },
                  pane,
                )
              : this.chart.addSeries(
                  LineSeries,
                  {
                    color: plot.color,
                    lineWidth: plot.lineWidth as 1 | 2 | 3 | 4,
                    priceLineVisible: false,
                    lastValueVisible: false,
                    crosshairMarkerVisible: false,
                  },
                  pane,
                );
          entry = { series, plot, pane };
          this.indicatorSeries.set(key, entry);

          // An overlaid histogram gets its own hidden scale so it cannot
          // squash the price axis.
          if (plot.kind === 'HISTOGRAM' && pane === 0) {
            this.chart.priceScale('indicator-overlay').applyOptions({
              scaleMargins: { top: 0.82, bottom: 0 },
              visible: false,
            });
          }
        } else {
          entry.series.applyOptions({ color: plot.color } as never);
          entry.plot = plot;
        }

        entry.series.setData(
          plot.points.map((point) => ({
            time: toTime(point.time),
            value: point.value,
            ...(point.color ? { color: point.color } : {}),
          })) as never,
        );

        const last = plot.points[plot.points.length - 1];
        this.legendValues.set(
          key,
          last ? last.value.toFixed(this.legendPrecision(plot)) : '—',
        );
      }

      // Pane guides, e.g. RSI's 30/70. Created once per instance.
      if (output.guides && output.guides.length > 0 && !this.indicatorGuides.has(instance.id)) {
        const host = this.indicatorSeries.get(`${instance.id}:${output.plots[0]?.id ?? ''}`);
        if (host) {
          this.indicatorGuides.set(
            instance.id,
            output.guides.map((guide) =>
              host.series.createPriceLine({
                price: guide.value,
                color: guide.color,
                lineWidth: 1,
                lineStyle: LineStyle.Dotted,
                axisLabelVisible: false,
                title: '',
              }),
            ),
          );
        }
      }
    }
  }

  /** Oscillators read better with fewer decimals than prices. */
  private legendPrecision(plot: Plot): number {
    return plot.kind === 'HISTOGRAM' ? 0 : Math.max(2, this.pricePrecision);
  }

  /**
   * Is this bar the first of a trading session?
   *
   * Decided from the GAP between bars rather than from a session calendar the
   * chart does not have: a jump of more than four times the usual spacing is a
   * break in the data, which for a futures instrument is the daily halt. It is
   * used only to anchor session statistics, never to create a bar.
   */
  private isSessionStart(index: number): boolean {
    if (index === 0) return true;
    const previous = this.bars[index - 1];
    const current = this.bars[index];
    if (!previous || !current) return false;
    const spacing = this.typicalSpacing();
    return spacing > 0 && current.time - previous.time > spacing * 4;
  }

  private typicalSpacing(): number {
    if (this.bars.length < 3) return 0;
    // The median of the first few gaps: robust to the one big gap we are
    // looking for, unlike the mean.
    const gaps: number[] = [];
    for (let i = 1; i < Math.min(this.bars.length, 40); i += 1) {
      gaps.push(this.bars[i]!.time - this.bars[i - 1]!.time);
    }
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)] ?? 0;
  }

  indicatorLegend(): ReadonlyArray<{ id: string; label: string; color: string; value: string }> {
    const out: Array<{ id: string; label: string; color: string; value: string }> = [];
    for (const instance of this.indicators) {
      if (!instance.visible) continue;
      for (const [key, entry] of this.indicatorSeries) {
        if (!key.startsWith(`${instance.id}:`)) continue;
        out.push({
          id: key,
          label: entry.plot.label,
          color: entry.plot.color,
          value: this.legendValues.get(key) ?? '—',
        });
      }
    }
    return out;
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
      color:
        bar.close >= bar.open
          ? this.appearance.symbol.volumeUpColor
          : this.appearance.symbol.volumeDownColor,
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
    const colour = spec.side === 'BUY' ? this.appearance.symbol.upColor : this.appearance.symbol.downColor;
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
          color:
            next.side === 'BUY'
              ? this.appearance.symbol.upColor
              : this.appearance.symbol.downColor,
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
    // Only the crosshair label carries a date; the axis never does, because the
    // tick labels are times. Reapplying the options rebuilds the formatter
    // closure, which reads `datesHidden` when it runs.
    this.chart?.applyOptions(this.layoutOptions() as never);
  }

  /**
   * Pixel geometry for the overlay layers.
   *
   * Recreated on every call rather than cached: the time scale moves whenever
   * the user pans, and a stale projection puts a drawing somewhere the market
   * never was.
   */
  projection(): ChartProjection | null {
    const chart = this.chart;
    const series = this.priceSeries;
    const container = this.container;
    if (!chart || !series || !container) return null;
    const timeScale = chart.timeScale();
    return {
      timeToX: (timeMs) => timeScale.timeToCoordinate(toTime(timeMs)),
      xToTime: (x) => {
        const time = timeScale.coordinateToTime(x);
        if (time !== null) return fromTime(time);
        // Past the last bar there is no time on the scale yet. Extrapolating by
        // the logical index keeps a drawing anchored where the cursor is,
        // without inventing a bar: the anchor is a time, not an observation.
        const logical = timeScale.coordinateToLogical(x);
        const spacing = this.typicalSpacing();
        const last = this.bars[this.bars.length - 1];
        if (logical === null || spacing === 0 || !last) return null;
        return last.time + Math.round(logical - (this.bars.length - 1)) * spacing;
      },
      priceToY: (price) => series.priceToCoordinate(price),
      yToPrice: (y) => series.coordinateToPrice(y),
      // The PLOT's width, not the container's: an overlay that ran to the
      // container edge would paint over the price axis.
      width: Math.max(0, container.clientWidth - this.priceScaleWidth()),
      height: container.clientHeight,
    };
  }

  /**
   * The genuine bar nearest a time.
   *
   * Used by the drawing magnet, which snaps only to prices a bar printed.
   */
  barNear(timeMs: number): NormalizedBar | null {
    if (this.bars.length === 0) return null;
    let low = 0;
    let high = this.bars.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.bars[mid]!.time < timeMs) low = mid + 1;
      else high = mid;
    }
    const at = this.bars[low]!;
    const before = this.bars[low - 1];
    if (!before) return at;
    return Math.abs(at.time - timeMs) <= Math.abs(timeMs - before.time) ? at : before;
  }

  priceScaleWidth(): number {
    const side = this.appearance.scales.priceScaleSide === 'LEFT' ? 'left' : 'right';
    try {
      return this.chart?.priceScale(side).width() ?? 0;
    } catch {
      return 0;
    }
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
