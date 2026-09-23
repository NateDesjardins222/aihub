/**
 * The tool catalogue.
 *
 * A tool is DATA: its name, family, how many anchors it takes, its defaults,
 * and the properties it understands. The property editor, the context menu and
 * the templates are all generated from `props`, so a tool cannot end up with an
 * editor that offers settings it ignores, or ignore settings the editor offers.
 *
 * Pure, and free of React and of the chart library, so the catalogue can be
 * tested on its own.
 */
import {
  ANCHOR_COUNT,
  DEFAULT_STYLE,
  FIB_LEVELS,
  KIND_LABEL,
  type Drawing,
  type DrawingKind,
  type DrawingStyle,
  type FibLevel,
  type ToolOptions,
} from './model';

export type PropType =
  | 'COLOR'
  /** A colour and its own opacity, as one control. */
  | 'COLOR_ALPHA'
  | 'NUMBER'
  | 'DASH'
  | 'BOOLEAN'
  | 'TEXT'
  | 'SELECT'
  | 'LEVELS';

export interface PropDef {
  /** A key on `style` when `on` is 'STYLE', otherwise a key in `options`. */
  readonly key: string;
  readonly label: string;
  readonly type: PropType;
  readonly on: 'STYLE' | 'OPTIONS' | 'TEXT';
  readonly group: 'Appearance' | 'Levels' | 'Labels' | 'Extend' | 'Text';
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: ReadonlyArray<{ id: string; label: string }>;
  readonly hint?: string;
  /** For COLOR_ALPHA: the style key holding this colour's opacity. */
  readonly alphaKey?: string;
  /** For COLOR_ALPHA: the style key that turns the fill on and off. */
  readonly toggleKey?: string;
}

export type ToolFamily =
  | 'LINES'
  | 'CHANNELS'
  | 'ARROWS'
  | 'FIBONACCI'
  | 'SHAPES'
  | 'ANNOTATION'
  | 'MEASURE'
  | 'POSITION';

export interface ToolDef {
  readonly kind: DrawingKind;
  readonly name: string;
  readonly family: ToolFamily;
  readonly anchors: number;
  readonly style: Partial<DrawingStyle>;
  readonly options: ToolOptions;
  readonly props: readonly PropDef[];
}

const COLOR: PropDef = { key: 'color', label: 'Colour', type: 'COLOR', on: 'STYLE', group: 'Appearance' };
/** Border colour and border opacity, which are separate settings. */
const BORDER: PropDef = {
  key: 'color',
  label: 'Border',
  type: 'COLOR_ALPHA',
  on: 'STYLE',
  group: 'Appearance',
  alphaKey: 'opacity',
};
const FILL_COLOR: PropDef = {
  key: 'fillColor',
  label: 'Fill',
  type: 'COLOR_ALPHA',
  on: 'STYLE',
  group: 'Appearance',
  alphaKey: 'fillOpacity',
  toggleKey: 'filled',
  hint: 'Keep this low: the candles underneath have to stay readable',
};
const WIDTH: PropDef = {
  key: 'width',
  label: 'Thickness',
  type: 'NUMBER',
  on: 'STYLE',
  group: 'Appearance',
  min: 1,
  max: 6,
  step: 1,
};
const DASH: PropDef = { key: 'dash', label: 'Line style', type: 'DASH', on: 'STYLE', group: 'Appearance' };
const SHOW_PRICE: PropDef = {
  key: 'showPrice',
  label: 'Price label',
  type: 'BOOLEAN',
  on: 'STYLE',
  group: 'Labels',
};
const FONT_SIZE: PropDef = {
  key: 'fontSize',
  label: 'Text size',
  type: 'NUMBER',
  on: 'STYLE',
  group: 'Text',
  min: 8,
  max: 32,
  step: 1,
};

const EXTEND_LEFT: PropDef = {
  key: 'extendLeft',
  label: 'Extend left',
  type: 'BOOLEAN',
  on: 'OPTIONS',
  group: 'Extend',
};
const EXTEND_RIGHT: PropDef = {
  key: 'extendRight',
  label: 'Extend right',
  type: 'BOOLEAN',
  on: 'OPTIONS',
  group: 'Extend',
};

