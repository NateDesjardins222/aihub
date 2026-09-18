/**
 * A small set of themes, and what a theme actually is.
 *
 * Two surfaces have to agree for a terminal to look like one thing: the chart,
 * which is painted on a canvas from `ChartAppearance`, and everything around
 * it, which is HTML styled from the design tokens in `theme.css`. A "theme"
 * that changed only one of them would be a chart that does not match its own
 * window, so a preset here carries both.
 *
 * Deliberately FIVE, and deliberately not a marketplace. The brief asked for a
 * small set that all look good; a hundred themes is a hundred chances to look
 * bad, and every one of them is a surface nobody has checked at 900px with a
 * position open.
 *
 * Pure data. Nothing here can reach a price.
 */
import { DEFAULT_APPEARANCE, type ChartAppearance } from './appearance';

/**
 * A built-in preset, or a custom theme's id.
 *
 * Deliberately a plain string rather than a union of the five: a theme the
 * trader saved is a theme, and making it a different KIND of thing is how
 * every call site ends up with a branch in it.
 */
export type ThemeId = string;

export const BUILT_IN: readonly string[] = [
  'ATLAS_DARK',
  'MIDNIGHT',
  'GRAPHITE',
  'OLED',
  'CLEAN_LIGHT',
];

/**
 * The three colours a trader actually chooses, and what is derived from them.
 *
 * `--long` is not one token: it is four, because a filled box, a bright P&L
 * figure and a faint background tint all have to stay in step with it. Asking
 * a trader to pick four shades of green that work together is a form to fill
 * in; asking for one and deriving the rest is a choice. The derivation is
 * `color-mix`, so the browser does the colour arithmetic.
 */
export interface AccentColours {
  /** Selection, working orders, links. */
  readonly accent: string;
  /** Profit, long positions, take-profit levels. */
  readonly long: string;
  /** Loss, short positions, stop levels. */
  readonly short: string;
}

/** Every custom property a theme or an override may set. */
export function derivedTokens(accents: AccentColours): Record<string, string> {
  const family = (name: string, base: string): Record<string, string> => ({
    [`--${name}`]: base,
    [`--${name}-bright`]: `color-mix(in srgb, ${base} 72%, white)`,
    [`--${name}-dim`]: `color-mix(in srgb, ${base} 62%, black)`,
    [`--${name}-bg`]: `color-mix(in srgb, ${base} 14%, transparent)`,
  });
  return {
    ...family('long', accents.long),
    ...family('short', accents.short),
    '--accent': accents.accent,
    '--accent-dim': `color-mix(in srgb, ${accents.accent} 62%, black)`,
    '--accent-bg': `color-mix(in srgb, ${accents.accent} 14%, transparent)`,
    // The filled P&L boxes: dark enough that white type stays legible on them.
    '--pos-fill': `color-mix(in srgb, ${accents.long} 66%, black)`,
    '--neg-fill': `color-mix(in srgb, ${accents.short} 70%, black)`,
    '--danger': accents.short,
  };
}

/** The tokens a theme is allowed to move. Everything else stays as authored. */
export interface SurfaceTokens {
  readonly '--bg-void': string;
  readonly '--bg-base': string;
  readonly '--bg-panel': string;
  readonly '--bg-raised': string;
  readonly '--bg-hover': string;
  readonly '--bg-active': string;
  readonly '--bg-input': string;
  readonly '--border-subtle': string;
  readonly '--border': string;
  readonly '--border-strong': string;
  readonly '--text-primary': string;
  readonly '--text-secondary': string;
  readonly '--text-muted': string;
  readonly '--text-disabled': string;
  /** Type on a filled long/short box, which is a saturated colour either way. */
  readonly '--on-fill': string;
  /** A hairline over a surface: white on dark themes, black on light ones. */
  readonly '--hairline': string;
}

/**
 * The chart half of a theme: COLOURS, and nothing else.
 *
 * Deliberately a partial rather than a whole appearance. A theme decides what
 * the terminal looks like; the trader decides whether the scale is logarithmic,
 * which shape the crosshair is, whether the volume is shown and how much
 * breathing room the price has. Carrying a full appearance here meant picking
 * Midnight also put the crosshair back to a cross and the scale back to linear,
 * which is a theme reaching into settings that are none of its business.
 */
export interface ThemeChart {
  readonly symbol: {
    readonly upColor: string;
    readonly downColor: string;
    readonly borderUpColor: string;
    readonly borderDownColor: string;
    readonly wickUpColor: string;
    readonly wickDownColor: string;
  };
  readonly scales: {
    readonly gridColor: string;
    readonly scaleLineColor: string;
    readonly scaleTextColor: string;
    readonly paneSeparatorColor: string;
    readonly crosshairColor: string;
    readonly crosshairLabelBackground: string;
    readonly sessionBreakColor: string;
  };
  readonly canvas: {
    readonly background: string;
    readonly backgroundGradientTo: string | null;
    readonly textColor: string;
  };
}

