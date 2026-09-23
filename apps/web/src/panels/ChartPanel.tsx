import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { NormalizedBar, Timeframe } from '@atlas/contracts';
import { useSession, activeInstrument } from '../state/session';
import { LightweightChartsAdapter } from '../chart/LightweightChartsAdapter';
import { marketStream } from '../market/stream';
import { clientLatency } from '../market/latency';
import { fetchBars, fetchSymbolStatus, type FreshnessInfo } from '../market/api';
import { ChartLegend } from './ChartLegend';
import { ChartHeader } from '../chart/ChartHeader';
import { PriceMarkers } from '../chart/PriceMarkers';
import { DrawingCanvas } from '../chart/drawings/DrawingCanvas';
import { BoundsCache } from '../chart/drawings/bounds';
import { useDrawingInput, type ContextMenuRequest } from '../chart/drawings/useDrawingInput';
import { DrawingStyleBar } from '../chart/drawings/DrawingStyleBar';
import { DrawingContextMenu } from '../chart/drawings/DrawingContextMenu';
import { DrawingProperties } from '../chart/drawings/DrawingProperties';
import { MarketMotion } from '../chart/motion';
import { useMotion } from '../state/motion-store';
import { useChartStore } from '../state/chart-store';
import { useLayout } from '../state/layout-store';
import { useWorkspace } from '../state/workspace';
import { ChartMenu, type ChartMenuItem } from '../chart/ChartMenu';
import type { IndicatorInstance } from '../chart/indicators/registry';
import {
  onCrosshairSync,
  onRangeSync,
  publishCrosshair,
  publishRange,
  recordCrosshairApplied,
  recordRangeApplied,
  syncDiagnostics,
  whileApplying,
} from '../chart/pane-sync';
import { useTraining } from '../state/training';
import { useReplayStatus } from '../state/replay-status';
import { resolveZone, timeFormatter } from '../chart/appearance';
import { Icon } from '../ui/Icon';
import { IndicatorRows } from '../chart/IndicatorRows';
import { IndicatorSettings } from '../chart/IndicatorSettings';
import { saveError, usePersistence } from '../state/persistence-status';
import './ChartPanel.css';

/** One frozen empty list, so a pane with no indicators is a stable reference. */
const EMPTY_INDICATORS: readonly IndicatorInstance[] = [];

/** How often an empty chart may ask for history again, in milliseconds. */
const EMPTY_RELOAD_MS = 1_500;

const INITIAL_BARS = 1_200;
const PAGE_BARS = 1_000;

/**
 * The chart.
 *
 * React owns the chrome - symbol, interval, style, status. It does NOT own the
 * price data: bars arrive on the market stream and go straight into the chart
 * adapter and the legend, so a tick costs one canvas update and a few text
 * nodes rather than a component tree render. The two overlay layers, markers
 * and drawings, keep the same discipline: both place themselves in an
 * animation frame.
 */
export interface ChartPanelProps {
  /**
   * The pane this chart is. One chart is still a pane, so there is exactly one
   * code path whether the layout shows one chart or four.
   */
  readonly paneId?: string;
  /** True when this is the chart the terminal's keystrokes belong to. */
  readonly active?: boolean;
  readonly onActivate?: (() => void) | undefined;
  readonly onMaximize?: (() => void) | undefined;
  readonly maximized?: boolean;
}

