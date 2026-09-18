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
  private container: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private chartType: ChartType = 'CANDLES';
  private timeframe: Timeframe = '1m';
  private pricePrecision = 2;
  /** Blind practice: the clock is shown, the calendar is not. */
  private datesHidden = false;
  private tickSize = 0.25;
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

    this.chart = createChart(init.container, {
      ...this.layoutOptions(),
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: {
        /*
         * The wheel is handled by this adapter, not by the renderer.
         *
         * The built-in behaviour zooms symmetrically about the middle of the
         * view, which is why the chart "zoomed too directly inward": the bar
         * under the cursor slid away while you were trying to look at it, and
         * the newest bar drifted off the right edge. `onWheel` below zooms
         * about the pointer and leaves the right-hand margin where it was.
         */
        mouseWheel: false,
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

    /*
     * The crosshair's own ink.
     *
     * Opacity is applied to the COLOUR rather than to a layer, because the
     * renderer draws the crosshair straight onto the canvas: there is no
     * element to fade. A trader who wants a faint guide gets a faint colour.
     */
    const crosshairInk = withOpacity(a.scales.crosshairColor, a.scales.crosshairOpacity);
    const crosshairWidth = Math.max(1, Math.min(3, Math.round(a.scales.crosshairWidth))) as 1 | 2 | 3;
    const crosshairDash =
      a.scales.crosshairDash === 'SOLID'
        ? LineStyle.Solid
        : a.scales.crosshairDash === 'DOTTED'
          ? LineStyle.Dotted
          : LineStyle.Dashed;

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
        /*
         * Thickness, dash and strength come from the appearance now.
         *
         * They were hard-coded to one pixel dashed, which is a reasonable
         * default and was the only option: a trader who wants a solid hairline
         * or a heavier line on a bright screen could not have one.
         */
        vertLine: {
          color: crosshairInk,
          width: crosshairWidth,
          style: crosshairDash,
          labelBackgroundColor: a.scales.crosshairLabelBackground,
          labelVisible: a.scales.crosshairTimeLabel,
        },
        horzLine: {
          color: crosshairInk,
          width: crosshairWidth,
          style: crosshairDash,
          labelBackgroundColor: a.scales.crosshairLabelBackground,
          labelVisible: a.scales.crosshairPriceLabel,
        },
      },
      /*
       * Auto-scaling is always on.
       *
       * "Hold the range I am looking at" is what turning it off should mean,
       * and this renderer cannot do it: clearing autoScale drops the scale to
       * a default range that flattens the candles into a band at the top of
       * the pane, and holding a range through the series' range provider
       * fights the renderer's own scaling and does the same. Rather than ship
       * a control that visibly breaks the chart, the control is not offered -
       * see docs/rebuild-plan.md. Reset scale remains.
       */
      rightPriceScale: {
        visible: a.scales.priceScaleVisible && a.scales.priceScaleSide === 'RIGHT',
        borderColor: a.scales.scaleLineColor,
        scaleMargins: { top: a.scales.scaleMarginTop, bottom: a.scales.scaleMarginBottom },
        autoScale: true,
      },
      leftPriceScale: {
        visible: a.scales.priceScaleVisible && a.scales.priceScaleSide === 'LEFT',
        borderColor: a.scales.scaleLineColor,
        scaleMargins: { top: a.scales.scaleMarginTop, bottom: a.scales.scaleMarginBottom },
        autoScale: true,
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
    this.container?.removeEventListener('wheel', this.onWheel);
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
    // The cached projection closes over the chart, so it goes with it.
    this.projectionCache = null;
    this.spacingCache = null;
    this.bars = [];
    this.byTime.clear();
  }

  resize(): void {
    if (!this.chart || !this.container) return;
    const { clientWidth, clientHeight } = this.container;
    if (clientWidth > 0 && clientHeight > 0) this.chart.resize(clientWidth, clientHeight);
    // The overlays measure the plot through the projection, so the new size
    // has to be there before the next frame paints.
    this.refreshGeometry();
  }

  // -- series construction -------------------------------------------------

  private createPriceSeries(): void {
    if (!this.chart) return;
    if (this.priceSeries) {
      this.chart.removeSeries(this.priceSeries);
      this.priceSeries = null;
    }

    /*
     * The cached projection closes over the price series, so it dies with it.
     *
     * This was a silent, total failure of the drawing engine: changing the
     * chart type - or any appearance setting structural enough to rebuild the
     * series, which includes the candle colours and the scale side - left
     * `yToPrice` asking a REMOVED series for a price. It answers null, an
     * anchor needs both a time and a price, so every placement was refused
     * and no drawing ever appeared. Nothing threw, and the tool still armed.
     */
    this.projectionCache = null;

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
      autoScale: true,
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
    /*
     * NO BUILT-IN VOLUME SERIES.
     *
     * Volume used to be welded to the price pane and on by default, which made
     * it the one study a trader could not remove, could not restyle and could
     * not give a pane of its own. It is a first-class indicator now - Indicators
     * -> Volume - so it arrives, leaves, restyles and persists through exactly
     * the same path as every other study, per chart.
     */
  }

  /**
   * The wheel, as a trader expects it.
   *
   * Plain wheel zooms about the POINTER: the bar under the cursor is the one
   * you are looking at, so it stays where it is and the rest of the view
   * expands or contracts around it. Zooming with the pointer near the right
   * edge therefore keeps the newest bar and its margin in place, which is the
   * right-offset behaviour a symmetrical zoom loses.
   *
   * Shift scrolls sideways through time instead, in whole bars, which is how
   * every charting package treats shift-wheel.
   *
   * The step is multiplicative and small (about 10% per notch, scaled by the
   * browser's own delta) so a flick of the wheel is a nudge rather than a
   * jump. A trackpad's fine-grained deltas come through proportionally.
   */
  private readonly onWheel = (event: WheelEvent): void => {
    const chart = this.chart;
    const container = this.container;
    if (!chart || !container) return;

    const timeScale = chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (!range) return;

    event.preventDefault();

    const span = range.to - range.from;
    if (span <= 0) return;

    // Horizontal intent: shift-wheel, or a trackpad's sideways gesture.
    const sideways = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (sideways) {
      const delta = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
      const bars = (delta / 120) * Math.max(1, Math.round(span * 0.06));
      timeScale.setVisibleLogicalRange({ from: range.from + bars, to: range.to + bars });
      return;
    }

    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const anchor = timeScale.coordinateToLogical(x);
    if (anchor === null) return;

    /*
     * A notch is 120 in the browser's units. `zoom` is how much of the current
     * span survives: a notch forward keeps 92% of it, a notch back stretches
     * it to 109%. Clamped, so a violent scroll cannot invert the range.
     */
    const notches = Math.max(-4, Math.min(4, event.deltaY / 120));
    const zoom = Math.exp(notches * 0.09);
    const nextSpan = Math.max(6, Math.min(4_000, span * zoom));
    if (nextSpan === span) return;

    // The pointer's position within the view is preserved, which is what keeps
    // the bar under the cursor under the cursor.
    const ratio = (anchor - range.from) / span;
    const from = anchor - ratio * nextSpan;
    timeScale.setVisibleLogicalRange({ from, to: from + nextSpan });
  };

  private wireEvents(): void {
    if (!this.chart || !this.container) return;

    // Passive false: this handler prevents the page from scrolling.
    this.container.addEventListener('wheel', this.onWheel, { passive: false });

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

    // Freeze, or release, before anything is applied.
    const structural =
      JSON.stringify(previous.symbol) !== JSON.stringify(appearance.symbol) ||
      previous.scales.priceScaleSide !== appearance.scales.priceScaleSide;
    if (structural) {
      this.createPriceSeries();
      this.redraw();
    } else {
      this.applyScaleMode();
      this.priceSeries?.priceScale().applyOptions({
        autoScale: true,
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
    /*
     * A live bar UPDATES a series. It never creates one.
     *
     * History decides what the chart holds, including that it holds nothing.
     * Letting a single streamed bar establish the series meant that one bar
     * left over from the previous market could rebuild the chart around
     * itself: a cleared chart came back as a single candle at 29673 with the
     * price scale auto-fitted to a six-point range, while the position it was
     * supposed to be showing was marked at 29462. A drag across that chart
     * then priced a target 842 ticks away.
     *
     * Dropping it costs nothing: the panel asks for history again as soon as a
     * source that had nothing starts producing, and that history contains this
     * bar.
     */
    if (this.bars.length === 0) return;

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
    /*
     * Indicators are recomputed from the bars, so the newest one has to reach
     * them - but only its newest POINT has to reach the renderer.
     *
     * Replacing the whole series on every live bar made the chart library
     * re-validate every point it held, which a CPU profile showed as the
     * largest cost of a live market: setSeriesData, checkItemsAreOrdered and
     * checkSeriesValuesType at the top of the profile while the trader was
     * only moving the mouse. The arithmetic is still done over the full
     * series - so the value is exact, not a tail approximation - and only the
     * last point is handed over.
     */
    if (this.indicatorSeries.size > 0) this.renderIndicators({ tailOnly: true });
  }

  private reindex(): void {
    this.byTime.clear();
    for (let i = 0; i < this.bars.length; i += 1) this.byTime.set(this.bars[i]!.time, i);
  }

  private redraw(): void {
    if (!this.priceSeries) return;
    const transformed = transformFor(this.chartType)(this.bars);
    this.priceSeries.setData(transformed.map((b) => this.toSeriesPoint(b)));
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
    this.balancePanes();
  }

  /**
   * Give the price pane most of the height, whatever is below it.
   *
   * The renderer splits panes evenly by default, so one oscillator takes half
   * the chart. A fixed factor of four was better but still not enough: with
   * four oscillators the price pane was down to half the height, and the price
   * is what is being traded. The share now GROWS with the number of indicator
   * panes, so the price keeps about three quarters of the chart whether there
   * is one oscillator under it or four.
   */
  private balancePanes(): void {
    if (!this.chart) return;
    try {
      const panes = this.chart.panes();
      const below = Math.max(1, panes.length - 1);
      for (let i = 0; i < panes.length; i += 1) {
        panes[i]?.setStretchFactor(i === 0 ? below * 3 : 1);
      }
    } catch {
      // A renderer without pane stretching still draws correctly, just with
      // the default split.
    }
  }

  /**
   * Compute and draw every indicator.
   *
   * The computation happens HERE, from the bars the adapter already holds,
   * which is what keeps a moving average from turning every tick into a React
   * render. It reads bars and writes series; it can never write a bar.
   */
  private renderIndicators(options: { tailOnly?: boolean } = {}): void {
    if (!this.chart) return;

    /*
     * No bars, no indicators.
     *
     * Returning early here used to leave every indicator series holding what
     * it last computed, which is fine while the chart is merely waiting and
     * wrong the moment the bars were cleared because the MARKET changed. A
     * replay that has not emitted yet would clear the candles and keep the
     * live session's moving average on the screen - and the price scale it
     * implied, which put a replay-era position marker off the bottom of the
     * chart. The series are kept, because their panes are the layout; what
     * they hold is emptied.
     */
    if (this.bars.length === 0) {
      for (const [key, entry] of this.indicatorSeries) {
        entry.series.setData([]);
        // The legend says "no value", not the value from the market that was
        // being shown a moment ago.
        this.legendValues.set(key, '—');
      }
      // A pane guide - RSI's 30 and 70 - is a reference level rather than a
      // reading, so it stays where it is.
      return;
    }

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
        // A series created in this pass has no data yet, so it needs the whole
        // set however this method was called.
        const fresh = entry === undefined;

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
                    // Colour, thickness and dash all come from the instance's
                    // own parameters, so two moving averages can be told
                    // apart by weight as well as by hue.
                    color: withOpacity(plot.color, plot.opacity),
                    lineWidth: plot.lineWidth as 1 | 2 | 3 | 4,
                    lineStyle: dashOf(plot.lineStyle),
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
          entry.series.applyOptions({
            color: withOpacity(plot.color, plot.opacity),
            lineWidth: plot.lineWidth,
            lineStyle: dashOf(plot.lineStyle),
          } as never);
          entry.plot = plot;
        }

        const asPoint = (point: (typeof plot.points)[number]) => ({
          time: toTime(point.time),
          value: point.value,
          ...(point.color ? { color: point.color } : {}),
        });

        const newest = plot.points[plot.points.length - 1];
        if (options.tailOnly && !fresh && newest) {
          // The renderer takes a point at or after the last one it holds,
          // which is exactly what a live bar produces.
          entry.series.update(asPoint(newest) as never);
        } else {
          entry.series.setData(plot.points.map(asPoint) as never);
        }

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

  /** Median bar gap, recomputed only when the series changes. */
  private spacingCache: { count: number; first: number; value: number } | null = null;

  private typicalSpacing(): number {
    if (this.bars.length < 3) return 0;
    const cached = this.spacingCache;
    if (cached && cached.count === this.bars.length && cached.first === this.bars[0]!.time) {
      return cached.value;
    }
    // The median of the first few gaps: robust to the one big gap we are
    // looking for, unlike the mean.
    const gaps: number[] = [];
    for (let i = 1; i < Math.min(this.bars.length, 40); i += 1) {
      gaps.push(this.bars[i]!.time - this.bars[i - 1]!.time);
    }
    gaps.sort((a, b) => a - b);
    const value = gaps[Math.floor(gaps.length / 2)] ?? 0;
    this.spacingCache = { count: this.bars.length, first: this.bars[0]!.time, value };
    return value;
  }

  /**
   * The legend, optionally AT a bar rather than at the end of the series.
   *
   * With a crosshair over the chart a trader is reading that bar, so the
   * indicator values beside it have to be that bar's values. Without one they
   * are the newest, which is what a live chart shows.
   *
   * `instanceId` comes back with each row so the legend can group its rows by
   * indicator - one row per instance, the way every charting package lists
   * them - rather than printing one long line.
   */
  indicatorLegend(
    atTimeMs?: number | null,
  ): ReadonlyArray<{
    id: string;
    instanceId: string;
    label: string;
    color: string;
    value: string;
  }> {
    const out: Array<{
      id: string;
      instanceId: string;
      label: string;
      color: string;
      value: string;
    }> = [];
    for (const instance of this.indicators) {
      if (!instance.visible) continue;
      for (const [key, entry] of this.indicatorSeries) {
        if (!key.startsWith(`${instance.id}:`)) continue;
        const value =
          atTimeMs === undefined || atTimeMs === null
            ? (this.legendValues.get(key) ?? '—')
            : this.valueAt(entry.plot, atTimeMs);
        out.push({
          id: key,
          instanceId: instance.id,
          label: entry.plot.label,
          color: entry.plot.color,
          value,
        });
      }
    }
    return out;
  }

  /**
   * Where each indicator instance's pane sits, in pixels from the top of the
   * plot.
   *
   * The legend row for an oscillator belongs at the top left of ITS pane, not
   * stacked over the candles with the moving averages. Only the renderer knows
   * how tall each pane ended up, so it is asked every frame rather than
   * guessed at.
   */
  indicatorPanes(): ReadonlyArray<{
    instanceId: string;
    pane: number;
    top: number;
    height: number;
  }> {
    const chart = this.chart;
    if (!chart) return [];
    const tops: number[] = [];
    const heights: number[] = [];
    try {
      const panes = chart.panes();
      let top = 0;
      for (let i = 0; i < panes.length; i += 1) {
        const height = panes[i]?.getHeight() ?? 0;
        tops.push(top);
        heights.push(height);
        // The separator between panes is one pixel of chrome, not plot.
        top += height + 1;
      }
    } catch {
      // A renderer without pane geometry keeps every row on the price pane.
      return this.indicators.map((instance) => ({
        instanceId: instance.id,
        pane: 0,
        top: 0,
        height: 0,
      }));
    }
    return this.indicators.map((instance) => {
      const pane = this.panes.get(instance.id) ?? 0;
      return {
        instanceId: instance.id,
        pane,
        top: tops[pane] ?? 0,
        height: heights[pane] ?? 0,
      };
    });
  }

  /** One plot's value at a bar time, formatted. Bisected: the points are sorted. */
  private valueAt(plot: Plot, timeMs: number): string {
    const points = plot.points;
    if (points.length === 0) return '—';
    let low = 0;
    let high = points.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const at = points[mid]!.time;
      if (at === timeMs) return points[mid]!.value.toFixed(this.legendPrecision(plot));
      if (at < timeMs) low = mid + 1;
      else high = mid - 1;
    }
    // No point at that bar: the indicator has no value there (a warm-up
    // period, or a gap). Saying nothing is correct; interpolating is not.
    return '—';
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

  // -- view controls -------------------------------------------------------

  setSessionBreaksVisible(): void {
    // Session gaps are inherent: bars simply do not exist during the break, so
    // the gap is already visible. Explicit shading arrives with the drawing
    // layer in Milestone 4.
  }

  fitContent(): void {
    this.chart?.timeScale().fitContent();
  }

  /**
   * The view a chart should OPEN on.
   *
   * `fitContent` puts every loaded bar on screen, which for two thousand
   * one-minute bars is a wall of hairlines about one pixel apart - the chart
   * opened looking like a heart-rate trace rather than like candles. A trader
   * opens a chart on the recent session at a spacing where a candle is a
   * candle, and scrolls back for history.
   *
   * `bars` is how many to show; the newest bar keeps a small margin on the
   * right, the way every charting package leaves room for price to move into.
   */
  showRecent(bars = 180): void {
    const chart = this.chart;
    if (!chart || this.bars.length === 0) return;
    const timeScale = chart.timeScale();
    const count = Math.min(bars, this.bars.length);
    const last = this.bars.length - 1;
    const margin = Math.max(2, Math.round(count * 0.04));
    timeScale.setVisibleLogicalRange({ from: last - count + 1, to: last + margin });
  }

  scrollToRealtime(): void {
    this.chart?.timeScale().scrollToRealTime();
  }

  resetScale(): void {
    this.chart?.timeScale().resetTimeScale();
    // Resetting the scales releases a pinned range: "reset" that left the axis
    // frozen would not be a reset.
    this.priceSeries?.priceScale().applyOptions({ autoScale: true });
    this.autoScale = true;
  }

  setAutoScale(enabled: boolean): void {
    // Kept for the adapter interface; see the note on rightPriceScale.
    this.autoScale = enabled;
  }

  goToTime(time: number): void {
    const timeScale = this.chart?.timeScale();
    if (!timeScale) return;
    const index = this.bars.findIndex((b) => b.time >= time);
    if (index < 0) return;
    timeScale.setVisibleLogicalRange({ from: index - 60, to: index + 60 });
  }

  /**
   * Show the same window of TIME as another chart.
   *
   * Time, not bar index: two panes on different intervals have different bars,
   * and a logical range copied between them means nothing. `setVisibleRange`
   * on a time the series has no bar for is refused by the renderer, so the
   * nearest bars are found and the logical range is set instead.
   */
  setVisibleTimeRange(fromMs: number, toMs: number): void {
    const timeScale = this.chart?.timeScale();
    if (!timeScale || this.bars.length === 0) return;
    const from = this.timeToIndexInternal(fromMs);
    const to = this.timeToIndexInternal(toMs);
    if (from === null || to === null || to <= from) return;
    try {
      timeScale.setVisibleLogicalRange({ from, to });
    } catch {
      // A range the renderer will not accept is simply not applied; the pane
      // keeps the view it had rather than throwing during a pan.
    }
  }

  /**
   * Put the crosshair on a given time, as if the pointer were there.
   *
   * Used to follow another pane's crosshair. Null clears it, so a pointer
   * leaving one chart does not leave a phantom crosshair on the others.
   */
  showCrosshairAt(timeMs: number | null): void {
    const chart = this.chart;
    const series = this.priceSeries;
    if (!chart || !series) return;
    if (timeMs === null) {
      chart.clearCrosshairPosition();
      return;
    }
    const bar = this.barNear(timeMs);
    if (!bar) return;
    chart.setCrosshairPosition(bar.close, toTime(bar.time), series);
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
  /**
   * The projection object, built once.
   *
   * Four separate animation-frame loops ask for a projection, so building a
   * fresh object with six closures on every call meant a few hundred
   * allocations a second and showed up as real time in a CPU profile. The
   * closures only read the adapter, so one object serves for the life of the
   * chart; the two values that are not closures are refreshed on each call.
   */
  private projectionCache: ChartProjection | null = null;
  private geometryAt = 0;

  /** Re-read the plot's size now. Called when the container resizes. */
  private refreshGeometry(): void {
    const cached = this.projectionCache;
    const container = this.container;
    if (!cached || !container) return;
    this.geometryAt = performance.now();
    const mutable = cached as { width: number; height: number };
    mutable.width = Math.max(0, container.clientWidth - this.priceScaleWidth());
    mutable.height = container.clientHeight;
  }

  projection(): ChartProjection | null {
    const chart = this.chart;
    const series = this.priceSeries;
    const container = this.container;
    if (!chart || !series || !container) return null;

    const cached = this.projectionCache;
    if (cached) {
      /*
       * The plot's size is re-read at most every quarter second.
       *
       * clientWidth and clientHeight force layout, and priceScaleWidth asks
       * the renderer to measure its axis; four animation-frame loops call this
       * every frame, which showed up in a CPU profile as one of the largest
       * pieces of application JavaScript during a mouse sweep. A resize
       * refreshes it immediately (see the observer in mount); the timer is
       * only there to notice the axis widening when a price gains a digit.
       */
      const now = performance.now();
      if (now - this.geometryAt > 250) {
        this.geometryAt = now;
        const mutable = cached as { width: number; height: number };
        mutable.width = Math.max(0, container.clientWidth - this.priceScaleWidth());
        mutable.height = container.clientHeight;
      }
      return cached;
    }

    const timeScale = chart.timeScale();
    this.projectionCache = {
      /**
       * A time to a pixel, INCLUDING times outside the loaded series.
       *
       * The renderer maps only times it has bars for, so anything to the right
       * of the last bar - the empty space traders draw projections and target
       * lines into - came back null, and the drawing silently never painted.
       * Outside the series the position is computed from the logical index
       * instead, at the series' own spacing. No bar is invented: the anchor is
       * a time, and this is where that time would sit.
       */
      timeToX: (timeMs) => {
        const direct = timeScale.timeToCoordinate(toTime(timeMs));
        if (direct !== null) return direct;
        /*
         * A time the series has no bar for - between two bars, or out in the
         * empty space to the right where projections are drawn.
         *
         * Positioned through the bar INDEX, never by extrapolating uniform
         * time. A chart lays bars out by index, so a uniform-time estimate
         * disagrees with the layout by however uneven the bars are, and the
         * disagreement CHANGES as the view moves - which is exactly the
         * visual drift a drawing must never have. timeToIndex interpolates
         * between the neighbouring bars and continues at the median spacing
         * past either end, so this agrees with the layout at every zoom.
         */
        const index = this.timeToIndexInternal(timeMs);
        if (index === null) return null;
        return timeScale.logicalToCoordinate(index as never);
      },
      xToTime: (x) => {
        const time = timeScale.coordinateToTime(x);
        if (time !== null) return fromTime(time);
        // The same arithmetic in reverse, so a drawing placed in the empty
        // space lands exactly where the cursor was.
        const logical = timeScale.coordinateToLogical(x);
        if (logical === null) return null;
        return this.indexToTimeInternal(logical as unknown as number);
      },
      priceToY: (price) => series.priceToCoordinate(price),
      yToPrice: (y) => series.coordinateToPrice(y),

      /*
       * Index conversions.
       *
       * Fractional on purpose: a drag of half a bar should be half a bar, and
       * rounding belongs to whoever is using the number. Past either end of
       * the series the index continues at the median bar spacing, which is the
       * same rule timeToX uses, so the two agree about where a time sits.
       */
      xToIndex: (x) => {
        const logical = timeScale.coordinateToLogical(x);
        return logical === null ? null : (logical as unknown as number);
      },
      indexToTime: (index) => this.indexToTimeInternal(index),
      timeToIndex: (timeMs) => this.timeToIndexInternal(timeMs),
      width: Math.max(0, container.clientWidth - this.priceScaleWidth()),
      height: container.clientHeight,
    };
    return this.projectionCache;
  }

  /** A bar index to the time of the bar it lands on. Fractional in, whole out. */
  private indexToTimeInternal(index: number): number | null {
    if (this.bars.length === 0) return null;
    const first = this.bars[0]!;
    const last = this.bars[this.bars.length - 1]!;
    const spacing = this.typicalSpacing();
    if (index <= 0) {
      return spacing === 0 ? first.time : first.time + Math.round(index) * spacing;
    }
    if (index >= this.bars.length - 1) {
      return spacing === 0
        ? last.time
        : last.time + Math.round(index - (this.bars.length - 1)) * spacing;
    }
    // Between two bars: the nearer one, because a drawing anchors to a bar
    // that exists rather than to a moment between two of them.
    const low = Math.floor(index);
    const high = Math.ceil(index);
    return (index - low <= 0.5 ? this.bars[low] : this.bars[high])?.time ?? null;
  }

  /**
   * A time to a fractional bar index.
   *
   * Interpolated between the bars either side of it, and continued at the
   * median spacing beyond either end. This is the function that keeps a
   * drawing pinned: every pixel position is derived from it, so an anchor is
   * effectively stored against the series rather than against the clock.
   */
  private timeToIndexInternal(timeMs: number): number | null {
    if (this.bars.length === 0) return null;
    const first = this.bars[0]!;
    const last = this.bars[this.bars.length - 1]!;
    const spacing = this.typicalSpacing();
    if (timeMs <= first.time) {
      return spacing === 0 ? 0 : (timeMs - first.time) / spacing;
    }
    if (timeMs >= last.time) {
      return spacing === 0
        ? this.bars.length - 1
        : this.bars.length - 1 + (timeMs - last.time) / spacing;
    }
    let low = 0;
    let high = this.bars.length - 1;
    while (low < high - 1) {
      const mid = (low + high) >> 1;
      if (this.bars[mid]!.time <= timeMs) low = mid;
      else high = mid;
    }
    const span = this.bars[high]!.time - this.bars[low]!.time;
    return span === 0 ? low : low + (timeMs - this.bars[low]!.time) / span;
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

  viewDiagnostics(
    xPixels?: number,
    price?: number,
  ): {
    from: number;
    to: number;
    span: number;
    barSpacing: number;
    logicalAtX: number | null;
    priceRange: number | null;
    /** Where a given price sits, in pixels from the top of the plot. */
    yAtPrice: number | null;
  } | null {
    const chart = this.chart;
    const container = this.container;
    if (!chart || !container) return null;
    const timeScale = chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (!range) return null;
    const top = this.yToPrice(0);
    const bottom = this.yToPrice(container.clientHeight);
    return {
      from: range.from,
      to: range.to,
      span: range.to - range.from,
      barSpacing: timeScale.options().barSpacing,
      logicalAtX:
        xPixels === undefined
          ? null
          : ((timeScale.coordinateToLogical(xPixels) as number | null) ?? null),
      priceRange: top === null || bottom === null ? null : Math.abs(top - bottom),
      yAtPrice: price === undefined ? null : this.priceToY(price),
    };
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

/**
 * A colour with an opacity applied, for a renderer that has no alpha of its
 * own. Hex in, rgba out; anything already functional is left alone.
 */
function withOpacity(color: string, opacity: number): string {
  const alpha = Math.max(0, Math.min(1, opacity));
  if (alpha >= 0.999) return color;
  const hex = color.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!short && !long) return color;
  const parts = short
    ? [short[1]!, short[2]!, short[3]!].map((c) => parseInt(c + c, 16))
    : [long![1]!, long![2]!, long![3]!].map((c) => parseInt(c, 16));
  return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha.toFixed(3)})`;
}

/** A plot's dash setting, in the renderer's own terms. */
function dashOf(style: 'SOLID' | 'DASHED' | 'DOTTED'): LineStyle {
  return style === 'DASHED' ? LineStyle.Dashed : style === 'DOTTED' ? LineStyle.Dotted : LineStyle.Solid;
}
