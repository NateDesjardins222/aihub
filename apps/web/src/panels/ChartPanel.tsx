import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { NormalizedBar, Timeframe } from '@atlas/contracts';
import { useSession, activeInstrument } from '../state/session';
import { LightweightChartsAdapter } from '../chart/LightweightChartsAdapter';
import { PHASE_1_CHART_TYPES, type ChartType } from '../chart/ChartAdapter';
import { marketStream } from '../market/stream';
import { fetchBars, fetchSymbolStatus, type FreshnessInfo } from '../market/api';
import { ChartLegend } from './ChartLegend';
import { ChartTrading } from '../chart/ChartTrading';
import { MarketMotion } from '../chart/motion';
import { useMotion } from '../state/motion-store';
import { useTraining } from '../state/training';
import { FeedBadge } from './FeedBadge';
import './ChartPanel.css';

/** Timeframes Milestone 2 is required to support, in toolbar order. */
const TIMEFRAMES: readonly Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D'];

const CHART_TYPE_LABELS: Record<ChartType, string> = {
  CANDLES: 'Candles',
  HOLLOW_CANDLES: 'Hollow candles',
  BARS: 'Bars',
  LINE: 'Line',
  LINE_WITH_MARKERS: 'Line + markers',
  AREA: 'Area',
  BASELINE: 'Baseline',
  HEIKIN_ASHI: 'Heikin Ashi',
  RENKO: 'Renko',
  KAGI: 'Kagi',
  LINE_BREAK: 'Line break',
  POINT_AND_FIGURE: 'Point & figure',
  HIGH_LOW: 'High-low',
};

const INITIAL_BARS = 1_200;
const PAGE_BARS = 1_000;

/**
 * The chart.
 *
 * React owns the chrome — symbol, timeframe, chart type, status. It does NOT
 * own the price data: bars arrive on the market stream and go straight into the
 * chart adapter and the legend. A tick therefore costs one canvas update and a
 * few text nodes, and never a component render.
 */