export function ChartPanel({
  paneId = 'p1',
  active = true,
  onActivate,
  onMaximize,
  maximized = false,
}: ChartPanelProps = {}): JSX.Element {
  const terminalSymbol = useSession((s) => s.activeSymbol);
  const pane = useLayout((s) => s.panes.find((item) => item.id === paneId) ?? null);
  /*
   * A pane with no symbol of its own follows the terminal's.
   *
   * That is what keeps the first chart and the order ticket pointed at the
   * same instrument: a chart that silently disagreed with the ticket beside it
   * would be a way to lose money.
   */
  const activeSymbol = pane?.symbol ?? terminalSymbol;
  const instrument = useSession(
    (s) => s.instruments.find((i) => i.root === activeSymbol) ?? null,
  );

  const timeframe = (pane?.timeframe ?? '1m') as Timeframe;
  const setPaneTimeframe = useLayout((s) => s.setPaneTimeframe);
  const setPaneSymbol = useLayout((s) => s.setPaneSymbol);
  const setTimeframe = useCallback(
    (next: Timeframe) => setPaneTimeframe(paneId, next),
    [paneId, setPaneTimeframe],
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const persistError = usePersistence(saveError);
  const [barCount, setBarCount] = useState(0);
  const [historyNote, setHistoryNote] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<FreshnessInfo | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [chartReady, setChartReady] = useState(false);
  /** The crosshair's bar time, for the indicator rows. */
  const hoverTimeRef = useRef<number | null>(null);
  /** Which indicator instance has its settings open. Shared with the header,
   *  which opens the panel for an indicator the moment it is added. */
  const indicatorSettings = useLayout((s) => s.indicatorSettingsFor);
  const setIndicatorSettings = useLayout((s) => s.openIndicatorSettings);
  /** Whose settings panel it is: only the pane that owns it renders it. */
  const settingsPane = useLayout((s) =>
    s.indicatorSettingsFor ? (s.paneOf(s.indicatorSettingsFor)?.id ?? null) : null,
  );

  const motionSettings = useMotion((s) => s.settings);
  const appearance = useChartStore((s) => s.appearance);
  const chartType = pane?.chartType ?? 'CANDLES';
  const indicators = pane?.indicators ?? EMPTY_INDICATORS;
  const paneSplit = pane?.paneSplit ?? null;
  const showDates = useTraining((s) => s.visibility.dateTime);
  const chartFocus = useSession((s) => s.chartFocus);
  /*
   * Which market the terminal is routed through.
   *
   * Switching between the live feed and a replay changes what the history
   * endpoint returns, so the series has to be reloaded - otherwise leaving a
   * replay leaves its handful of bars on the chart with the live feed ticking
   * into them.
   */
  const routedToReplay = useReplayStatus((s) => s.isReplay);
  const replayCursor = useReplayStatus((s) => s.cursor);

  const containerRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<LightweightChartsAdapter | null>(null);
  const legendRef = useRef<ChartLegend | null>(null);
  const loadTokenRef = useRef(0);
  /**
   * The timeframe the loaded series belongs to.
   *
   * Loading history is asynchronous but subscribing is not, so after a
   * timeframe switch the new stream can deliver bars while the chart still
   * holds the old timeframe's series. A 1D bucket time is also a valid 1m
   * bucket time, so such a bar would silently corrupt an interior candle
   * rather than being rejected as stale. Nothing is applied until the series
   * and the stream agree on what they are showing.
   */
  const seriesTimeframeRef = useRef<Timeframe | null>(null);
  /**
   * Bumped to ask for history again - see the stream handler, which does it
   * when a source that answered empty starts producing bars.
   */
  const [historyEpoch, setHistoryEpoch] = useState(0);
  const emptyReloadRef = useRef(-Infinity);
  /**
   * What the series currently holds, so an empty reload can be recognised -
   * INCLUDING which market data source it came from, because an empty reload
   * from a different source is not the same event as an empty reload from the
   * same one.
   */
  const loadedSeriesRef = useRef<{
    symbol: string;
    timeframe: Timeframe;
    provider: string;
  } | null>(null);
  /**
   * The visual motion layer.
   *
   * It sits between the stream and the renderer and touches nothing else: the
   * legend, the engine and every calculation read genuine observations.
   */
  const motionRef = useRef<MarketMotion>(new MarketMotion());
  /** Live drawing gesture state, shared between the input machine and the canvas. */
  /*
   * One bounds cache, shared by the canvas that paints the drawings and the
   * input machine that hit-tests them, so a pointer move never re-projects
   * geometry the frame has already projected.
   */
  const boundsRef = useRef<BoundsCache>(new BoundsCache());
  /**
   * Whether a live bar has arrived since the last history load.
   *
   * The history note can say things that stop being true - "the replay has not
   * emitted any bars yet" is the obvious one - so the first genuine bar clears
   * it rather than leaving a stale sentence on the chart.
   */
  const sawLiveBarRef = useRef(false);

  // Legend DOM targets, written to directly rather than through React.
  const priceRef = useRef<HTMLSpanElement>(null);
  const changeRef = useRef<HTMLSpanElement>(null);
  const openRef = useRef<HTMLSpanElement>(null);
  const highRef = useRef<HTMLSpanElement>(null);
  const lowRef = useRef<HTMLSpanElement>(null);
  const closeRef = useRef<HTMLSpanElement>(null);
  const volumeRef = useRef<HTMLSpanElement>(null);
  const barTimeRef = useRef<HTMLSpanElement>(null);
  const updatedRef = useRef<HTMLSpanElement>(null);

  const precision = instrument?.pricePrecision ?? 2;
  const tickSize = instrument?.tickSize ?? 0.25;
  const exchangeZone = instrument?.sessionTimezone ?? 'America/Chicago';
  const timeZone = resolveZone(appearance, exchangeZone);
  const statusLine = appearance.statusLine;
  /*
   * The status line wraps when the pane is narrow - two charts side by side
   * with the journal open puts the OHLC on its own row - and the indicator
   * legend has to start below whatever height that turned out to be.
   */
  const statusRef = useRef<HTMLDivElement>(null);

  // -- mount the chart once ------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const adapter = new LightweightChartsAdapter();
    adapter.mount({
      container,
      pricePrecision: precision,
      tickSize,
      timeZone: exchangeZone,
      appearance: useChartStore.getState().appearance,
    });
    adapterRef.current = adapter;
    setChartReady(true);

    const legend = new ChartLegend(
      {
        price: priceRef.current!,
        change: changeRef.current!,
        open: openRef.current!,
        high: highRef.current!,
        low: lowRef.current!,
        close: closeRef.current!,
        volume: volumeRef.current!,
        barTime: barTimeRef.current!,
        updatedAt: updatedRef.current!,
      },
      { precision, timeZone },
    );
    legendRef.current = legend;

    /*
     * A measurement hook, not a feature.
     *
     * Whether the wheel "feels right" comes down to the visible logical range,
     * the bar spacing and whether the bar under the cursor stays put. A test
     * that cannot read those can only assert that a screenshot changed, so the
     * chart's own geometry is readable from the page.
     */
    if (paneId === 'p1') {
      (window as unknown as { __atlasChartView?: unknown }).__atlasChartView = (
        x?: number,
        price?: number,
      ) => adapterRef.current?.viewDiagnostics(x, price) ?? null;
      (window as unknown as { __atlasPaneSync?: unknown }).__atlasPaneSync = () =>
        syncDiagnostics();
      (window as unknown as { __atlasIndicatorCost?: unknown }).__atlasIndicatorCost = () =>
        (
          adapterRef.current as unknown as {
            indicatorCost?: () => unknown;
          } | null
        )?.indicatorCost?.() ?? null;
      (window as unknown as { __atlasIndicators?: unknown }).__atlasIndicators = () =>
        (
          adapterRef.current as unknown as {
            indicatorDiagnostics?: () => unknown;
          } | null
        )?.indicatorDiagnostics?.() ?? null;
    }
    // The legend is built once, after the mask may already have been chosen, so
    // it is told immediately rather than waiting for the mask to change again.
    legend.setDatesHidden(!useTraining.getState().visibility.dateTime);
    adapter.setDatesHidden(!useTraining.getState().visibility.dateTime);
    const mounted = useLayout.getState().panes.find((item) => item.id === paneId);
    adapter.setChartType(mounted?.chartType ?? 'CANDLES');
    adapter.setIndicators(mounted?.indicators ?? []);
    /*
     * The split the trader last dragged, before the first frame.
     *
     * Applied here rather than in an effect so a stored split is never seen as
     * a jump: the chart's first paint already has the price pane the size it
     * was left at.
     */
    adapter.setPaneSplit(mounted?.paneSplit ?? null);
    const offSplit = adapter.onPaneSplitChange((factors) => {
      useLayout.getState().setPaneSplit(paneId, factors);
    });

    /*
     * The legend follows the crosshair, but at FRAME rate.
     *
     * Crosshair callbacks arrive per pointer event, and each one rewrote nine
     * text nodes - which is style recalculation and layout, several times per
     * painted frame, for a reading nobody can take that fast. The latest bar
     * is remembered and written once a frame instead.
     */
    /** While this is in the future, the pane is following another's crosshair. */
    let followingUntil = 0;
    let hoverBar: NormalizedBar | null = null;
    let hoverPending = false;
    let hoverFrame = 0;
    const flushHover = (): void => {
      hoverFrame = requestAnimationFrame(flushHover);
      if (!hoverPending) return;
      hoverPending = false;
      legend.setHovered(hoverBar);
    };
    hoverFrame = requestAnimationFrame(flushHover);
    const offCrosshair = adapter.onCrosshairMove((info) => {
      hoverBar = info.bar;
      hoverPending = true;
      // The indicator rows read this, so their values are the values of the
      // bar the trader is pointing at. A ref, not state: it changes on every
      // pointer move.
      hoverTimeRef.current = info.bar?.time ?? null;
      /*
       * Publish, unless this pane is currently FOLLOWING someone else's
       * crosshair. Putting a crosshair on a chart makes that chart report a
       * crosshair move, and publishing it back bounced the two panes off each
       * other for as long as the pointer stayed still.
       */
      if (useLayout.getState().sync.crosshair && performance.now() > followingUntil) {
        publishCrosshair({ from: paneId, timeMs: info.bar?.time ?? null });
      }
    });

    // And the visible range, for panes that are keeping time in step.
    const offRange = adapter.onVisibleRangeChange((range) => {
      const layout = useLayout.getState();
      if (!range || !layout.sync.time) return;
      // Only the pane being worked in publishes. A pane that merely FOLLOWED a
      // range must not turn round and broadcast it, or two charts push each
      // other along and the pair runs away.
      if (layout.activePaneId !== paneId) return;
      publishRange({ from: paneId, fromMs: range.from, toMs: range.to });
    });

    const offCrosshairSync = onCrosshairSync((message) => {
      if (message.from === paneId || !useLayout.getState().sync.crosshair) return;
      followingUntil = performance.now() + 120;
      // A vertical-only TIME cursor on the secondary pane — never a horizontal
      // price line from another instrument (D-03). Synchronized by timestamp.
      adapterRef.current?.showTimeCursor(message.timeMs);
      recordCrosshairApplied(paneId, message.timeMs);
    });
    const offRangeSync = onRangeSync((message) => {
      if (message.from === paneId || !useLayout.getState().sync.time) return;
      whileApplying(() => adapterRef.current?.setVisibleTimeRange(message.fromMs, message.toMs));
      recordRangeApplied(paneId, message.fromMs, message.toMs);
    });

    return () => {
      cancelAnimationFrame(hoverFrame);
      offCrosshair();
      offRange();
      offCrosshairSync();
      offRangeSync();
      offSplit();
      adapter.destroy();
      adapterRef.current = null;
      setChartReady(false);
      legendRef.current = null;
    };
    // Mounted once: symbol and timeframe changes are handled by reloading data,
    // not by tearing down and rebuilding the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    adapterRef.current?.setChartType(chartType);
  }, [chartType]);

  useEffect(() => {
    adapterRef.current?.applyAppearance(appearance);
  }, [appearance]);

  useEffect(() => {
    adapterRef.current?.setIndicators(indicators);
  }, [indicators]);

  /*
   * A split restored from the workspace, or cleared by a double-click
   * somewhere else. The adapter ignores a value it already has, so this
   * cannot fight the drag that produced it.
   */
  useEffect(() => {
    adapterRef.current?.setPaneSplit(paneSplit);
  }, [paneSplit]);

  useEffect(() => {
    legendRef.current?.configure({ precision, timeZone });
  }, [precision, timeZone]);

  useEffect(() => {
    adapterRef.current?.setTimeframe(timeframe);
  }, [timeframe]);

  // -- load history on symbol / timeframe change ---------------------------
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter || !instrument) return;

    const token = ++loadTokenRef.current;
    setLoading(true);
    setLoadError(null);
    setHistoryNote(null);
    legendRef.current?.clear();
    seriesTimeframeRef.current = null;
    sawLiveBarRef.current = false;

    void (async () => {
      try {
        const page = await fetchBars(activeSymbol, timeframe, { limit: INITIAL_BARS });
        // A newer request started while this one was in flight: discard it
        // rather than painting a stale symbol's data onto the chart.
        if (token !== loadTokenRef.current) return;

        adapter.setTimeframe(timeframe);

        /*
         * An EMPTY response over the same instrument AND THE SAME SOURCE
         * leaves the series alone: a momentary empty page is not a reason to
         * wipe the chart, and with no series there is no price scale, so every
         * order marker loses its coordinate.
         *
         * An empty response from a DIFFERENT source is the opposite case, and
         * it used to be treated as the same one. Loading a replay that has not
         * emitted a bar yet left the live session's candles on the screen while
         * the account was priced against the recording: NQ read 29720 in the
         * status line, the position was marked at 29458, and the position
         * marker sat clamped to the bottom edge because its price was nowhere
         * near the range being displayed. Dragging a stop off it then produced
         * a target, because the level the pointer was over was on the other
         * side of a market that was not the market being traded.
         *
         * An empty chart that says why is honest. The old behaviour was not.
         */
        const sameSeries =
          loadedSeriesRef.current?.symbol === activeSymbol &&
          loadedSeriesRef.current?.timeframe === timeframe &&
          loadedSeriesRef.current?.provider === page.provider;
        if (page.bars.length === 0 && sameSeries && adapter.barCount > 0) {
          setHistoryNote(page.limitReason);
          seriesTimeframeRef.current = timeframe;
          return;
        }

        adapter.applyHistory(page.bars);
        loadedSeriesRef.current = { symbol: activeSymbol, timeframe, provider: page.provider };
        seriesTimeframeRef.current = timeframe;
        // The recent session at a readable spacing, not every bar ever loaded.
        adapter.showRecent();
        setBarCount(page.bars.length);
        setHistoryNote(page.limitReason);

        const last = page.bars[page.bars.length - 1];
        const previous = page.bars[page.bars.length - 2];
        if (last) {
          legendRef.current?.setReference(previous ?? null);
          legendRef.current?.setLive(last);
        }
        setCountdown(page.barCloseInSeconds);
      } catch (err) {
        if (token !== loadTokenRef.current) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load bars.');
      } finally {
        if (token === loadTokenRef.current) setLoading(false);
      }
    })();
  }, [activeSymbol, timeframe, instrument, routedToReplay, historyEpoch]);

  /*
   * An empty chart asks again once the recording has something.
   *
   * Restart, Step, Skip and Seek all move a PAUSED replay, and a paused replay
   * puts nothing on the stream to say so. Without this, loading a recording and
   * skipping half an hour into it left the chart on the empty state it was
   * correctly given at cursor zero, for the rest of the session. The condition
   * is deliberately narrow - only while the chart holds nothing - so a replay
   * that is playing normally re-fetches nothing.
   */
  useEffect(() => {
    if (!routedToReplay || replayCursor === 0) return;
    if ((adapterRef.current?.barCount ?? 0) > 0) return;
    setHistoryEpoch((epoch) => epoch + 1);
  }, [routedToReplay, replayCursor]);

  // -- live bars, straight from the stream into the chart ------------------
  useEffect(() => {
    if (!instrument) return;
    marketStream.connect();

    const motion = motionRef.current;
    motion.reset();
    motion.setTickSize(tickSize);
    motion.setSettings(useMotion.getState().settings);

    const offBar = marketStream.subscribeBars(activeSymbol, timeframe, (bar: NormalizedBar) => {
      if (seriesTimeframeRef.current !== timeframe) return;
      // The GENUINE bar goes to the legend and to the motion layer. What the
      // chart draws between observations is a rendering decision made below;
      // what anything reads as a price is this.
      motion.observe(bar, performance.now());
      legendRef.current?.setLive(bar);
      if (!sawLiveBarRef.current) {
        sawLiveBarRef.current = true;
        setHistoryNote(null);
      }
      /*
       * The first bar of a source that had nothing to show brings its history
       * with it.
       *
       * A replay that has not been played yet answers the history request with
       * an empty page, and the chart correctly shows nothing. What it must not
       * do is stay empty for the rest of the session: the moment the recording
       * emits, everything it has emitted so far is worth asking for again. The
       * timestamp keeps a source that is genuinely empty from asking once per
       * bar.
       */
      const adapter = adapterRef.current;
      if (adapter && adapter.barCount === 0) {
        const now = performance.now();
        if (now - emptyReloadRef.current > EMPTY_RELOAD_MS) {
          emptyReloadRef.current = now;
          setHistoryEpoch((epoch) => epoch + 1);
        }
      }
    });

    let frame = requestAnimationFrame(function draw(now: number): void {
      frame = requestAnimationFrame(draw);
      if (seriesTimeframeRef.current !== timeframe) return;
      const next = motion.sample(now);
      if (!next) return;
      adapterRef.current?.applyLiveBar(next);
      // Inside the writing frame, so the paint measurement is taken from the
      // frame callback after this one - the first moment it could be seen.
      clientLatency.applied(activeSymbol);
    });

    const offQuote = marketStream.subscribeQuote(activeSymbol, (quote) => {
      if (quote.last === null) return;

      /*
       * THE PRICE STREAM MOVES THE CANDLE.
       *
       * The forming candle used to follow the bar stream alone, and a
       * WebSocket capture is what exposed what that cost: in ninety-five
       * seconds the feed delivered nineteen prices on `md.quote.NQ` and one
       * bar on `md.bar.NQ.1m`, and the chart drew the one. Sampling the
       * displayed price twenty times a second for two and a half minutes found
       * it changed ONCE. That is the whole of "it feels like price is barely
       * moving": the price was arriving and the chart was not being told.
       *
       * A quote is a genuine observation - the vendor's last traded price with
       * its own exchange timestamp - so it is exactly as real as a bar's
       * close, and the server's own aggregator already builds the forming
       * bucket from it. This does the same thing on the client, against the
       * bar the chart is holding, and only ever the CLOSE: the open, the high,
       * the low and the volume stay the feed's own numbers, and the high and
       * low are widened only when the genuine price has actually been outside
       * them.
       *
       * Nothing here reaches the engine. Fills, triggers, marks and P&L are
       * server-side and are computed from the same observation by the same
       * authority they always were.
       */
      const genuine = motion.genuine();
      if (genuine && !genuine.closed && quote.exchangeTs >= genuine.time) {
        motion.observe(
          {
            ...genuine,
            high: Math.max(genuine.high, quote.last),
            low: Math.min(genuine.low, quote.last),
            close: quote.last,
          },
          performance.now(),
        );
        legendRef.current?.setLive(motion.genuine() ?? genuine);
      }

      if (!updatedRef.current) return;
      updatedRef.current.textContent = timeFormatter(
        useChartStore.getState().appearance,
        exchangeZone,
        { seconds: true },
      ).format(quote.exchangeTs);
    });

    return () => {
      cancelAnimationFrame(frame);
      offBar();
      offQuote();
      motion.reset();
    };
    /*
     * `routedToReplay` is a dependency so that changing market SOURCE tears
     * the motion layer down with everything else. It holds the last bar it
     * observed and interpolates from it every frame, so without this it went
     * on painting the previous market's price onto a chart that had just been
     * cleared for the new one.
     */
  }, [activeSymbol, timeframe, instrument, exchangeZone, tickSize, routedToReplay]);

  // Settings are read live, so switching between raw and smooth takes effect on
  // the next frame. The chart is never remounted and the series is never
  // reloaded.
  useEffect(() => {
    motionRef.current.setSettings(motionSettings);
  }, [motionSettings]);

  // Indicator values for the status line, sampled rather than pushed: the
  // Indicator values now live in the legend rows, which read them from the
  // adapter in their own animation frame - so nothing samples them here.

  /**
   * Show a trade from the journal.
   *
   * The chart scrolls to the entry and the overlay draws where it was opened
   * and closed. Nothing is re-simulated: the prices are the ones the server
   * recorded when the trade happened.
   */
  useEffect(() => {
    if (!chartFocus || !chartReady) return;
    /*
     * A trade recalled from the journal brings its own instrument.
     *
     * The chart being worked in takes it; the others are left alone. Without
     * this, recalling an ES trade while the chart was on NQ quietly did
     * nothing - the terminal changed instrument and the pane, which now owns
     * its own, changed it straight back.
     */
    if (chartFocus.symbol !== activeSymbol) {
      if (active) setPaneSymbol(paneId, chartFocus.symbol);
      return;
    }
    // Only once the series being shown is the one the trade was taken on.
    if (loading) return;
    adapterRef.current?.goToTime(chartFocus.entryTime);
  }, [chartFocus, chartReady, activeSymbol, active, loading, paneId, setPaneSymbol]);

  // Blind practice hides which DAY this is. The bars, their timestamps and
  // everything computed from them are untouched: only the labels change.
  useEffect(() => {
    adapterRef.current?.setDatesHidden(!showDates);
    legendRef.current?.setDatesHidden(!showDates);
  }, [showDates, chartReady]);

  // -- historical pagination when the user scrolls left --------------------
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) return;

    return adapter.onNeedMoreHistory((oldest) => {
      void (async () => {
        try {
          const page = await fetchBars(activeSymbol, timeframe, {
            limit: PAGE_BARS,
            before: oldest,
          });
          adapter.prependHistory(page.bars);
          setBarCount(adapter.barCount);
          if (page.bars.length === 0 || !page.hasMore) {
            setHistoryNote(
              page.limitReason ??
                'Reached the beginning of the history this feed provides for this timeframe.',
            );
          }
        } catch {
          adapter.releaseHistoryLatch();
        }
      })();
    });
  }, [activeSymbol, timeframe]);

  // -- freshness and countdown, polled slowly (these are chrome, not ticks) --
  useEffect(() => {
    if (!instrument) return;
    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const status = await fetchSymbolStatus(activeSymbol);
        if (!cancelled) setFreshness(status.freshness);
      } catch {
        /* the badge falls back to the stream's own state */
      }
    };
    void poll();
    const id = window.setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeSymbol, instrument]);

  useEffect(() => {
    if (countdown === null) return;
    const id = window.setInterval(() => {
      setCountdown((value) => (value === null || value <= 0 ? null : value - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [countdown]);

  // Right-click and double-click on an object. Both are owned by the input
  // machine, which decides whether the drawings have a claim on the gesture at
  // all; the chart keeps its own menu everywhere else.
  const [contextMenu, setContextMenu] = useState<ContextMenuRequest | null>(null);
  const propertiesFor = useChartStore((s) => s.propertiesFor);
  const closeProperties = useChartStore((s) => s.closeProperties);
  const openPropertiesFor = useChartStore((s) => s.openProperties);

  const openProperties = useCallback(
    (drawingId: string) => {
      setContextMenu(null);
      openPropertiesFor(drawingId);
    },
    [openPropertiesFor],
  );

  // Pointer ownership for drawings. Attached to the chart CONTAINER, not to
  // the canvas: see useDrawingInput for why the canvas never takes events.
  useDrawingInput({
    adapterRef,
    containerRef,
    symbol: activeSymbol,
    tickSize,
    ready: chartReady,
    boundsRef,
    onContextMenu: setContextMenu,
    onOpenProperties: openProperties,
  });

  /*
   * A drawing deleted from under the open context menu closes it rather than
   * leaving a menu pointed at nothing.
   *
   * Subscribed TRANSIENTLY, and only while a menu is open. Reading `drawings`
   * with a hook would re-render this panel - and the chart header inside it,
   * the most expensive component in the terminal - on every drawing edit,
   * which is most of a drag.
   */
  useEffect(() => {
    const openOn = contextMenu?.drawingId;
    if (!openOn) return;
    return useChartStore.subscribe((state) => {
      if (!state.drawings.some((drawing) => drawing.id === openOn)) setContextMenu(null);
    });
  }, [contextMenu?.drawingId]);

  const onScreenshot = useCallback(() => {
    void (async () => {
      const blob = await adapterRef.current?.screenshot();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `atlas-${activeSymbol}-${timeframe}.png`;
      anchor.click();
      URL.revokeObjectURL(url);
    })();
  }, [activeSymbol, timeframe]);

  return (
    <section className="chart-panel">
      <ChartHeader
        paneId={paneId}
        symbol={activeSymbol}
        timeframe={timeframe}
        onTimeframe={setTimeframe}
        onScreenshot={onScreenshot}
        onMaximize={onMaximize}
        maximized={maximized}
      />

      <div className="chart-stage">
        <div className="chart-status" data-testid="status-line" ref={statusRef}>
          {statusLine.symbolVisible ? (
            <>
              <span className="sl-symbol">{activeSymbol}</span>
              <span className="sl-tf">{timeframe}</span>
            </>
          ) : null}
          <span className="num sl-price flat" ref={priceRef}>
            —
          </span>
          <span
            className="num sl-change"
            ref={changeRef}
            style={statusLine.changeVisible ? undefined : { display: 'none' }}
          />
          <span className="sl-ohlc" style={statusLine.ohlcVisible ? undefined : { display: 'none' }}>
            <b>O</b>
            <span className="num" ref={openRef}>
              —
            </span>
            <b>H</b>
            <span className="num" ref={highRef}>
              —
            </span>
            <b>L</b>
            <span className="num" ref={lowRef}>
              —
            </span>
            <b>C</b>
            <span className="num" ref={closeRef}>
              —
            </span>
          </span>
          <span
            className="sl-ohlc"
            style={statusLine.volumeVisible ? undefined : { display: 'none' }}
          >
            <b>V</b>
            <span className="num" ref={volumeRef}>
              —
            </span>
          </span>
          <span className="sl-meta" style={{ display: 'none' }}>
            <span ref={barTimeRef}>—</span>
          </span>
          {/*
            A countdown to a bar that is not going to close.

            With the session shut the server still reports how long the last
            bar had left, and the status line read "MARKET CLOSED ... closes
            0:26" - two statements a foot apart, one of them false. A replay is
            the exception: it closes bars on its own clock whatever the real
            session is doing.
          */}
          {statusLine.barCloseCountdownVisible &&
          countdown !== null &&
          (routedToReplay || freshness?.state !== 'MARKET_CLOSED') ? (
            <span className="sl-meta" title="Time until this bar closes">
              closes <span className="num">{formatCountdown(countdown)}</span>
            </span>
          ) : null}
          {statusLine.updatedAtVisible ? (
            <span className="sl-meta">
              updated{' '}
              <span className="num" ref={updatedRef}>
                —
              </span>
            </span>
          ) : (
            <span className="sl-meta" style={{ display: 'none' }}>
              <span ref={updatedRef}>—</span>
            </span>
          )}
          {statusLine.barCountVisible ? (
            <span className="sl-meta">{barCount.toLocaleString('en-US')} bars</span>
          ) : null}


          {freshness && freshness.state !== 'FRESH' ? (
            <span className={`sl-feed sl-feed-${freshness.state.toLowerCase()}`}>
              {freshness.state.replace('_', ' ')}
            </span>
          ) : null}
        </div>

        <div className="chart-canvas" ref={containerRef} />

        <DrawingCanvas
          adapterRef={adapterRef}
          symbol={activeSymbol}
          pricePrecision={precision}
          tickSize={tickSize}
          tickValueMicros={instrument?.tickValueMicros ?? 0}
          timeframe={timeframe}
          ready={chartReady}
          boundsRef={boundsRef}
        />

        <DrawingStyleBar
          adapterRef={adapterRef}
          containerRef={containerRef}
          symbol={activeSymbol}
          ready={chartReady}
          onOpenProperties={openProperties}
        />

        <PriceMarkers
          adapterRef={adapterRef}
          containerRef={containerRef}
          symbol={activeSymbol}
          tickSize={tickSize}
          tickValueMicros={instrument?.tickValueMicros ?? 0}
          pricePrecision={precision}
          ready={chartReady}
        />

        {/*
          The indicator legend, one row per indicator, over the top left of the
          plot. Its values follow the crosshair.
        */}
        <IndicatorRows
          paneId={paneId}
          adapterRef={adapterRef}
          hoverTimeRef={hoverTimeRef}
          statusRef={statusRef}
          onOpenSettings={setIndicatorSettings}
        />

        {indicatorSettings && settingsPane === paneId ? (
          <IndicatorSettings
            instanceId={indicatorSettings}
            onClose={() => setIndicatorSettings(null)}
          />
        ) : null}

        <div className="chart-nav">
          <button onClick={() => adapterRef.current?.resetScale()} title="Reset the scales">
            <Icon name="reset" size={12} />
          </button>
          <button onClick={() => adapterRef.current?.scrollToRealtime()} title="Scroll to the newest bar">
            <Icon name="now" size={12} />
          </button>
        </div>

        {loading ? <div className="chart-overlay">Loading real market history…</div> : null}
        {loadError ? <div className="chart-overlay chart-overlay-error">{loadError}</div> : null}
        {historyNote ? <div className="chart-history-note">{historyNote}</div> : null}

        {/*
          A failed save is said out loud.

          Everything on this chart is presentation, so a save that does not
          happen breaks nothing immediately - it breaks the next reload, which
          is far too late to find out. The notice stays until it is dismissed
          or until a save succeeds.
        */}
        {persistError ? (
          <div className="chart-save-error" role="alert" data-testid="save-error">
            <Icon name="close" size={10} />
            <span>{persistError}</span>
            <button onClick={() => usePersistence.getState().dismiss()} aria-label="Dismiss">
              <Icon name="close" size={9} />
            </button>
          </div>
        ) : null}

        {contextMenu?.drawingId ? (
          <DrawingContextMenu
            drawingId={contextMenu.drawingId}
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            onOpenProperties={openProperties}
          />
        ) : null}

        {contextMenu && !contextMenu.drawingId ? (
          <ChartMenu
            head={activeSymbol}
            x={contextMenu.x}
            y={contextMenu.y}
            testId="chart-context-menu"
            onClose={() => setContextMenu(null)}
            items={buildChartMenuItems({
              price: contextMenu.price ?? null,
              precision,
              symbol: activeSymbol,
              paneId,
              multiPane: useLayout.getState().visiblePanes().length > 1,
              resetView: () => adapterRef.current?.fitContent(),
              close: () => setContextMenu(null),
            })}
          />
        ) : null}

        {propertiesFor ? (
          <DrawingProperties
            drawingId={propertiesFor}
            onClose={closeProperties}
            tickSize={tickSize}
            tickValueMicros={instrument?.tickValueMicros ?? 0}
            pricePrecision={precision}
          />
        ) : null}
      </div>
    </section>
  );
}

/**
 * The chart's own right-click menu (D-11).
 *
 * Only actions Atlas GENUINELY supports appear — nothing is a dead item
 * pretending at functionality. Trading actions (buy/sell/add-order at a price)
 * are intentionally omitted until the order ticket exposes a price prefill, so
 * the menu never offers an order it cannot actually place. Actions act on the
 * exact chart, symbol and price where the menu was opened.
 */
function buildChartMenuItems(opts: {
  price: number | null;
  precision: number;
  symbol: string;
  paneId: string;
  multiPane: boolean;
  resetView: () => void;
  close: () => void;
}): ChartMenuItem[] {
  const { price, precision, symbol, paneId, multiPane, resetView, close } = opts;
  const drawings = useChartStore.getState().drawings.filter((d) => d.symbol === symbol);
  const pane = useLayout.getState().panes.find((p) => p.id === paneId);
  const indicators = pane?.indicators ?? [];
  const items: ChartMenuItem[] = [
    { id: 'reset', label: 'Reset chart view', icon: 'reset', run: () => { resetView(); close(); } },
  ];
  if (price !== null && Number.isFinite(price)) {
    const text = price.toFixed(precision);
    items.push({
      id: 'copy-price',
      label: `Copy price ${text}`,
      icon: 'copy',
      run: () => {
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        close();
      },
    });
  }
  if (drawings.length > 0 || indicators.length > 0) {
    items.push({ id: 'sep1', separator: true });
  }
  if (drawings.length > 0) {
    items.push({
      id: 'rm-drawings',
      label: `Remove ${drawings.length} drawing${drawings.length === 1 ? '' : 's'}`,
      icon: 'trash',
      danger: true,
      run: () => { useChartStore.getState().clearDrawings(symbol); close(); },
    });
  }
  if (indicators.length > 0) {
    items.push({
      id: 'rm-indicators',
      label: `Remove ${indicators.length} indicator${indicators.length === 1 ? '' : 's'}`,
      icon: 'trash',
      danger: true,
      run: () => {
        const store = useLayout.getState();
        for (const instance of indicators) store.removeIndicator(instance.id);
        close();
      },
    });
    if (multiPane) {
      items.push({
        id: 'apply-indicators',
        label: 'Apply indicators to entire layout',
        icon: 'copy',
        run: () => { useLayout.getState().applyConfigToOtherPanes(paneId); close(); },
      });
    }
  }
  items.push({ id: 'sep2', separator: true });
  items.push({
    id: 'settings',
    label: 'Settings…',
    icon: 'gear',
    run: () => { useWorkspace.getState().openSettings('SYMBOL'); close(); },
  });
  return items;
}

function formatCountdown(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