export interface ThemePreset {
  readonly id: ThemeId;
  readonly name: string;
  readonly description: string;
  /** Light themes need different contrast rules in a few places. */
  readonly light: boolean;
  readonly surface: SurfaceTokens;
  readonly accents: AccentColours;
  readonly chart: ThemeChart;
}

/**
 * A theme the trader made, saved beside the five that shipped.
 *
 * The same shape as a preset, because that is what it is: the brief asks for
 * save, rename, duplicate, delete and set-default, and every one of those is
 * simpler when a custom theme is not a special case of a preset but another
 * one of them.
 */
export interface CustomTheme {
  readonly id: string;
  readonly name: string;
  readonly light: boolean;
  readonly surface: SurfaceTokens;
  readonly accents: AccentColours;
  readonly chart: ThemeChart;
  /** The preset it started from, for the card's subtitle. */
  readonly base: string;
}

/** A theme's chart half, expressed as the differences from the defaults. */
function chart(patch: {
  background: string;
  gradientTo?: string | null;
  text: string;
  grid: string;
  scaleLine: string;
  scaleText: string;
  up: string;
  down: string;
  crosshair: string;
  crosshairLabel: string;
  sessionBreak: string;
}): ThemeChart {
  return {
    symbol: {
      upColor: patch.up,
      downColor: patch.down,
      borderUpColor: patch.up,
      borderDownColor: patch.down,
      wickUpColor: patch.up,
      wickDownColor: patch.down,
    },
    scales: {
      gridColor: patch.grid,
      scaleLineColor: patch.scaleLine,
      scaleTextColor: patch.scaleText,
      paneSeparatorColor: patch.scaleLine,
      crosshairColor: patch.crosshair,
      crosshairLabelBackground: patch.crosshairLabel,
      sessionBreakColor: patch.sessionBreak,
    },
    canvas: {
      background: patch.background,
      backgroundGradientTo: patch.gradientTo ?? null,
      textColor: patch.text,
    },
  };
}

/** A theme's colours over a full appearance, leaving everything else alone. */
export function withTheme(
  appearance: ChartAppearance,
  id: ThemeId,
  custom: readonly CustomTheme[] = [],
): ChartAppearance {
  const theme = themeById(id, custom);
  return {
    ...appearance,
    symbol: { ...appearance.symbol, ...theme.chart.symbol },
    scales: { ...appearance.scales, ...theme.chart.scales },
    canvas: { ...appearance.canvas, ...theme.chart.canvas },
  };
}