/** The classic retracement set, as editable levels. */
export function defaultFibLevels(color = '#6b7a94'): FibLevel[] {
  return FIB_LEVELS.map((value) => ({ value, color, visible: true }));
}

/**
 * What a position tool carries beyond its three anchors.
 *
 * `qty` and `accountSize` are what turn ticks into money and money into a
 * percentage of the account. Zero means "do not tell me": the tool then shows
 * the trade in prices and ticks alone rather than inventing a number.
 */
const POSITION_OPTIONS: ToolOptions = {
  qty: 1,
  accountSize: 0,
  profitColor: '#2ec4a6',
  lossColor: '#f2544b',
  zoneOpacity: 0.14,
  showTicks: true,
  // Money is opt-in: a planning drawing's first questions are "how far" and
  // "how many times my risk" (points and R). Dollars follow only when the
  // trader turns them on, so the default overlay stays clean rather than
  // stacking a $ figure the plan did not ask for.
  showMoney: false,
  showRatio: true,
};

const POSITION_PROPS: readonly PropDef[] = [
  {
    key: 'qty',
    label: 'Contracts',
    type: 'NUMBER',
    on: 'OPTIONS',
    group: 'Appearance',
    min: 0,
    max: 999,
    step: 1,
    hint: 'Used to price the risk and the reward. It never places an order',
  },
  {
    key: 'accountSize',
    label: 'Account size',
    type: 'NUMBER',
    on: 'OPTIONS',
    group: 'Appearance',
    min: 0,
    max: 100_000_000,
    step: 1_000,
    hint: 'Shows the risk as a percentage of this. Zero leaves it out',
  },
  {
    key: 'profitColor',
    label: 'Target zone',
    type: 'COLOR',
    on: 'OPTIONS',
    group: 'Appearance',
  },
  { key: 'lossColor', label: 'Stop zone', type: 'COLOR', on: 'OPTIONS', group: 'Appearance' },
  {
    key: 'zoneOpacity',
    label: 'Zone opacity',
    type: 'NUMBER',
    on: 'OPTIONS',
    group: 'Appearance',
    min: 0,
    max: 1,
    step: 0.02,
  },
  FONT_SIZE,
  { key: 'showRatio', label: 'Risk/reward', type: 'BOOLEAN', on: 'OPTIONS', group: 'Labels' },
  { key: 'showTicks', label: 'Ticks', type: 'BOOLEAN', on: 'OPTIONS', group: 'Labels' },
  { key: 'showMoney', label: 'Money', type: 'BOOLEAN', on: 'OPTIONS', group: 'Labels' },
  SHOW_PRICE,
];

