/**
 * The indicator catalogue.
 *
 * An indicator is a DEFINITION (what it is, what it takes, how it draws) plus a
 * pure `compute` that turns bars into plot points. The chart adapter holds the
 * bars and calls `compute` on redraw, so adding an indicator costs no React
 * renders and a tick never passes through a component.
 *
 * Nothing here invents an observation. A plot point exists only where the maths
 * yields a value from genuine bars; elsewhere it is absent, and the line simply
 * has a gap - which is the truth about a window that is not full yet.
 */
import type { NormalizedBar } from '@atlas/contracts';
import { atr, bollinger, ema, macd, rsi, sma, smooth, sourceValue, vwap, type Source } from './math';

export type PlotKind = 'LINE' | 'HISTOGRAM';

export interface PlotPoint {
  readonly time: number;
  readonly value: number;
  /** Per-point colour, used by histograms that change sign. */
  readonly color?: string;
}

export interface Plot {
  readonly id: string;
  readonly label: string;
  readonly kind: PlotKind;
  readonly color: string;
  readonly lineWidth: number;
  readonly lineStyle: 'SOLID' | 'DASHED' | 'DOTTED';
  /** 0 to 1. Applied to the colour, since the renderer has no alpha layer. */
  readonly opacity: number;
  readonly points: readonly PlotPoint[];
}

export interface IndicatorOutput {
  /** 'PRICE' overlays the candles; a number is a separate pane below it. */
  readonly pane: 'PRICE' | number;
  readonly plots: readonly Plot[];
  /** Horizontal reference lines for a pane, e.g. RSI's 30 and 70. */
  readonly guides?: readonly { value: number; color: string }[];
  /** Fixed pane range, where the statistic has one. */
  readonly range?: { min: number; max: number };
}

export type ParamType = 'NUMBER' | 'SOURCE' | 'COLOR' | 'LINE_STYLE';