export const THEMES: readonly ThemePreset[] = [
  {
    id: 'ATLAS_DARK',
    name: 'Atlas Dark',
    description: 'The default: a deep blue-grey workspace with a teal and red pair.',
    light: false,
    surface: {
      '--bg-void': '#070910',
      '--bg-base': '#0b0f18',
      '--bg-panel': '#111724',
      '--bg-raised': '#171f30',
      '--bg-hover': '#1f293c',
      '--bg-active': '#27334a',
      '--bg-input': '#0d1220',
      '--border-subtle': '#1a2231',
      '--border': '#25314a',
      '--border-strong': '#35445f',
      '--text-primary': '#e8edf7',
      '--text-secondary': '#9dabc4',
      '--text-muted': '#67758f',
      '--text-disabled': '#47536b',
      '--on-fill': '#ffffff',
      '--hairline': 'rgba(255, 255, 255, 0.14)',
    },
    accents: { accent: '#5b9dff', long: '#29d3a5', short: '#ff5a5a' },
    chart: chart({
      background: '#0b0e14',
      text: '#9aa6bd',
      grid: '#151b26',
      scaleLine: '#242d3e',
      scaleText: '#9aa6bd',
      up: '#2ec4a6',
      down: '#f2544b',
      crosshair: '#4d8dff',
      crosshairLabel: '#2a5199',
      sessionBreak: 'rgba(99, 112, 138, 0.35)',
    }),
  },
  {
    id: 'MIDNIGHT',
    name: 'Midnight',
    description: 'Colder and darker, with more separation between the panels.',
    light: false,
    surface: {
      '--bg-void': '#03060f',
      '--bg-base': '#060b18',
      '--bg-panel': '#0a1224',
      '--bg-raised': '#0f1b33',
      '--bg-hover': '#16253f',
      '--bg-active': '#1d2f4f',
      '--bg-input': '#060d1c',
      '--border-subtle': '#12203a',
      '--border': '#1c2f52',
      '--border-strong': '#2a4471',
      '--text-primary': '#e6eeff',
      '--text-secondary': '#94a8ca',
      '--text-muted': '#5f7294',
      '--text-disabled': '#3f4f6c',
      '--on-fill': '#ffffff',
      '--hairline': 'rgba(255, 255, 255, 0.14)',
    },
    accents: { accent: '#6aa9ff', long: '#22c3f0', short: '#ff5f7a' },
    chart: chart({
      background: '#050a16',
      text: '#94a8ca',
      grid: '#0e1730',
      scaleLine: '#1c2f52',
      scaleText: '#94a8ca',
      up: '#22c3f0',
      down: '#f2544b',
      crosshair: '#6aa9ff',
      crosshairLabel: '#1d4a94',
      sessionBreak: 'rgba(106, 169, 255, 0.28)',
    }),
  },
  {
    id: 'GRAPHITE',
    name: 'Graphite',
    description: 'Neutral greys with no colour cast, for long sessions.',
    light: false,
    surface: {
      '--bg-void': '#0a0a0b',
      '--bg-base': '#121213',
      '--bg-panel': '#1a1a1c',
      '--bg-raised': '#232326',
      '--bg-hover': '#2c2c30',
      '--bg-active': '#36363b',
      '--bg-input': '#141416',
      '--border-subtle': '#232326',
      '--border': '#323236',
      '--border-strong': '#45454b',
      '--text-primary': '#ececed',
      '--text-secondary': '#a6a6ab',
      '--text-muted': '#75757c',
      '--text-disabled': '#525258',
      '--on-fill': '#ffffff',
      '--hairline': 'rgba(255, 255, 255, 0.13)',
    },
    accents: { accent: '#b8b8bf', long: '#4bbf87', short: '#e2635c' },
    chart: chart({
      background: '#131315',
      text: '#a6a6ab',
      grid: '#1e1e21',
      scaleLine: '#323236',
      scaleText: '#a6a6ab',
      up: '#4bbf87',
      down: '#e2635c',
      crosshair: '#b8b8bf',
      crosshairLabel: '#45454b',
      sessionBreak: 'rgba(160, 160, 170, 0.3)',
    }),
  },
  {
    id: 'OLED',
    name: 'OLED',
    description: 'True black, for a panel that can switch its pixels off.',
    light: false,
    surface: {
      '--bg-void': '#000000',
      '--bg-base': '#000000',
      '--bg-panel': '#080808',
      '--bg-raised': '#111111',
      '--bg-hover': '#1a1a1a',
      '--bg-active': '#242424',
      '--bg-input': '#050505',
      '--border-subtle': '#151515',
      '--border': '#242424',
      '--border-strong': '#363636',
      '--text-primary': '#f2f2f2',
      '--text-secondary': '#a0a0a0',
      '--text-muted': '#6e6e6e',
      '--text-disabled': '#4a4a4a',
      '--on-fill': '#ffffff',
      '--hairline': 'rgba(255, 255, 255, 0.16)',
    },
    accents: { accent: '#8ab4ff', long: '#00d68f', short: '#ff4d4d' },
    chart: chart({
      background: '#000000',
      text: '#a0a0a0',
      grid: '#121212',
      scaleLine: '#242424',
      scaleText: '#a0a0a0',
      up: '#00d68f',
      down: '#ff4d4d',
      crosshair: '#8ab4ff',
      crosshairLabel: '#1f3f77',
      sessionBreak: 'rgba(255, 255, 255, 0.22)',
    }),
  },
  {
    id: 'CLEAN_LIGHT',
    name: 'Clean Light',
    description: 'A white workspace for a bright desk, printing and screen shares.',
    light: true,
    surface: {
      '--bg-void': '#e6e9ef',
      '--bg-base': '#f4f6fa',
      '--bg-panel': '#ffffff',
      '--bg-raised': '#f7f9fc',
      '--bg-hover': '#eaeef5',
      '--bg-active': '#dde4ef',
      '--bg-input': '#ffffff',
      '--border-subtle': '#e4e8ef',
      '--border': '#d2d9e4',
      '--border-strong': '#b3becd',
      '--text-primary': '#141922',
      '--text-secondary': '#4a5567',
      '--text-muted': '#6d7889',
      '--text-disabled': '#9aa3b1',
      '--on-fill': '#ffffff',
      '--hairline': 'rgba(0, 0, 0, 0.14)',
    },
    accents: { accent: '#2f6fd0', long: '#0f9d76', short: '#d93a31' },
    chart: chart({
      background: '#ffffff',
      text: '#4a5567',
      grid: '#eef1f6',
      scaleLine: '#d2d9e4',
      scaleText: '#4a5567',
      up: '#0f9d76',
      down: '#d93a31',
      crosshair: '#2f6fd0',
      crosshairLabel: '#2f6fd0',
      sessionBreak: 'rgba(90, 105, 130, 0.3)',
    }),
  },
];