export const TOOLS: readonly ToolDef[] = [
  {
    kind: 'TREND_LINE',
    name: KIND_LABEL.TREND_LINE,
    family: 'LINES',
    anchors: ANCHOR_COUNT.TREND_LINE,
    style: {},
    options: { extendLeft: false, extendRight: false },
    props: [
      COLOR,
      WIDTH,
      DASH,
      EXTEND_LEFT,
      EXTEND_RIGHT,
      { key: 'text', label: 'Text', type: 'TEXT', on: 'TEXT', group: 'Text' },
      SHOW_PRICE,
    ],
  },
  {
    kind: 'RAY',
    name: KIND_LABEL.RAY,
    family: 'LINES',
    anchors: ANCHOR_COUNT.RAY,
    style: {},
    options: {},
    props: [COLOR, WIDTH, DASH, SHOW_PRICE],
  },
  {
    kind: 'EXTENDED_LINE',
    name: KIND_LABEL.EXTENDED_LINE,
    family: 'LINES',
    anchors: ANCHOR_COUNT.EXTENDED_LINE,
    style: {},
    options: {},
    props: [COLOR, WIDTH, DASH, SHOW_PRICE],
  },
  {
    kind: 'HORIZONTAL_LINE',
    name: KIND_LABEL.HORIZONTAL_LINE,
    family: 'LINES',
    anchors: ANCHOR_COUNT.HORIZONTAL_LINE,
    style: { showPrice: true },
    options: {},
    props: [COLOR, WIDTH, DASH, SHOW_PRICE],
  },
  {
    kind: 'VERTICAL_LINE',
    name: KIND_LABEL.VERTICAL_LINE,
    family: 'LINES',
    anchors: ANCHOR_COUNT.VERTICAL_LINE,
    style: {},
    options: {},
    props: [COLOR, WIDTH, DASH],
  },
  {
    kind: 'HORIZONTAL_RAY',
    name: KIND_LABEL.HORIZONTAL_RAY,
    family: 'LINES',
    anchors: ANCHOR_COUNT.HORIZONTAL_RAY,
    style: { showPrice: true },
    options: {},
    props: [COLOR, WIDTH, DASH, SHOW_PRICE],
  },
  {
    kind: 'CROSS_LINE',
    name: KIND_LABEL.CROSS_LINE,
    family: 'LINES',
    anchors: ANCHOR_COUNT.CROSS_LINE,
    style: { dash: 'DASHED', showPrice: true },
    options: {},
    props: [COLOR, WIDTH, DASH, SHOW_PRICE],
  },
  {
    kind: 'ARROW',
    name: KIND_LABEL.ARROW,
    family: 'ARROWS',
    anchors: ANCHOR_COUNT.ARROW,
    style: { width: 2 },
    options: {},
    props: [COLOR, WIDTH, DASH],
  },
  {
    kind: 'RECTANGLE',
    name: KIND_LABEL.RECTANGLE,
    family: 'SHAPES',
    anchors: ANCHOR_COUNT.RECTANGLE,
    // Filled by default, at an opacity that leaves every candle inside it
    // readable. A default that hides price action is a broken default.
    style: { filled: true, fillColor: '#5b9dff', fillOpacity: 0.08 },
    options: { extendLeft: false, extendRight: false },
    props: [
      BORDER,
      WIDTH,
      DASH,
      FILL_COLOR,
      EXTEND_LEFT,
      EXTEND_RIGHT,
      { key: 'text', label: 'Text', type: 'TEXT', on: 'TEXT', group: 'Text' },
      SHOW_PRICE,
    ],
  },
  {
    kind: 'FIB_RETRACEMENT',
    name: KIND_LABEL.FIB_RETRACEMENT,
    family: 'FIBONACCI',
    anchors: ANCHOR_COUNT.FIB_RETRACEMENT,
    style: { color: '#6b7a94' },
    options: {
      levels: defaultFibLevels(),
      reverse: false,
      extendLeft: false,
      extendRight: false,
      // Price beside each level is OFF by default: the clean, TradingView-like
      // default is the level percentage alone (0.0% / 23.6% / 38.2% / …). A
      // trader who wants the price at each level turns "Show prices" on.
      showPrices: false,
      showPercents: true,
      labelSide: 'LEFT',
      background: false,
      shadeOpacity: 0.07,
      trendLine: true,
    },
    props: [
      COLOR,
      WIDTH,
      DASH,
      {
        key: 'levels',
        label: 'Levels',
        type: 'LEVELS',
        on: 'OPTIONS',
        group: 'Levels',
        hint: 'Add, remove, recolour or hide any level, and enter one of your own',
      },
      {
        key: 'reverse',
        label: 'Reverse',
        type: 'BOOLEAN',
        on: 'OPTIONS',
        group: 'Levels',
        hint: 'Swap which anchor counts as zero',
      },
      {
        key: 'showPercents',
        label: 'Show levels',
        type: 'BOOLEAN',
        on: 'OPTIONS',
        group: 'Labels',
      },
      { key: 'showPrices', label: 'Show prices', type: 'BOOLEAN', on: 'OPTIONS', group: 'Labels' },
      {
        key: 'labelSide',
        label: 'Labels',
        type: 'SELECT',
        on: 'OPTIONS',
        group: 'Labels',
        options: [
          { id: 'LEFT', label: 'Left' },
          { id: 'RIGHT', label: 'Right' },
        ],
      },
      {
        key: 'background',
        label: 'Shade between levels',
        type: 'BOOLEAN',
        on: 'OPTIONS',
        group: 'Appearance',
      },
      {
        key: 'shadeOpacity',
        label: 'Shade opacity',
        type: 'NUMBER',
        on: 'OPTIONS',
        group: 'Appearance',
        min: 0,
        max: 1,
        step: 0.01,
        hint: 'Keep it low: the candles inside the bands have to stay readable',
      },
      {
        key: 'trendLine',
        label: 'Trend line',
        type: 'BOOLEAN',
        on: 'OPTIONS',
        group: 'Appearance',
        hint: 'The line joining the two anchors',
      },
      EXTEND_LEFT,
      EXTEND_RIGHT,
    ],
  },
  {
    kind: 'TEXT',
    name: KIND_LABEL.TEXT,
    family: 'ANNOTATION',
    anchors: ANCHOR_COUNT.TEXT,
    style: { color: '#e8edf7', fontSize: 13 },
    options: {},
    props: [
      { key: 'text', label: 'Text', type: 'TEXT', on: 'TEXT', group: 'Text' },
      COLOR,
      FONT_SIZE,
    ],
  },
  {
    kind: 'MEASURE',
    name: KIND_LABEL.MEASURE,
    family: 'MEASURE',
    anchors: ANCHOR_COUNT.MEASURE,
    style: {},
    options: {},
    props: [COLOR, WIDTH, FONT_SIZE],
  },
  /*
   * The position tools.
   *
   * They plan a trade; they never place one. Nothing here reaches the order
   * router, the account or the engine - a drawing is a drawing, and the only
   * way to get a fill in Atlas is to submit an order, server-side, on purpose.
   */
  {
    kind: 'LONG_POSITION',
    name: KIND_LABEL.LONG_POSITION,
    family: 'POSITION',
    anchors: ANCHOR_COUNT.LONG_POSITION,
    style: { color: '#8a97ad', fontSize: 11 },
    options: { ...POSITION_OPTIONS },
    props: POSITION_PROPS,
  },
  {
    kind: 'SHORT_POSITION',
    name: KIND_LABEL.SHORT_POSITION,
    family: 'POSITION',
    anchors: ANCHOR_COUNT.SHORT_POSITION,
    style: { color: '#8a97ad', fontSize: 11 },
    options: { ...POSITION_OPTIONS },
    props: POSITION_PROPS,
  },
];

