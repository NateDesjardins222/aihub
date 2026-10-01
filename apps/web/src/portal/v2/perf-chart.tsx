/**
 * V2PerfChart — a REAL interactive financial chart (human-review #3).
 *
 * Replaces the static SVG with lightweight-charts (the same library Atlas uses; this
 * component is independent of Atlas and never touches it). It gives a real crosshair,
 * a date/value tooltip, responsive resizing, and clean theming in the Portal V2 token
 * palette. Presentation only: the caller supplies an authoritative numeric series in
 * micro-dollars and owns the empty/loading/error states.
 */
import { useEffect, useRef, type JSX } from 'react';
import { AreaSeries, ColorType, LineStyle, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { SeriesPoint } from './primitives';
import { formatMoney } from './format';

export function V2PerfChart({ series, height = 240, ariaLabel = 'Performance chart' }: {
  series: SeriesPoint[];
  height?: number;
  ariaLabel?: string;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  // Create the chart once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const css = getComputedStyle(host);
    const champagne = css.getPropertyValue('--ht-champagne').trim() || '#e7dcc4';
    const grid = css.getPropertyValue('--ht-border-subtle').trim() || '#19191c';
    const text = css.getPropertyValue('--ht-text-muted').trim() || '#8a8a90';

    const chart = createChart(host, {
      height,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: text, fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid, timeVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: {
        mode: 1,
        vertLine: { color: text, width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#161618' },
        horzLine: { color: text, width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#161618' },
      },
      localization: { priceFormatter: (v: number) => formatMoney(v, { sign: true, maxFractionDigits: 0 }) },
      handleScroll: false,
      handleScale: false,
    });
    const area = chart.addSeries(AreaSeries, {
      lineColor: champagne,
      topColor: `color-mix(in srgb, ${champagne} 24%, transparent)`,
      bottomColor: 'transparent',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 3,
    });
    chartRef.current = chart;
    seriesRef.current = area;

    // Tooltip driven by the real crosshair.
    const tip = tipRef.current;
    chart.subscribeCrosshairMove((param) => {
      if (!tip) return;
      if (!param.time || !param.point || param.point.x < 0) { tip.style.opacity = '0'; return; }
      const val = param.seriesData.get(area) as { value?: number } | undefined;
      if (!val || typeof val.value !== 'number') { tip.style.opacity = '0'; return; }
      const ms = (param.time as number) * 1000;
      const date = new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
      tip.innerHTML = `<span class="htv2-perftip-d">${date}</span><span class="htv2-perftip-v">${formatMoney(val.value, { sign: true, maxFractionDigits: 0 })}</span>`;
      tip.style.opacity = '1';
    });

    const ro = new ResizeObserver(() => { chart.applyOptions({ width: host.clientWidth }); });
    ro.observe(host);
    chart.applyOptions({ width: host.clientWidth });

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, [height]);

  // Push data whenever the series changes (range switch, metric switch, live update).
  useEffect(() => {
    const area = seriesRef.current;
    const chart = chartRef.current;
    if (!area || !chart) return;
    const data = series
      .map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.v }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    area.setData(data);
    chart.timeScale().fitContent();
  }, [series]);

  return (
    <div className="htv2-perfchart" role="img" aria-label={ariaLabel} data-testid="htv2-perfchart">
      <div ref={hostRef} className="htv2-perfchart-host" style={{ height }} />
      <div ref={tipRef} className="htv2-perftip" aria-hidden />
    </div>
  );
}