export const DEFAULT_THEME: ThemeId = 'ATLAS_DARK';

/**
 * Any theme by id, built-in or the trader's own.
 *
 * Custom themes are passed in rather than imported, because this module is
 * pure data and the store is what holds what the trader saved.
 */
export function themeById(
  id: string | null | undefined,
  custom: readonly CustomTheme[] = [],
): ThemePreset {
  const own = custom.find((theme) => theme.id === id);
  if (own) {
    return {
      id: own.id,
      name: own.name,
      description: `Yours, from ${themeById(own.base).name}`,
      light: own.light,
      surface: own.surface,
      accents: own.accents,
      chart: own.chart,
    };
  }
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]!;
}

/**
 * Write a theme's tokens onto the document.
 *
 * Inline custom properties on `<html>`, so they beat the stylesheet's own
 * `:root` block without it having to know the themes exist. `data-theme`
 * carries the id for the handful of rules that genuinely need to know whether
 * the surface underneath them is dark or light.
 */
export function applyTheme(
  id: ThemeId,
  custom: readonly CustomTheme[] = [],
  /** Individual tokens the trader changed on top of the theme. */
  overrides: Readonly<Record<string, string>> = {},
): void {
  // The store this is called from is pure logic and is tested without a DOM.
  if (typeof document === 'undefined') return;
  const theme = themeById(id, custom);
  const root = document.documentElement;
  const tokens: Record<string, string> = {
    ...theme.surface,
    ...derivedTokens(theme.accents),
  };
  for (const [token, value] of Object.entries(tokens)) {
    root.style.setProperty(token, value);
  }
  /*
   * The trader's own tokens last, and the accent family re-derived from them.
   *
   * An override of `--accent` has to move `--accent-bg` with it or the
   * selection tint stays the old hue, which is the kind of half-applied theme
   * the brief calls out by name.
   */
  const accents: AccentColours = {
    accent: overrides['--accent'] ?? theme.accents.accent,
    long: overrides['--long'] ?? theme.accents.long,
    short: overrides['--short'] ?? theme.accents.short,
  };
  for (const [token, value] of Object.entries(derivedTokens(accents))) {
    root.style.setProperty(token, value);
  }
  for (const [token, value] of Object.entries(overrides)) {
    root.style.setProperty(token, value);
  }
  root.dataset['theme'] = theme.id;
  root.dataset['themeMode'] = theme.light ? 'light' : 'dark';
}

/** The tokens a trader may set by hand, in the order the settings show them. */
export const EDITABLE_TOKENS: ReadonlyArray<{ token: string; label: string; hint: string }> = [
  { token: '--bg-base', label: 'Workspace', hint: 'Behind everything' },
  { token: '--bg-panel', label: 'Panels', hint: 'The order ticket, the activity panel, menus' },
  { token: '--border', label: 'Borders', hint: 'The lines between panels' },
  { token: '--text-primary', label: 'Text', hint: 'Figures and labels that matter' },
  { token: '--accent', label: 'Accent', hint: 'Selection, links and working orders' },
  { token: '--long', label: 'Profit', hint: 'Profit, long positions and take-profit levels' },
  { token: '--short', label: 'Loss', hint: 'Loss, short positions and stop levels' },
];

/** What a token currently resolves to, for a control that has to show it. */
export function tokenValue(token: string, fallback = '#000000'): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value.length > 0 ? value : fallback;
}

/** Does this appearance still match the preset it came from? */
export function matchesTheme(
  appearance: ChartAppearance,
  id: ThemeId,
  custom: readonly CustomTheme[] = [],
): boolean {
  const theme = themeById(id, custom);
  return (
    appearance.canvas.background === theme.chart.canvas.background &&
    appearance.canvas.textColor === theme.chart.canvas.textColor &&
    appearance.scales.gridColor === theme.chart.scales.gridColor &&
    appearance.scales.scaleLineColor === theme.chart.scales.scaleLineColor &&
    appearance.scales.crosshairColor === theme.chart.scales.crosshairColor &&
    appearance.symbol.upColor === theme.chart.symbol.upColor &&
    appearance.symbol.downColor === theme.chart.symbol.downColor
  );
}