export function toolDef(kind: DrawingKind): ToolDef | null {
  return TOOLS.find((tool) => tool.kind === kind) ?? null;
}

/** A new drawing's style, from the workspace default plus the tool's own. */
export function styleFor(kind: DrawingKind, base: DrawingStyle): DrawingStyle {
  return { ...base, ...(toolDef(kind)?.style ?? {}) };
}

/** A new drawing's options. Copied, so two drawings never share level arrays. */
export function optionsFor(kind: DrawingKind): ToolOptions {
  const defaults = toolDef(kind)?.options ?? {};
  return JSON.parse(JSON.stringify(defaults)) as ToolOptions;
}

/**
 * Read an option with a fallback to the tool's default.
 *
 * A drawing made before an option existed simply has the default, which is what
 * lets the catalogue grow without migrating everything a trader has drawn.
 */
export function option<T>(drawing: Drawing, key: string, fallback: T): T {
  const own = drawing.options[key];
  if (own !== undefined) return own as T;
  const def = toolDef(drawing.kind)?.options[key];
  return (def === undefined ? fallback : (def as T));
}

/** Tools grouped for the rail and the menus, in display order. */
// Category headers, named to match the TradingView reference the rebuild
// targets: Lines / Arrows / Shapes / Fibonacci / Projection / Annotation /
// Measurer.
export const FAMILY_LABEL: Record<ToolFamily, string> = {
  LINES: 'Lines',
  CHANNELS: 'Channels',
  ARROWS: 'Arrows',
  FIBONACCI: 'Fibonacci',
  SHAPES: 'Shapes',
  ANNOTATION: 'Annotation',
  MEASURE: 'Measurer',
  POSITION: 'Projection',
};