export interface ParamDef {
  readonly key: string;
  readonly label: string;
  readonly type: ParamType;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export type ParamValues = Record<string, number | string>;

export interface IndicatorDef {
  readonly kind: string;
  readonly name: string;
  readonly category: 'Moving averages' | 'Oscillators' | 'Volatility' | 'Volume' | 'Price';
  readonly overlay: boolean;
  readonly description: string;
  readonly params: readonly ParamDef[];
  readonly defaults: ParamValues;
  readonly compute: (bars: readonly NormalizedBar[], params: ParamValues, ctx: ComputeContext) => IndicatorOutput;
}

export interface ComputeContext {
  /** True on the first bar of a trading session, for session-anchored statistics. */
  readonly isSessionStart: (bar: NormalizedBar, index: number) => boolean;
  readonly pane: 'PRICE' | number;
}

function num(params: ParamValues, key: string, fallback: number): number {
  const value = Number(params[key]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function src(params: ParamValues, key: string): Source {
  const value = String(params[key] ?? 'close');
  const allowed: Source[] = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];
  return (allowed as string[]).includes(value) ? (value as Source) : 'close';
}

function colourOf(params: ParamValues, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** Turn an aligned value array into plot points, dropping the undefined ones. */
function plot(
  bars: readonly NormalizedBar[],
  values: ReadonlyArray<number | null>,
  spec: {
    id: string;
    label: string;
    kind?: PlotKind;
    color: string;
    lineWidth?: number;
    lineStyle?: 'SOLID' | 'DASHED' | 'DOTTED';
    opacity?: number;
  },
): Plot {
  const points: PlotPoint[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const value = values[i];
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    points.push({ time: bars[i]!.time, value });
  }
  return {
    id: spec.id,
    label: spec.label,
    kind: spec.kind ?? 'LINE',
    color: spec.color,
    lineWidth: spec.lineWidth ?? 1,
    lineStyle: spec.lineStyle ?? 'SOLID',
    opacity: spec.opacity ?? 1,
    points,
  };
}

/** The style an instance's parameters ask for, for the `plot` helper. */
function styleOf(params: ParamValues, fallbackWidth = 1): {
  lineWidth: number;
  lineStyle: 'SOLID' | 'DASHED' | 'DOTTED';
  opacity: number;
} {
  const raw = params['lineStyle'];
  return {
    lineWidth: Math.max(1, Math.min(4, num(params, 'lineWidth', fallbackWidth))),
    lineStyle: raw === 'DASHED' || raw === 'DOTTED' ? raw : 'SOLID',
    opacity: Math.max(0.1, Math.min(1, num(params, 'opacity', 100) / 100)),
  };
}

const PERIOD: ParamDef = { key: 'period', label: 'Length', type: 'NUMBER', min: 1, max: 1000, step: 1 };
const SOURCE: ParamDef = { key: 'source', label: 'Source', type: 'SOURCE' };
const COLOUR: ParamDef = { key: 'color', label: 'Colour', type: 'COLOR' };

/*
 * Smoothing: a second average applied to the line itself.
 *
 * 1 means off, and off is the default - a moving average that silently
 * averages itself again is not the indicator the trader asked for. It is here
 * because the brief listed it among the settings an EMA must expose, and
 * because a smoothed fast MA is a real technique rather than a decoration.
 */
const SMOOTHING: ParamDef = {
  key: 'smoothing',
  label: 'Smoothing',
  type: 'NUMBER',
  min: 1,
  max: 200,
  step: 1,
};

/*
 * Appearance, for every indicator that draws a line.
 *
 * These were fixed in code: an indicator could be given a colour and nothing
 * else, so two moving averages could not be told apart by weight, and a guide
 * line could not be faded behind the price. Width, style and opacity are
 * parameters like any other now, and they are read by the adapter when it
 * builds the series.
 */
const WIDTH: ParamDef = { key: 'lineWidth', label: 'Thickness', type: 'NUMBER', min: 1, max: 4, step: 1 };
const LINE_STYLE: ParamDef = { key: 'lineStyle', label: 'Line style', type: 'LINE_STYLE' };
const OPACITY: ParamDef = { key: 'opacity', label: 'Opacity', type: 'NUMBER', min: 10, max: 100, step: 5 };

/** The style trio, appended to an indicator's own inputs. */
const STYLE: readonly ParamDef[] = [WIDTH, LINE_STYLE, OPACITY];

/** Defaults for the style trio, merged into every line indicator. */
const STYLE_DEFAULTS = { lineWidth: 1, lineStyle: 'SOLID', opacity: 100 } as const;

export const INDICATORS: readonly IndicatorDef[] = [
  {
    kind: 'SMA',
    name: 'Moving average',
    category: 'Moving averages',
    overlay: true,
    description: 'The mean of the last N values of the chosen source.',
    params: [PERIOD, SOURCE, SMOOTHING, COLOUR, ...STYLE],
    defaults: { ...STYLE_DEFAULTS, period: 20, source: 'close', smoothing: 1, color: '#4d8dff' },
    compute: (bars, params, ctx) => ({
      pane: ctx.pane,
      plots: [
        plot(
          bars,
          smooth(
            sma(bars.map((b) => sourceValue(b, src(params, 'source'))), num(params, 'period', 20)),
            num(params, 'smoothing', 1),
          ),
          {
            id: 'sma',
            label: `MA ${num(params, 'period', 20)}`,
            color: colourOf(params, 'color', '#4d8dff'),
            ...styleOf(params),
          },
        ),
      ],
    }),
  },
  {
    kind: 'EMA',
    name: 'Exponential moving average',
    category: 'Moving averages',
    overlay: true,
    description: 'Weights recent values more heavily. Seeded from the simple average.',
    params: [PERIOD, SOURCE, SMOOTHING, COLOUR, ...STYLE],
    defaults: { ...STYLE_DEFAULTS, period: 21, source: 'close', smoothing: 1, color: '#f5a524' },
    compute: (bars, params, ctx) => ({
      pane: ctx.pane,
      plots: [
        plot(
          bars,
          smooth(
            ema(bars.map((b) => sourceValue(b, src(params, 'source'))), num(params, 'period', 21)),
            num(params, 'smoothing', 1),
          ),
          {
            id: 'ema',
            label: `EMA ${num(params, 'period', 21)}`,
            color: colourOf(params, 'color', '#f5a524'),
            ...styleOf(params),
          },
        ),
      ],
    }),
  },
  {
    kind: 'VWAP',
    name: 'VWAP (session)',
    category: 'Volume',
    overlay: true,
    description:
      'Volume-weighted average price, anchored to the session open. Needs genuine volume: a feed that reports none produces no line.',
    params: [SOURCE, COLOUR, ...STYLE],
    defaults: { ...STYLE_DEFAULTS, source: 'hlc3', color: '#a879f0' },
    compute: (bars, params, ctx) => ({
      pane: ctx.pane,
      plots: [
        plot(bars, vwap(bars, src(params, 'source'), ctx.isSessionStart), {
          id: 'vwap',
          label: 'VWAP',
          color: colourOf(params, 'color', '#a879f0'),
          ...styleOf(params, 2),
        }),
      ],
    }),
  },
  {
    kind: 'BOLL',
    name: 'Bollinger bands',
    category: 'Volatility',
    overlay: true,
    description: 'A moving average with bands a multiple of the standard deviation either side.',
    params: [
      PERIOD,
      { key: 'multiplier', label: 'Deviations', type: 'NUMBER', min: 0.1, max: 10, step: 0.1 },
      SOURCE,
      COLOUR,
      ...STYLE,
    ],
    defaults: { ...STYLE_DEFAULTS, period: 20, multiplier: 2, source: 'close', color: '#6b7a94' },
    compute: (bars, params, ctx) => {
      const values = bars.map((b) => sourceValue(b, src(params, 'source')));
      const period = num(params, 'period', 20);
      const multiplier = Number(params['multiplier']) || 2;
      const { middle, upper, lower } = bollinger(values, period, multiplier);
      const base = colourOf(params, 'color', '#6b7a94');
      return {
        pane: ctx.pane,
        plots: [
          plot(bars, upper, { id: 'upper', label: `BB upper`, color: base, ...styleOf(params) }),
          plot(bars, middle, { id: 'middle', label: `BB ${period}`, color: base, ...styleOf(params) }),
          plot(bars, lower, { id: 'lower', label: `BB lower`, color: base, ...styleOf(params) }),
        ],
      };
    },
  },
  {
    kind: 'VOLUME',
    name: 'Volume',
    category: 'Volume',
    overlay: false,
    description: 'Contracts traded per bar, coloured by the bar direction.',
    params: [],
    defaults: {},
    compute: (bars, _params, ctx) => ({
      pane: ctx.pane,
      plots: [
        {
          id: 'volume',
          label: 'Volume',
          kind: 'HISTOGRAM',
          color: 'rgba(46, 196, 166, 0.34)',
          lineWidth: 1,
          lineStyle: 'SOLID',
          opacity: 1,
          points: bars.map((b) => ({
            time: b.time,
            value: b.volume,
            color: b.close >= b.open ? 'rgba(46, 196, 166, 0.45)' : 'rgba(242, 84, 75, 0.45)',
          })),
        },
      ],
    }),
  },
  {
    kind: 'RSI',
    name: 'Relative strength index',
    category: 'Oscillators',
    overlay: false,
    description: "Wilder's RSI. Bounded 0-100.",
    params: [PERIOD, SOURCE, COLOUR, ...STYLE],
    defaults: { ...STYLE_DEFAULTS, period: 14, source: 'close', color: '#4d8dff' },
    compute: (bars, params, ctx) => ({
      pane: ctx.pane,
      range: { min: 0, max: 100 },
      guides: [
        { value: 70, color: 'rgba(242, 84, 75, 0.4)' },
        { value: 50, color: 'rgba(107, 122, 148, 0.3)' },
        { value: 30, color: 'rgba(46, 196, 166, 0.4)' },
      ],
      plots: [
        plot(
          bars,
          rsi(bars.map((b) => sourceValue(b, src(params, 'source'))), num(params, 'period', 14)),
          {
            id: 'rsi',
            label: `RSI ${num(params, 'period', 14)}`,
            color: colourOf(params, 'color', '#4d8dff'),
            ...styleOf(params),
          },
        ),
      ],
    }),
  },
  {
    kind: 'MACD',
    name: 'MACD',
    category: 'Oscillators',
    overlay: false,
    description: 'The gap between a fast and a slow EMA, with a signal line and a histogram.',
    params: [
      { key: 'fast', label: 'Fast length', type: 'NUMBER', min: 1, max: 200, step: 1 },
      { key: 'slow', label: 'Slow length', type: 'NUMBER', min: 1, max: 400, step: 1 },
      { key: 'signal', label: 'Signal length', type: 'NUMBER', min: 1, max: 200, step: 1 },
      SOURCE,
      ...STYLE,
    ],
    defaults: { ...STYLE_DEFAULTS, fast: 12, slow: 26, signal: 9, source: 'close' },
    compute: (bars, params, ctx) => {
      const values = bars.map((b) => sourceValue(b, src(params, 'source')));
      const result = macd(values, num(params, 'fast', 12), num(params, 'slow', 26), num(params, 'signal', 9));
      const histogram: PlotPoint[] = [];
      for (let i = 0; i < bars.length; i += 1) {
        const value = result.histogram[i];
        if (value === null || value === undefined) continue;
        histogram.push({
          time: bars[i]!.time,
          value,
          color: value >= 0 ? 'rgba(46, 196, 166, 0.5)' : 'rgba(242, 84, 75, 0.5)',
        });
      }
      return {
        pane: ctx.pane,
        guides: [{ value: 0, color: 'rgba(107, 122, 148, 0.35)' }],
        plots: [
          {
            id: 'hist',
            label: 'Histogram',
            kind: 'HISTOGRAM',
            color: 'rgba(107,122,148,0.4)',
            lineWidth: 1,
            lineStyle: 'SOLID',
            opacity: 1,
            points: histogram,
          },
          plot(bars, result.macd, { id: 'macd', label: 'MACD', color: '#4d8dff', ...styleOf(params) }),
          plot(bars, result.signal, { id: 'signal', label: 'Signal', color: '#f5a524', ...styleOf(params) }),
        ],
      };
    },
  },
  {
    kind: 'ATR',
    name: 'Average true range',
    category: 'Volatility',
    overlay: false,
    description: "Wilder's average of the true range. In price units, not percent.",
    params: [PERIOD, COLOUR, ...STYLE],
    defaults: { ...STYLE_DEFAULTS, period: 14, color: '#f5a524' },
    compute: (bars, params, ctx) => ({
      pane: ctx.pane,
      plots: [
        plot(bars, atr(bars, num(params, 'period', 14)), {
          id: 'atr',
          label: `ATR ${num(params, 'period', 14)}`,
          color: colourOf(params, 'color', '#f5a524'),
          ...styleOf(params),
        }),
      ],
    }),
  },
];

export function indicatorDef(kind: string): IndicatorDef | null {
  return INDICATORS.find((def) => def.kind === kind) ?? null;
}

/** One indicator the trader has added, with the parameters they chose. */
export interface IndicatorInstance {
  readonly id: string;
  readonly kind: string;
  readonly params: ParamValues;
  readonly visible: boolean;
}

/**
 * Search the catalogue.
 *
 * Matches the name, the kind and the category, so "osc" finds the oscillators
 * and "rsi" finds the one indicator.
 */
export function searchIndicators(query: string): readonly IndicatorDef[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return INDICATORS;
  return INDICATORS.filter((def) =>
    `${def.name} ${def.kind} ${def.category}`.toLowerCase().includes(needle),
  );
}

/**
 * How an instance describes itself: its short name and the inputs that matter.
 *
 * "EMA 21 close" rather than "Exponential moving average", because the length
 * is the thing a trader needs to see without opening anything. The legend rows
 * and the indicator menu both use this, so an instance is called the same
 * thing wherever it appears.
 */
export function indicatorTitle(kind: string, params: ParamValues): string {
  const def = indicatorDef(kind);
  const parts: string[] = [];
  for (const param of def?.params ?? []) {
    if (param.type === 'COLOR' || param.type === 'LINE_STYLE') continue;
    if (param.key === 'lineWidth' || param.key === 'opacity') continue;
    const value = params[param.key];
    if (value === undefined || value === '') continue;
    // Smoothing off is the default and says nothing; smoothing on has to show.
    if (param.key === 'smoothing') {
      if (Number(value) > 1) parts.push(`smoothed ${value}`);
      continue;
    }
    parts.push(String(value));
  }
  const name = indicatorShortName(kind);
  return parts.length > 0 ? `${name} ${parts.join(' ')}` : name;
}

/** The abbreviation a chart puts on the plot, not the catalogue's full name. */
export function indicatorShortName(kind: string): string {
  switch (kind) {
    case 'SMA':
      return 'MA';
    case 'BOLL':
      return 'BB';
    case 'VOLUME':
      return 'Volume';
    default:
      return kind;
  }
}
