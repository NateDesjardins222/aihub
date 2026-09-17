import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { NormalizedBar, Timeframe } from '@atlas/contracts';
import { useSession, activeInstrument } from '../state/session';
import { LightweightChartsAdapter } from '../chart/LightweightChartsAdapter';
import { marketStream } from '../market/stream';
import { fetchBars, fetchSymbolStatus, type FreshnessInfo } from '../market/api';
import { ChartLegend } from './ChartLegend';
import { ChartHeader } from '../chart/ChartHeader';
import { PriceMarkers, type BracketMode } from '../chart/PriceMarkers';
import { DrawingLayer } from '../chart/drawings/DrawingLayer';
import { MarketMotion } from '../chart/motion';
import { useMotion } from '../state/motion-store';
import { useChartStore } from '../state/chart-store';
import { useTraining } from '../state/training';
import { resolveZone, timeFormatter } from '../chart/appearance';
import { Icon } from '../ui/Icon';
import './ChartPanel.css';

const INITIAL_BARS = 1_200;
const PAGE_BARS = 1_000;

export interface ChartPanelProps {
  readonly bracketMode: BracketMode;
  readonly stopTicks: number;
  readonly targetTicks: number;
}

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
export function ChartPanel({ bracketMode, stopTicks, targetTicks }: ChartPanelProps): JSX.Element {
  const activeSymbol = useSession((s) => s.activeSymbol);
  const instrument = useSession(activeInstrument);

  const [timeframe, setTimeframe] = useState<Timeframe>(
    () => (localStorage.getItem('atlas.chart.timeframe') as Timeframe) ?? '1m',
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [barCount, setBarCount] = useState(0);
  const [historyNote, setHistoryNote] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<FreshnessInfo | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [chartReady, setChartReady] = useState(false);
  const [legendIndicators, setLegendIndicators] = useState<
    ReadonlyArray<{ id: string; label: string; color: string; value: string }>
  >([]);

  const motionSettings = useMotion((s) => s.settings);
  const appearance = useChartStore((s) => s.appearance);
  const chartType = useChartStore((s) => s.chartType);
  const indicators = useChartStore((s) => s.indicators);
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
  const exchangeZone = instrument?.sessionTimezone ?? 'America/Chicago';
  const timeZone = resolveZone(appearance, exchangeZone);
  const statusLine = appearance.statusLine;

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
    // The legend is built once, after the mask may already have been chosen, so
    // it is told immediately rather than waiting for the mask to change again.
    legend.setDatesHidden(!useTraining.getState().visibility.dateTime);
    adapter.setDatesHidden(!useTraining.getState().visibility.dateTime);
    adapter.setChartType(useChartStore.getState().chartType);
    adapter.setIndicators(useChartStore.getState().indicators);

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
  }, [chartType]);

  useEffect(() => {
    adapterRef.current?.applyAppearance(appearance);
  }, [appearance]);

  useEffect(() => {
    adapterRef.current?.setIndicators(indicators);
  }, [indicators]);

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

    let frame = requestAnimationFrame(function draw(now: number): void {
      frame = requestAnimationFrame(draw);
      if (seriesTimeframeRef.current !== timeframe) return;
      const next = motion.sample(now);
      if (next) adapterRef.current?.applyLiveBar(next);
    });

    const offQuote = marketStream.subscribeQuote(activeSymbol, (quote) => {
      if (quote.last === null) return;
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
  }, [activeSymbol, timeframe, instrument, exchangeZone, tickSize]);

  // Settings are read live, so switching between raw and smooth takes effect on
  // the next frame. The chart is never remounted and the series is never
  // reloaded.
  useEffect(() => {
    motionRef.current.setSettings(motionSettings);
  }, [motionSettings]);

  // Indicator values for the status line, sampled rather than pushed: the
  // numbers change on every bar and the status line is chrome.
  useEffect(() => {
    if (!chartReady || !statusLine.indicatorTitlesVisible) {
      setLegendIndicators([]);
      return;
    }
    const tick = (): void => setLegendIndicators(adapterRef.current?.indicatorLegend() ?? []);
    tick();
    const id = window.setInterval(tick, 700);
    return () => window.clearInterval(id);
  }, [chartReady, indicators, statusLine.indicatorTitlesVisible]);

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
      <ChartHeader timeframe={timeframe} onTimeframe={setTimeframe} onScreenshot={onScreenshot} />

      <div className="chart-stage">
        <div className="chart-status" data-testid="status-line">
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
          {statusLine.barCloseCountdownVisible && countdown !== null ? (
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

          {legendIndicators.length > 0 ? (
            <span className="sl-inds">
              {legendIndicators.map((entry) => (
                <span className="sl-ind" key={entry.id}>
                  <i style={{ background: entry.color }} />
                  {entry.label}
                  <b className="num">{entry.value}</b>
                </span>
              ))}
            </span>
          ) : null}

          {freshness && freshness.state !== 'FRESH' ? (
            <span className={`sl-feed sl-feed-${freshness.state.toLowerCase()}`}>
              {freshness.state.replace('_', ' ')}
            </span>
          ) : null}
        </div>

        <div className="chart-canvas" ref={containerRef} />

        <DrawingLayer
          adapterRef={adapterRef}
          symbol={activeSymbol}
          pricePrecision={precision}
          tickSize={tickSize}
          ready={chartReady}
        />

        <PriceMarkers
          adapterRef={adapterRef}
          containerRef={containerRef}
          symbol={activeSymbol}
          tickSize={tickSize}
          pricePrecision={precision}
          ready={chartReady}
          defaultStopTicks={bracketMode === 'OFF' ? 40 : stopTicks}
          defaultTargetTicks={bracketMode === 'OFF' ? 80 : targetTicks}
        />

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
      </div>
    </section>
  );
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