export function toolsByFamily(): Array<{ family: ToolFamily; tools: readonly ToolDef[] }> {
  const order: ToolFamily[] = [
    'LINES',
    'ARROWS',
    'SHAPES',
    'FIBONACCI',
    'POSITION',
    'ANNOTATION',
    'MEASURE',
  ];
  return order
    .map((family) => ({ family, tools: TOOLS.filter((tool) => tool.family === family) }))
    .filter((group) => group.tools.length > 0);
}

/** A saved set of settings for one tool, reusable for ever. */
export interface DrawingTemplate {
  readonly id: string;
  readonly kind: DrawingKind;
  readonly name: string;
  readonly style: DrawingStyle;
  readonly options: ToolOptions;
}

export function templateFrom(drawing: Drawing, name: string, id: string): DrawingTemplate {
  return {
    id,
    kind: drawing.kind,
    name,
    style: { ...DEFAULT_STYLE, ...drawing.style },
    options: JSON.parse(JSON.stringify(drawing.options)) as ToolOptions,
  };
}

/**
 * Level presets for the Fibonacci family.
 *
 * A trader who works a particular method wants their own levels, not the
 * textbook set: the optimal-trade-entry band between 0.62 and 0.79 is a
 * different tool from a classic retracement even though both are "fib".
 * Presets are data here and copied on use, so editing one drawing's levels
 * never edits another's.
 */
export interface FibPreset {
  readonly id: string;
  readonly name: string;
  readonly levels: readonly FibLevel[];
}

const NEUTRAL = '#6b7a94';
const KEY = '#f5a524';
const DEEP = '#2ec4a6';

export const FIB_PRESETS: readonly FibPreset[] = [
  {
    id: 'classic',
    name: 'Classic retracement',
    levels: [
      { value: 0, color: NEUTRAL, visible: true },
      { value: 0.236, color: NEUTRAL, visible: true },
      { value: 0.382, color: NEUTRAL, visible: true },
      { value: 0.5, color: KEY, visible: true },
      { value: 0.618, color: KEY, visible: true },
      { value: 0.786, color: NEUTRAL, visible: true },
      { value: 1, color: NEUTRAL, visible: true },
    ],
  },
  {
    id: 'ote',
    name: 'OTE (optimal trade entry)',
    levels: [
      { value: 0, color: NEUTRAL, visible: true },
      { value: 0.5, color: NEUTRAL, visible: true },
      { value: 0.62, color: KEY, visible: true },
      { value: 0.705, color: DEEP, visible: true },
      { value: 0.79, color: KEY, visible: true },
      { value: 1, color: NEUTRAL, visible: true },
    ],
  },
  {
    id: 'extensions',
    name: 'Extensions',
    levels: [
      { value: 0, color: NEUTRAL, visible: true },
      { value: 0.5, color: NEUTRAL, visible: true },
      { value: 1, color: NEUTRAL, visible: true },
      { value: 1.272, color: KEY, visible: true },
      { value: 1.618, color: KEY, visible: true },
      { value: 2, color: NEUTRAL, visible: true },
      { value: 2.618, color: NEUTRAL, visible: true },
    ],
  },
  {
    id: 'minimal',
    name: 'Minimal (0.5 / 0.618)',
    levels: [
      { value: 0, color: NEUTRAL, visible: true },
      { value: 0.5, color: KEY, visible: true },
      { value: 0.618, color: KEY, visible: true },
      { value: 1, color: NEUTRAL, visible: true },
    ],
  },
];

export function fibPreset(id: string): FibPreset | null {
  return FIB_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** Levels sorted and de-duplicated, which is what the paint routine expects. */
export function normalizeLevels(levels: readonly FibLevel[]): FibLevel[] {
  const seen = new Map<number, FibLevel>();
  for (const level of levels) {
    if (!Number.isFinite(level.value)) continue;
    const value = Math.round(level.value * 10_000) / 10_000;
    seen.set(value, { ...level, value });
  }
  return [...seen.values()].sort((a, b) => a.value - b.value);
}
