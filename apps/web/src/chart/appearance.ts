/**
 * How the chart looks.
 *
 * Pure data and pure functions: no React, no chart library, no I/O. The
 * settings dialog edits this, the adapter applies it, and the preferences
 * store persists it. Nothing here can reach a price, a fill or a calculation -
 * it decides colours, line widths and which labels are drawn.
 *
 * Every field has a default, and `normalizeAppearance` fills in whatever a
 * stored blob is missing. That matters because settings are persisted as an
 * opaque JSON blob written by an older version of this file.
 */

export type TimeFormat = '12H' | '24H';

export interface SymbolAppearance {
  /** Candle bodies. */
  readonly upColor: string;
  readonly downColor: string;
  readonly bodyVisible: boolean;
  /** Candle borders. */
  readonly borderVisible: boolean;
  readonly borderUpColor: string;
  readonly borderDownColor: string;
  /** Wicks. */
  readonly wickVisible: boolean;
  readonly wickUpColor: string;
  readonly wickDownColor: string;
  /** Line / area / baseline styles. */
  readonly lineColor: string;
  readonly lineWidth: number;
  readonly areaTopColor: string;
  readonly areaBottomColor: string;
  /** Volume histogram. */
  /** Precision of the last-price marker on the scale. */
  readonly lastPriceLineVisible: boolean;
  readonly highLowMarkersVisible: boolean;
}

export interface StatusLineAppearance {
  readonly symbolVisible: boolean;
  readonly ohlcVisible: boolean;
  readonly changeVisible: boolean;
  readonly volumeVisible: boolean;
  readonly barCloseCountdownVisible: boolean;
  readonly barCountVisible: boolean;
  readonly updatedAtVisible: boolean;
  readonly indicatorTitlesVisible: boolean;
}

export interface ScalesAppearance {
  readonly priceScaleVisible: boolean;
  /** Which side the price scale sits on. */
  readonly priceScaleSide: 'RIGHT' | 'LEFT';
  readonly timeScaleVisible: boolean;
  readonly scaleTextColor: string;
  readonly scaleLineColor: string;
  readonly scaleFontSize: number;
  readonly logScale: boolean;
  readonly percentScale: boolean;
  readonly autoScale: boolean;
  readonly gridVerticalVisible: boolean;
  readonly gridHorizontalVisible: boolean;
  readonly gridColor: string;
  readonly sessionBreaksVisible: boolean;
  readonly sessionBreakColor: string;
  readonly paneSeparatorColor: string;
  /**
   * The crosshair's SHAPE. Snapping is a separate question - see
   * `crosshairMagnet` - because "magnet" was never a shape and having it in
   * this list meant a trader could not have a snapping vertical-only
   * crosshair, or any of the other combinations.
   */
  readonly crosshairStyle: 'CROSS' | 'DOT' | 'VERTICAL' | 'HORIZONTAL' | 'HIDDEN';
  /** Snap the crosshair to the nearest bar rather than following the pointer. */
  readonly crosshairMagnet: boolean;
  readonly crosshairColor: string;
  readonly crosshairLabelBackground: string;
  /** Thickness in pixels, 1 to 3. */
  readonly crosshairWidth: number;
  readonly crosshairDash: 'SOLID' | 'DASHED' | 'DOTTED';
  /** How strongly the crosshair is drawn, 0.2 to 1. */
  readonly crosshairOpacity: number;
  /** The price chip on the axis, and the time chip under the plot. */
  readonly crosshairPriceLabel: boolean;
  readonly crosshairTimeLabel: boolean;
  /** Top and bottom breathing room, as a fraction of the pane. */
  readonly scaleMarginTop: number;
  readonly scaleMarginBottom: number;
}

export interface CanvasAppearance {
  readonly background: string;
  /** A second colour turns the background into a vertical gradient. */
  readonly backgroundGradientTo: string | null;
  readonly textColor: string;
  readonly fontSize: number;
  readonly watermarkVisible: boolean;
  readonly watermarkText: string;
}

export interface ChartAppearance {
  readonly symbol: SymbolAppearance;
  readonly statusLine: StatusLineAppearance;
  readonly scales: ScalesAppearance;
  readonly canvas: CanvasAppearance;
  readonly timeFormat: TimeFormat;
  /** An IANA zone, or 'EXCHANGE' to follow the instrument. */
  readonly timeZone: string;
}

