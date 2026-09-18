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

export type ThemeId = 'ATLAS_DARK' | 'MIDNIGHT' | 'GRAPHITE' | 'OLED' | 'CLEAN_LIGHT';

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

export interface ThemePreset {
  readonly id: ThemeId;
  readonly name: string;
  readonly description: string;
  /** Light themes need different contrast rules in a few places. */
  readonly light: boolean;
  readonly surface: SurfaceTokens;
  readonly chart: ChartAppearance;
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
}): ChartAppearance {
  return {
    ...DEFAULT_APPEARANCE,
    symbol: {
      ...DEFAULT_APPEARANCE.symbol,
      upColor: patch.up,
      downColor: patch.down,
      borderUpColor: patch.up,
      borderDownColor: patch.down,
      wickUpColor: patch.up,
      wickDownColor: patch.down,
    },
    scales: {
      ...DEFAULT_APPEARANCE.scales,
      gridColor: patch.grid,
      scaleLineColor: patch.scaleLine,
      scaleTextColor: patch.scaleText,
      paneSeparatorColor: patch.scaleLine,
      crosshairColor: patch.crosshair,
      crosshairLabelBackground: patch.crosshairLabel,
      sessionBreakColor: patch.sessionBreak,
    },
    canvas: {
      ...DEFAULT_APPEARANCE.canvas,
      background: patch.background,
      backgroundGradientTo: patch.gradientTo ?? null,
      textColor: patch.text,
    },
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

export function themeById(id: string | null | undefined): ThemePreset {
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
export function applyTheme(id: ThemeId): void {
  // The store this is called from is pure logic and is tested without a DOM.
  if (typeof document === 'undefined') return;
  const theme = themeById(id);
  const root = document.documentElement;
  for (const [token, value] of Object.entries(theme.surface)) {
    root.style.setProperty(token, value);
  }
  root.dataset['theme'] = theme.id;
  root.dataset['themeMode'] = theme.light ? 'light' : 'dark';
}

/** Does this appearance still match the preset it came from? */
export function matchesTheme(appearance: ChartAppearance, id: ThemeId): boolean {
  const theme = themeById(id);
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