export function ChartPanel(): JSX.Element {
  const instruments = useSession((s) => s.instruments);
  const activeSymbol = useSession((s) => s.activeSymbol);
  const setActiveSymbol = useSession((s) => s.setActiveSymbol);
  const instrument = useSession(activeInstrument);

  const [timeframe, setTimeframe] = useState<Timeframe>(
    () => (localStorage.getItem('atlas.chart.timeframe') as Timeframe) ?? '1m',
  );
  const [chartType, setChartType] = useState<ChartType>(
    () => (localStorage.getItem('atlas.chart.type') as ChartType) ?? 'CANDLES',
  );
  const [showVolume, setShowVolume] = useState(
    () => localStorage.getItem('atlas.chart.volume') !== 'false',
  );
  const [logScale, setLogScale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [barCount, setBarCount] = useState(0);
  const [historyNote, setHistoryNote] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<FreshnessInfo | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  /** Flipped once the chart is mounted, so the trading overlay can measure it. */
  const [chartReady, setChartReady] = useState(false);
  const motionSettings = useMotion((s) => s.settings);
  const showDates = useTraining((s) => s.visibility.dateTime);
  const chartFocus = useSession((s) => s.chartFocus);

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
   * The visual motion layer.
   *
   * It sits between the stream and the renderer and touches nothing else: the
   * legend, the engine and every calculation read genuine observations.
   */
  const motionRef = useRef<MarketMotion>(new MarketMotion());

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
  const timeZone = instrument?.sessionTimezone ?? 'America/Chicago';

  // -- mount the chart once ------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const adapter = new LightweightChartsAdapter();
    adapter.mount({ container, pricePrecision: precision, tickSize, timeZone });
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

    const offCrosshair = adapter.onCrosshairMove((info) => legend.setHovered(info.bar));

    return () => {
      offCrosshair();
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
    localStorage.setItem('atlas.chart.type', chartType);
  }, [chartType]);

  useEffect(() => {
    adapterRef.current?.setVolumeVisible(showVolume);
    localStorage.setItem('atlas.chart.volume', String(showVolume));
  }, [showVolume]);

  useEffect(() => {
    adapterRef.current?.setPriceScaleMode(logScale ? 'LOGARITHMIC' : 'NORMAL');
  }, [logScale]);

  useEffect(() => {
    legendRef.current?.configure({ precision, timeZone });
  }, [precision, timeZone]);

  useEffect(() => {
    localStorage.setItem('atlas.chart.timeframe', timeframe);
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

    void (async () => {
      try {
        const page = await fetchBars(activeSymbol, timeframe, { limit: INITIAL_BARS });
        // A newer request started while this one was in flight: discard it
        // rather than painting a stale symbol's data onto the chart.
        if (token !== loadTokenRef.current) return;

        adapter.setTimeframe(timeframe);
        adapter.applyHistory(page.bars);
        seriesTimeframeRef.current = timeframe;
        adapter.fitContent();
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
  }, [activeSymbol, timeframe, instrument]);

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
    });

    // One animation frame loop per mounted chart. It draws whatever the motion
    // layer says should be on screen - in RAW mode that is exactly the bar that
    // just arrived, and nothing more.
    let frame = requestAnimationFrame(function draw(now: number): void {
      frame = requestAnimationFrame(draw);
      if (seriesTimeframeRef.current !== timeframe) return;
      const next = motion.sample(now);
      if (next) adapterRef.current?.applyLiveBar(next);
    });

    const offQuote = marketStream.subscribeQuote(activeSymbol, (quote) => {
      if (quote.last === null) return;
      updatedRef.current!.textContent = new Intl.DateTimeFormat('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone,
      }).format(quote.exchangeTs);
    });

    return () => {
      cancelAnimationFrame(frame);
      offBar();
      offQuote();
      motion.reset();
    };
  }, [activeSymbol, timeframe, instrument, timeZone, tickSize]);

  // Settings are read live, so switching between raw and smooth - or changing
  // how hard the smoothing is - takes effect on the next frame. The chart is
  // never remounted and the series is never reloaded.
  useEffect(() => {
    motionRef.current.setSettings(motionSettings);
  }, [motionSettings]);

  /**
   * Show a trade from the journal.
   *
   * The chart scrolls to the entry and the overlay draws where it was opened
   * and closed. Nothing is re-simulated: the prices are the ones the server
   * recorded when the trade happened.
   */
  useEffect(() => {
    if (!chartFocus || !chartReady) return;
    if (chartFocus.symbol !== activeSymbol) return;
    adapterRef.current?.goToTime(chartFocus.entryTime);
  }, [chartFocus, chartReady, activeSymbol]);

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

  const onScreenshot = useCallback(async () => {
    const blob = await adapterRef.current?.screenshot();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `atlas-${activeSymbol}-${timeframe}.png`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [activeSymbol, timeframe]);

  const contractLabel = useMemo(
    () => instrument?.activeContract.code ?? activeSymbol,
    [instrument, activeSymbol],
  );

  return (
    <section className="chart-panel">
      <div className="chart-toolbar">
        <select
          className="chart-symbol"
          value={activeSymbol}
          onChange={(e) => setActiveSymbol(e.target.value)}
          title="Select instrument"
        >
          {instruments.map((i) => (
            <option key={i.root} value={i.root}>
              {i.root} — {i.description}
            </option>
          ))}
        </select>

        <span className="chart-contract" title="Front month, from the exchange listing cycle">
          {contractLabel}
        </span>

        <div className="chart-tf">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              className={`tf-btn ${tf === timeframe ? 'tf-btn-active' : ''}`}
              onClick={() => setTimeframe(tf)}
            >
              {tf}
            </button>
          ))}
        </div>

        <select
          className="chart-type"
          value={chartType}
          onChange={(e) => setChartType(e.target.value as ChartType)}
          title="Chart type"
        >
          {PHASE_1_CHART_TYPES.map((t) => (
            <option key={t} value={t}>
              {CHART_TYPE_LABELS[t]}
            </option>
          ))}
        </select>

        <div className="chart-toolbar-spacer" />

        <button
          className={`chip ${showVolume ? 'chip-on' : ''}`}
          onClick={() => setShowVolume(!showVolume)}
          title="Toggle volume"
        >
          VOL
        </button>
        <button
          className={`chip ${logScale ? 'chip-on' : ''}`}
          onClick={() => setLogScale(!logScale)}
          title="Logarithmic price scale"
        >
          LOG
        </button>
        <button className="chip" onClick={() => adapterRef.current?.resetScale()} title="Reset scale">
          RESET
        </button>
        <button
          className="chip"
          onClick={() => adapterRef.current?.scrollToRealtime()}
          title="Scroll to the newest bar"
        >
          NOW
        </button>
        <button className="chip" onClick={() => void onScreenshot()} title="Save a PNG of the chart">
          PNG
        </button>

        <FeedBadge freshness={freshness} />
      </div>

      <div className="chart-stage">
        <div className="chart-legend">
          <span className="legend-symbol">{activeSymbol}</span>
          <span className="legend-tf">{timeframe}</span>
          <span className="num legend-price flat" ref={priceRef}>
            —
          </span>
          <span className="num legend-change" ref={changeRef} />
          <span className="legend-ohlc">
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
            <b>V</b>
            <span className="num" ref={volumeRef}>
              —
            </span>
          </span>
          <span className="legend-sep" />
          <span className="legend-meta">
            bar <span className="num" ref={barTimeRef}>—</span>
          </span>
          <span className="legend-meta">
            updated <span className="num" ref={updatedRef}>—</span> {shortZone(timeZone)}
          </span>
          {countdown !== null ? (
            <span className="legend-meta" title="Time until this bar closes">
              closes in <span className="num">{formatCountdown(countdown)}</span>
            </span>
          ) : null}
          <span className="legend-meta">{barCount.toLocaleString('en-US')} bars</span>
        </div>

        <div className="chart-canvas" ref={containerRef} />

        <ChartTrading
          adapterRef={adapterRef}
          containerRef={containerRef}
          symbol={activeSymbol}
          tickSize={tickSize}
          pricePrecision={precision}
          ready={chartReady}
        />

        {loading ? <div className="chart-overlay">Loading real market history…</div> : null}
        {loadError ? <div className="chart-overlay chart-overlay-error">{loadError}</div> : null}
        {historyNote ? <div className="chart-history-note">{historyNote}</div> : null}
      </div>
    </section>
  );
}

function shortZone(timeZone: string): string {
  return timeZone.split('/').pop()?.replace('_', ' ') ?? timeZone;
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