export const DEFAULT_APPEARANCE: ChartAppearance = {
  symbol: {
    upColor: '#2ec4a6',
    downColor: '#f2544b',
    bodyVisible: true,
    borderVisible: true,
    borderUpColor: '#2ec4a6',
    borderDownColor: '#f2544b',
    wickVisible: true,
    wickUpColor: '#2ec4a6',
    wickDownColor: '#f2544b',
    lineColor: '#4d8dff',
    lineWidth: 2,
    areaTopColor: 'rgba(77, 141, 255, 0.34)',
    areaBottomColor: 'rgba(77, 141, 255, 0.02)',
    lastPriceLineVisible: true,
    highLowMarkersVisible: false,
  },
  statusLine: {
    symbolVisible: true,
    ohlcVisible: true,
    changeVisible: true,
    volumeVisible: true,
    barCloseCountdownVisible: true,
    barCountVisible: false,
    updatedAtVisible: false,
    indicatorTitlesVisible: true,
  },
  scales: {
    priceScaleVisible: true,
    priceScaleSide: 'RIGHT',
    timeScaleVisible: true,
    scaleTextColor: '#9aa6bd',
    scaleLineColor: '#242d3e',
    scaleFontSize: 11,
    logScale: false,
    percentScale: false,
    autoScale: true,
    gridVerticalVisible: true,
    gridHorizontalVisible: true,
    gridColor: '#151b26',
    sessionBreaksVisible: true,
    sessionBreakColor: 'rgba(99, 112, 138, 0.35)',
    paneSeparatorColor: '#242d3e',
    crosshairStyle: 'CROSS',
    crosshairMagnet: false,
    crosshairColor: '#4d8dff',
    crosshairLabelBackground: '#2a5199',
    crosshairWidth: 1,
    crosshairDash: 'DASHED',
    crosshairOpacity: 0.9,
    crosshairPriceLabel: true,
    crosshairTimeLabel: true,
    scaleMarginTop: 0.08,
    scaleMarginBottom: 0.22,
  },
  canvas: {
    background: '#0b0e14',
    backgroundGradientTo: null,
    textColor: '#9aa6bd',
    fontSize: 11,
    watermarkVisible: false,
    watermarkText: '',
  },
  timeFormat: '12H',
  timeZone: 'EXCHANGE',
};

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function colour(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Fill in a partial (or foreign, or corrupt) appearance blob.
 *
 * A stored preference is untrusted input: it was written by a different build
 * and may be missing fields, carry nulls, or carry numbers outside any sane
 * range. Every value is either accepted or replaced by the default - nothing
 * is allowed through that would make the chart unreadable.
 */
export function normalizeAppearance(raw: unknown): ChartAppearance {
  const input = (raw ?? {}) as Partial<ChartAppearance>;
  const d = DEFAULT_APPEARANCE;
  const s = (input.symbol ?? {}) as Partial<SymbolAppearance>;
  const l = (input.statusLine ?? {}) as Partial<StatusLineAppearance>;
  const c = (input.scales ?? {}) as Partial<ScalesAppearance>;
  const v = (input.canvas ?? {}) as Partial<CanvasAppearance>;

  return {
    symbol: {
      upColor: colour(s.upColor, d.symbol.upColor),
      downColor: colour(s.downColor, d.symbol.downColor),
      bodyVisible: flag(s.bodyVisible, d.symbol.bodyVisible),
      borderVisible: flag(s.borderVisible, d.symbol.borderVisible),
      borderUpColor: colour(s.borderUpColor, d.symbol.borderUpColor),
      borderDownColor: colour(s.borderDownColor, d.symbol.borderDownColor),
      wickVisible: flag(s.wickVisible, d.symbol.wickVisible),
      wickUpColor: colour(s.wickUpColor, d.symbol.wickUpColor),
      wickDownColor: colour(s.wickDownColor, d.symbol.wickDownColor),
      lineColor: colour(s.lineColor, d.symbol.lineColor),
      lineWidth: clamp(Number(s.lineWidth), 1, 6, d.symbol.lineWidth),
      areaTopColor: colour(s.areaTopColor, d.symbol.areaTopColor),
      areaBottomColor: colour(s.areaBottomColor, d.symbol.areaBottomColor),
      lastPriceLineVisible: flag(s.lastPriceLineVisible, d.symbol.lastPriceLineVisible),
      highLowMarkersVisible: flag(s.highLowMarkersVisible, d.symbol.highLowMarkersVisible),
    },
    statusLine: {
      symbolVisible: flag(l.symbolVisible, d.statusLine.symbolVisible),
      ohlcVisible: flag(l.ohlcVisible, d.statusLine.ohlcVisible),
      changeVisible: flag(l.changeVisible, d.statusLine.changeVisible),
      volumeVisible: flag(l.volumeVisible, d.statusLine.volumeVisible),
      barCloseCountdownVisible: flag(
        l.barCloseCountdownVisible,
        d.statusLine.barCloseCountdownVisible,
      ),
      barCountVisible: flag(l.barCountVisible, d.statusLine.barCountVisible),
      updatedAtVisible: flag(l.updatedAtVisible, d.statusLine.updatedAtVisible),
      indicatorTitlesVisible: flag(l.indicatorTitlesVisible, d.statusLine.indicatorTitlesVisible),
    },
    scales: {
      priceScaleVisible: flag(c.priceScaleVisible, d.scales.priceScaleVisible),
      priceScaleSide: c.priceScaleSide === 'LEFT' ? 'LEFT' : 'RIGHT',
      timeScaleVisible: flag(c.timeScaleVisible, d.scales.timeScaleVisible),
      scaleTextColor: colour(c.scaleTextColor, d.scales.scaleTextColor),
      scaleLineColor: colour(c.scaleLineColor, d.scales.scaleLineColor),
      scaleFontSize: clamp(Number(c.scaleFontSize), 8, 18, d.scales.scaleFontSize),
      logScale: flag(c.logScale, d.scales.logScale),
      percentScale: flag(c.percentScale, d.scales.percentScale),
      autoScale: flag(c.autoScale, d.scales.autoScale),
      gridVerticalVisible: flag(c.gridVerticalVisible, d.scales.gridVerticalVisible),
      gridHorizontalVisible: flag(c.gridHorizontalVisible, d.scales.gridHorizontalVisible),
      gridColor: colour(c.gridColor, d.scales.gridColor),
      sessionBreaksVisible: flag(c.sessionBreaksVisible, d.scales.sessionBreaksVisible),
      sessionBreakColor: colour(c.sessionBreakColor, d.scales.sessionBreakColor),
      paneSeparatorColor: colour(c.paneSeparatorColor, d.scales.paneSeparatorColor),
      /*
       * 'MAGNET' used to be one of the shapes. A workspace saved under the old
       * scheme is read as a CROSS that snaps, which is what it was showing.
       */
      crosshairStyle:
        c.crosshairStyle === 'DOT' ||
        c.crosshairStyle === 'VERTICAL' ||
        c.crosshairStyle === 'HORIZONTAL' ||
        c.crosshairStyle === 'HIDDEN'
          ? c.crosshairStyle
          : 'CROSS',
      crosshairMagnet: flag(
        c.crosshairMagnet,
        // A legacy value: 'MAGNET' is not a member of the current union, so it
        // is read as the string it was stored as.
        (c.crosshairStyle as string | undefined) === 'MAGNET',
      ),
      crosshairColor: colour(c.crosshairColor, d.scales.crosshairColor),
      crosshairLabelBackground: colour(
        c.crosshairLabelBackground,
        d.scales.crosshairLabelBackground,
      ),
      crosshairWidth: clamp(Number(c.crosshairWidth), 1, 3, d.scales.crosshairWidth),
      crosshairDash:
        c.crosshairDash === 'SOLID' || c.crosshairDash === 'DOTTED'
          ? c.crosshairDash
          : d.scales.crosshairDash,
      crosshairOpacity: clamp(Number(c.crosshairOpacity), 0.2, 1, d.scales.crosshairOpacity),
      crosshairPriceLabel: flag(c.crosshairPriceLabel, d.scales.crosshairPriceLabel),
      crosshairTimeLabel: flag(c.crosshairTimeLabel, d.scales.crosshairTimeLabel),
      scaleMarginTop: clamp(Number(c.scaleMarginTop), 0, 0.4, d.scales.scaleMarginTop),
      scaleMarginBottom: clamp(Number(c.scaleMarginBottom), 0, 0.6, d.scales.scaleMarginBottom),
    },
    canvas: {
      background: colour(v.background, d.canvas.background),
      backgroundGradientTo:
        typeof v.backgroundGradientTo === 'string' && v.backgroundGradientTo.trim().length > 0
          ? v.backgroundGradientTo
          : null,
      textColor: colour(v.textColor, d.canvas.textColor),
      fontSize: clamp(Number(v.fontSize), 8, 18, d.canvas.fontSize),
      watermarkVisible: flag(v.watermarkVisible, d.canvas.watermarkVisible),
      watermarkText: typeof v.watermarkText === 'string' ? v.watermarkText.slice(0, 40) : '',
    },
    timeFormat: input.timeFormat === '24H' ? '24H' : '12H',
    timeZone:
      typeof input.timeZone === 'string' && input.timeZone.trim().length > 0
        ? input.timeZone
        : d.timeZone,
  };
}

/** The zone labels actually belong in: the instrument's, unless overridden. */
export function resolveZone(appearance: ChartAppearance, exchangeZone: string): string {
  return appearance.timeZone === 'EXCHANGE' ? exchangeZone : appearance.timeZone;
}

/**
 * One time formatter for the whole application.
 *
 * 12-hour with AM/PM by default, because that is how the instruments we trade
 * are talked about in their home session, and because it is what was asked for.
 */
/**
 * Formatters are CACHED.
 *
 * Constructing an Intl.DateTimeFormat is expensive - it was the single largest
 * piece of application JavaScript during a crosshair sweep, because the legend
 * built a new one for every bar it displayed. The settings that decide the
 * format change when a trader changes them, which is roughly never, so one
 * formatter per combination is kept.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

export function timeFormatter(
  appearance: ChartAppearance,
  exchangeZone: string,
  opts?: { seconds?: boolean; date?: boolean },
): Intl.DateTimeFormat {
  const zone = resolveZone(appearance, exchangeZone);
  const key = `${zone}|${appearance.timeFormat}|${opts?.seconds ? 's' : ''}|${opts?.date ? 'd' : ''}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    ...(opts?.date ? { month: 'short', day: '2-digit' } : {}),
    hour: 'numeric',
    minute: '2-digit',
    ...(opts?.seconds ? { second: '2-digit' } : {}),
    hour12: appearance.timeFormat === '12H',
    timeZone: zone,
  });
  formatters.set(key, formatter);
  return formatter;
}
