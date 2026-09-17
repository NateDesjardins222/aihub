/**
 * Chart appearance, indicators and drawings.
 *
 * One store, because all three are per-chart presentation and all three are
 * persisted together. The chart reads it and applies it; nothing in it is ever
 * read by the order path.
 *
 * Drawings are keyed by symbol: a trend line drawn on NQ belongs to NQ, and
 * switching instrument must not carry it across.
 */
import { create } from 'zustand';
import {
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  type ChartAppearance,
} from '../chart/appearance';
import type { ChartType } from '../chart/ChartAdapter';
import { indicatorDef, type IndicatorInstance, type ParamValues } from '../chart/indicators/registry';
import {
  ANCHOR_COUNT,
  DEFAULT_STYLE,
  normalizeStyle,
  type Drawing,
  type DrawingKind,
  type DrawingStyle,
  type ToolOptions,
} from '../chart/drawings/model';
import {
  optionsFor,
  styleFor,
  templateFrom,
  toolDef,
  type DrawingTemplate,
} from '../chart/drawings/registry';

export type DrawingTool = DrawingKind | 'CURSOR';

export type MagnetMode = 'OFF' | 'WEAK' | 'STRONG';

interface ChartState {
  appearance: ChartAppearance;
  chartType: ChartType;
  indicators: readonly IndicatorInstance[];
  /** Every drawing, for every instrument. */
  drawings: readonly Drawing[];
  /** The tool the next click uses. Returns to CURSOR after a drawing is made. */
  tool: DrawingTool;
  /** Keep the chosen tool armed for repeated use. */
  toolSticky: boolean;
  /**
   * How hard an anchor is pulled to a price the bar printed.
   *
   * OFF leaves it exactly where the pointer is. WEAK only snaps when the
   * pointer is already close to an open, high, low or close, which is what
   * makes it feel like help rather than interference. STRONG always takes the
   * nearest of the four.
   */
  magnet: MagnetMode;
  selectedDrawingId: string | null;
  /** Tools the trader pinned to the top of the rail. */
  favouriteTools: readonly DrawingKind[];
  /** The style new drawings are created with. */
  defaultStyle: DrawingStyle;

  setAppearance: (patch: DeepPartial<ChartAppearance>) => void;
  resetAppearance: () => void;
  setChartType: (type: ChartType) => void;

  addIndicator: (kind: string) => string;
  removeIndicator: (id: string) => void;
  updateIndicator: (id: string, patch: ParamValues | { visible: boolean }) => void;
  toggleIndicator: (id: string) => void;
  /** Another instance of the same indicator, with the same settings. */
  duplicateIndicator: (id: string) => void;
  /**
   * Which indicator's settings panel is open.
   *
   * UI state in the chart store rather than in a component, because the thing
   * that ADDS an indicator (the header's picker) and the thing that shows its
   * settings (the chart) are in different parts of the tree - and adding an
   * EMA without seeing its length was the complaint.
   */
  indicatorSettingsFor: string | null;
  openIndicatorSettings: (id: string | null) => void;

  setTool: (tool: DrawingTool, sticky?: boolean) => void;
  setMagnet: (mode: MagnetMode) => void;
  /** Cycles OFF -> WEAK -> STRONG -> OFF, for the toolbar button. */
  cycleMagnet: () => void;
  /** The drawing on the clipboard, if any. Copy keeps style and geometry. */
  clipboard: Drawing | null;
  copyDrawing: (id: string) => void;
  /** Paste onto an instrument, offset so the copy is visible as a copy. */
  pasteDrawing: (symbol: string) => void;
  toggleFavouriteTool: (kind: DrawingKind) => void;
  /** Undo history, as whole drawing sets. See the note on pushHistory. */
  history: readonly (readonly Drawing[])[];
  historyIndex: number;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Record the current state as an undo step, if it differs from the last. */
  commitHistory: () => void;

  /** Saved settings a trader can re-apply to any drawing of the same kind. */
  templates: readonly DrawingTemplate[];
  /** Per-tool overrides for what a NEW drawing of that kind starts as. */
  toolDefaults: Readonly<Record<string, ToolDefault>>;

  addDrawing: (drawing: Drawing) => void;
  updateDrawing: (id: string, patch: Partial<Drawing>) => void;
  /** Patch one drawing's style, as one undo step. */
  setDrawingStyle: (id: string, patch: Partial<DrawingStyle>) => void;
  /** Patch one drawing's tool options, as one undo step. */
  setDrawingOptions: (id: string, patch: ToolOptions) => void;
  /** Move a drawing to the top or the bottom of the paint order. */
  reorderDrawing: (id: string, to: 'FRONT' | 'BACK') => void;

  saveTemplate: (drawingId: string, name: string) => void;
  removeTemplate: (templateId: string) => void;
  applyTemplate: (templateId: string, drawingId: string) => void;
  /** Make this drawing's settings the starting point for its tool. */
  setToolDefault: (drawingId: string) => void;
  resetToolDefault: (kind: DrawingKind) => void;
  /** What a new drawing of this kind starts as. */
  newDrawingDefaults: (kind: DrawingKind) => ToolDefault;
  removeDrawing: (id: string) => void;
  duplicateDrawing: (id: string) => void;
  clearDrawings: (symbol: string) => void;
  select: (id: string | null) => void;
  /**
   * The object whose settings dialog is open, if any.
   *
   * In the store rather than in the chart panel because three different places
   * open it - a double-click, the context menu and the object tree - and they
   * should not have to thread a callback to each other.
   */
  propertiesFor: string | null;
  openProperties: (id: string) => void;
  closeProperties: () => void;
  setDefaultStyle: (patch: Partial<DrawingStyle>) => void;

  restore: (stored: StoredChart) => void;
  snapshot: () => StoredChart;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface StoredChart {
  appearance?: unknown;
  chartType?: string;
  indicators?: readonly IndicatorInstance[];
  drawings?: readonly Drawing[];
  favouriteTools?: readonly DrawingKind[];
  defaultStyle?: Partial<DrawingStyle>;
  magnet?: unknown;
  templates?: unknown;
  toolDefaults?: unknown;
}

/** A style and option pair: what a tool draws with until told otherwise. */
export interface ToolDefault {
  readonly style: DrawingStyle;
  readonly options: ToolOptions;
}

/**
 * Colours for the second and later instance of the same indicator.
 *
 * Deliberately far apart on the wheel: EMA 9 / 21 / 50 / 200 have to be
 * distinguishable at a glance without opening anything.
 */
const INSTANCE_COLOURS: readonly string[] = [
  '#4d8dff',
  '#7de08a',
  '#ff5a5a',
  '#c792ea',
  '#3fd0c9',
  '#f0a5d8',
];

const CHART_TYPES: readonly ChartType[] = [
  'CANDLES',
  'HOLLOW_CANDLES',
  'BARS',
  'LINE',
  'LINE_WITH_MARKERS',
  'AREA',
  'BASELINE',
  'HEIKIN_ASHI',
];

/** See DrawingLayer.newId: identifiers never come from a random NUMBER. */
function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function merge<T>(base: T, patch: DeepPartial<T>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    const current = out[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      out[key] = merge(current, value as DeepPartial<unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

export const HISTORY_DEPTH = 100;

export const DEFAULT_FAVOURITE_TOOLS: readonly DrawingKind[] = [
  'TREND_LINE',
  'HORIZONTAL_LINE',
  'RECTANGLE',
  'FIB_RETRACEMENT',
];

export const useChartStore = create<ChartState>((set, get) => ({
  appearance: DEFAULT_APPEARANCE,
  chartType: 'CANDLES',
  indicators: [],
  drawings: [],
  tool: 'CURSOR',
  toolSticky: false,
  magnet: 'WEAK',
  clipboard: null,
  selectedDrawingId: null,
  favouriteTools: DEFAULT_FAVOURITE_TOOLS,
  defaultStyle: DEFAULT_STYLE,
  templates: [],
  toolDefaults: {},
  propertiesFor: null,
  history: [[]],
  historyIndex: 0,

  setAppearance(patch) {
    set({ appearance: normalizeAppearance(merge(get().appearance, patch)) });
  },

  resetAppearance() {
    set({ appearance: DEFAULT_APPEARANCE });
  },

  setChartType(type) {
    set({ chartType: type });
  },

  addIndicator(kind) {
    const def = indicatorDef(kind);
    // An unknown kind adds nothing and has no instance to point at.
    if (!def) return '';
    // The id is returned so the caller can open the new instance's settings:
    // adding an EMA and not being able to see its length was the complaint.
    const instanceId = id('ind');
    /*
     * A second EMA in the same colour as the first is two lines a trader
     * cannot tell apart. Each further instance of a kind takes the next
     * colour in the palette; the first keeps the indicator's own default.
     */
    const sameKind = get().indicators.filter((instance) => instance.kind === kind).length;
    const params: ParamValues = { ...def.defaults };
    if (sameKind > 0 && typeof params['color'] === 'string') {
      params['color'] = INSTANCE_COLOURS[(sameKind - 1) % INSTANCE_COLOURS.length] ?? params['color'];
    }
    set({
      indicators: [...get().indicators, { id: instanceId, kind, params, visible: true }],
    });
    return instanceId;
  },

  indicatorSettingsFor: null,

  openIndicatorSettings(instanceId) {
    set({ indicatorSettingsFor: instanceId });
  },

  duplicateIndicator(instanceId) {
    const source = get().indicators.find((instance) => instance.id === instanceId);
    if (!source) return;
    set({
      indicators: [
        ...get().indicators,
        { ...source, id: id('ind'), params: { ...source.params } },
      ],
    });
  },

  removeIndicator(instanceId) {
    set({ indicators: get().indicators.filter((instance) => instance.id !== instanceId) });
  },

  updateIndicator(instanceId, patch) {
    /*
     * One entry point for both a parameter change and a visibility change.
     *
     * `visible` is a property of the INSTANCE rather than one of the
     * indicator's inputs, so it is recognised here rather than being written
     * into the params where the compute function would ignore it.
     */
    const visibility = 'visible' in patch ? (patch as { visible: boolean }) : null;
    set({
      indicators: get().indicators.map((instance) =>
        instance.id === instanceId
          ? visibility
            ? { ...instance, visible: visibility.visible }
            : { ...instance, params: { ...instance.params, ...(patch as ParamValues) } }
          : instance,
      ),
    });
  },

  toggleIndicator(instanceId) {
    set({
      indicators: get().indicators.map((instance) =>
        instance.id === instanceId ? { ...instance, visible: !instance.visible } : instance,
      ),
    });
  },

  setTool(tool, sticky = false) {
    set({ tool, toolSticky: sticky, selectedDrawingId: tool === 'CURSOR' ? get().selectedDrawingId : null });
  },

  setMagnet(mode) {
    set({ magnet: mode });
  },

  cycleMagnet() {
    const order: MagnetMode[] = ['OFF', 'WEAK', 'STRONG'];
    const index = order.indexOf(get().magnet);
    set({ magnet: order[(index + 1) % order.length]! });
  },

  copyDrawing(drawingId) {
    const drawing = get().drawings.find((item) => item.id === drawingId);
    if (!drawing) return;
    set({ clipboard: { ...drawing, anchors: drawing.anchors.map((anchor) => ({ ...anchor })) } });
  },

  /**
   * Paste.
   *
   * Onto whichever instrument is in front of the trader, offset slightly in
   * price so the copy is visibly a copy rather than sitting invisibly on top
   * of the original.
   */
  pasteDrawing(symbol) {
    const source = get().clipboard;
    if (!source) return;
    const span = source.anchors.reduce((max, anchor) => Math.max(max, Math.abs(anchor.price)), 0);
    const nudge = span * 0.004;
    const copy: Drawing = {
      ...source,
      id: id('draw'),
      symbol,
      anchors: source.anchors.map((anchor) => ({ ...anchor, price: anchor.price - nudge })),
      createdAt: Date.now(),
    };
    set({ drawings: [...get().drawings, copy], selectedDrawingId: copy.id });
    get().commitHistory();
  },

  toggleFavouriteTool(kind) {
    const current = get().favouriteTools;
    set({
      favouriteTools: current.includes(kind)
        ? current.filter((tool) => tool !== kind)
        : [...current, kind],
    });
  },

  /**
   * Record an undo step.
   *
   * History holds whole drawing SETS rather than per-tool diffs. The sets share
   * structure - an unchanged drawing is the same object in both - so a hundred
   * steps of a hundred drawings is a hundred arrays of pointers, not a hundred
   * copies. It is also the one shape that cannot be got wrong per tool.
   *
   * Dragging is deliberately NOT recorded per frame: a drag commits one step
   * when the pointer is released, which is what a trader means by "undo that".
   */
  commitHistory() {
    const { drawings, history, historyIndex } = get();
    if (history[historyIndex] === drawings) return;
    const truncated = history.slice(0, historyIndex + 1);
    const next = [...truncated, drawings].slice(-HISTORY_DEPTH);
    set({ history: next, historyIndex: next.length - 1 });
  },

  undo() {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const index = historyIndex - 1;
    set({ historyIndex: index, drawings: history[index] ?? [], selectedDrawingId: null, propertiesFor: null });
  },

  redo() {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const index = historyIndex + 1;
    set({ historyIndex: index, drawings: history[index] ?? [], selectedDrawingId: null, propertiesFor: null });
  },

  canUndo() {
    return get().historyIndex > 0;
  },

  canRedo() {
    return get().historyIndex < get().history.length - 1;
  },

  addDrawing(drawing) {
    set({
      drawings: [...get().drawings, drawing],
      // A finished drawing is selected, so its style can be edited at once.
      selectedDrawingId: drawing.id,
      tool: get().toolSticky ? get().tool : 'CURSOR',
    });
    get().commitHistory();
  },

  updateDrawing(drawingId, patch) {
    set({
      drawings: get().drawings.map((drawing) =>
        drawing.id === drawingId ? { ...drawing, ...patch } : drawing,
      ),
    });
  },

  /**
   * Style and options are patched through their own actions rather than
   * `updateDrawing` so that each edit is ONE undo step. Dragging commits on
   * release; a property edit commits on the edit.
   */
  setDrawingStyle(drawingId, patch) {
    const drawing = get().drawings.find((d) => d.id === drawingId);
    if (!drawing) return;
    get().updateDrawing(drawingId, { style: { ...drawing.style, ...patch } });
    get().commitHistory();
  },

  setDrawingOptions(drawingId, patch) {
    const drawing = get().drawings.find((d) => d.id === drawingId);
    if (!drawing) return;
    get().updateDrawing(drawingId, { options: { ...drawing.options, ...patch } });
    get().commitHistory();
  },

  /**
   * Paint order is array order, so "bring to front" is a move to the end.
   * It also decides what a click picks, since hit-testing walks the array
   * backwards: the thing drawn on top is the thing you grab.
   */
  reorderDrawing(drawingId, to) {
    const drawings = get().drawings;
    const index = drawings.findIndex((d) => d.id === drawingId);
    if (index < 0) return;
    const drawing = drawings[index]!;
    const rest = [...drawings.slice(0, index), ...drawings.slice(index + 1)];
    set({ drawings: to === 'FRONT' ? [...rest, drawing] : [drawing, ...rest] });
    get().commitHistory();
  },

  saveTemplate(drawingId, name) {
    const drawing = get().drawings.find((d) => d.id === drawingId);
    const trimmed = name.trim();
    if (!drawing || trimmed.length === 0) return;
    set({ templates: [...get().templates, templateFrom(drawing, trimmed, id('tpl'))] });
  },

  removeTemplate(templateId) {
    set({ templates: get().templates.filter((template) => template.id !== templateId) });
  },

  /**
   * Applying a template changes only how a drawing LOOKS. Its anchors are
   * where the trader put them and a template must never move them.
   */
  applyTemplate(templateId, drawingId) {
    const template = get().templates.find((item) => item.id === templateId);
    const drawing = get().drawings.find((d) => d.id === drawingId);
    if (!template || !drawing || template.kind !== drawing.kind) return;
    get().updateDrawing(drawingId, {
      style: { ...template.style },
      options: copyOptions(template.options),
    });
    get().commitHistory();
  },

  setToolDefault(drawingId) {
    const drawing = get().drawings.find((d) => d.id === drawingId);
    if (!drawing) return;
    set({
      toolDefaults: {
        ...get().toolDefaults,
        [drawing.kind]: { style: { ...drawing.style }, options: copyOptions(drawing.options) },
      },
    });
  },

  resetToolDefault(kind) {
    const next = { ...get().toolDefaults };
    delete next[kind];
    set({ toolDefaults: next });
  },

  newDrawingDefaults(kind) {
    const saved = get().toolDefaults[kind];
    if (saved) return { style: { ...saved.style }, options: copyOptions(saved.options) };
    return { style: styleFor(kind, get().defaultStyle), options: optionsFor(kind) };
  },

  removeDrawing(drawingId) {
    set({
      drawings: get().drawings.filter((drawing) => drawing.id !== drawingId),
      selectedDrawingId: get().selectedDrawingId === drawingId ? null : get().selectedDrawingId,
      propertiesFor: get().propertiesFor === drawingId ? null : get().propertiesFor,
    });
    get().commitHistory();
  },

  duplicateDrawing(drawingId) {
    const source = get().drawings.find((drawing) => drawing.id === drawingId);
    if (!source) return;
    // Offset a little in price so the copy is visibly a copy rather than
    // sitting invisibly on top of the original.
    const span = source.anchors.reduce((max, anchor) => Math.max(max, Math.abs(anchor.price)), 0);
    const nudge = span * 0.004;
    const copy: Drawing = {
      ...source,
      id: id('draw'),
      anchors: source.anchors.map((anchor) => ({ ...anchor, price: anchor.price - nudge })),
      createdAt: Date.now(),
    };
    set({ drawings: [...get().drawings, copy], selectedDrawingId: copy.id });
    get().commitHistory();
  },

  clearDrawings(symbol) {
    const removed = get().drawings.filter((drawing) => drawing.symbol === symbol);
    set({
      drawings: get().drawings.filter((drawing) => drawing.symbol !== symbol),
      selectedDrawingId: null,
      propertiesFor: removed.some((drawing) => drawing.id === get().propertiesFor)
        ? null
        : get().propertiesFor,
    });
    get().commitHistory();
  },

  select(drawingId) {
    set({ selectedDrawingId: drawingId });
  },

  openProperties(drawingId) {
    set({ propertiesFor: drawingId, selectedDrawingId: drawingId });
  },

  closeProperties() {
    set({ propertiesFor: null });
  },

  setDefaultStyle(patch) {
    const style = { ...get().defaultStyle, ...patch };
    set({ defaultStyle: style });
    // Editing the style with something selected edits THAT, which is what a
    // trader means when they open the style bar on a selected object.
    const selected = get().selectedDrawingId;
    if (selected) get().updateDrawing(selected, { style });
  },

  restore(stored) {
    const chartType =
      typeof stored.chartType === 'string' && (CHART_TYPES as string[]).includes(stored.chartType)
        ? (stored.chartType as ChartType)
        : 'CANDLES';
    set({
      appearance: normalizeAppearance(stored.appearance),
      chartType,
      indicators: sanitizeIndicators(stored.indicators),
      drawings: sanitizeDrawings(stored.drawings),
      favouriteTools:
        Array.isArray(stored.favouriteTools) && stored.favouriteTools.length > 0
          ? stored.favouriteTools.filter((kind) => kind in ANCHOR_COUNT)
          : DEFAULT_FAVOURITE_TOOLS,
      defaultStyle: normalizeStyle(stored.defaultStyle),
      magnet: readMagnet(stored.magnet),
      templates: sanitizeTemplates(stored.templates),
      toolDefaults: sanitizeToolDefaults(stored.toolDefaults),
      // A restored workspace is the first undo step, not something to undo to.
      history: [sanitizeDrawings(stored.drawings)],
      historyIndex: 0,
      selectedDrawingId: null,
      propertiesFor: null,
    });
  },

  snapshot() {
    const state = get();
    return {
      appearance: state.appearance,
      chartType: state.chartType,
      indicators: state.indicators,
      drawings: state.drawings,
      favouriteTools: state.favouriteTools,
      defaultStyle: state.defaultStyle,
      magnet: state.magnet,
      templates: state.templates,
      toolDefaults: state.toolDefaults,
    };
  },
}));

/** Options are copied on every hand-off, so two drawings never share an array. */
function copyOptions(options: ToolOptions): ToolOptions {
  return JSON.parse(JSON.stringify(options)) as ToolOptions;
}

function sanitizeTemplates(raw: unknown): readonly DrawingTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: DrawingTemplate[] = [];
  for (const item of raw) {
    const candidate = item as Partial<DrawingTemplate>;
    if (typeof candidate.kind !== 'string' || !toolDef(candidate.kind as DrawingKind)) continue;
    if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0) continue;
    out.push({
      id: typeof candidate.id === 'string' ? candidate.id : id('tpl'),
      kind: candidate.kind as DrawingKind,
      name: candidate.name,
      // Through the normaliser, so a workspace saved before border and fill
      // were separate comes back as the drawing the trader made rather than as
      // a shape with no interior.
      style: normalizeStyle(candidate.style),
      options: sanitizeOptions(candidate.options),
    });
  }
  return out;
}

function sanitizeToolDefaults(raw: unknown): Record<string, ToolDefault> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, ToolDefault> = {};
  for (const [kind, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!toolDef(kind as DrawingKind)) continue;
    const candidate = value as Partial<ToolDefault>;
    out[kind] = {
      style: normalizeStyle(candidate?.style),
      options: sanitizeOptions(candidate?.options),
    };
  }
  return out;
}

/** A workspace saved before magnet modes existed carries a boolean. */
function readMagnet(raw: unknown): MagnetMode {
  if (raw === 'OFF' || raw === 'WEAK' || raw === 'STRONG') return raw;
  if (raw === false) return 'OFF';
  return 'WEAK';
}

/** Stored preferences are untrusted input: an unknown indicator is dropped. */
function sanitizeIndicators(raw: unknown): readonly IndicatorInstance[] {
  if (!Array.isArray(raw)) return [];
  const out: IndicatorInstance[] = [];
  for (const item of raw) {
    const candidate = item as Partial<IndicatorInstance>;
    if (typeof candidate.kind !== 'string' || !indicatorDef(candidate.kind)) continue;
    out.push({
      id: typeof candidate.id === 'string' ? candidate.id : id('ind'),
      kind: candidate.kind,
      params: (candidate.params ?? {}) as ParamValues,
      visible: candidate.visible !== false,
    });
  }
  return out;
}

/**
 * Options come back from storage as whatever was written there, which on a
 * tampered or half-migrated workspace could be anything at all. Keeping only a
 * plain object means a bad value can never reach a paint routine.
 */
function sanitizeOptions(raw: unknown): ToolOptions {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return { ...(raw as ToolOptions) };
}

function sanitizeDrawings(raw: unknown): readonly Drawing[] {
  if (!Array.isArray(raw)) return [];
  const out: Drawing[] = [];
  for (const item of raw) {
    const candidate = item as Partial<Drawing>;
    if (typeof candidate.kind !== 'string' || !(candidate.kind in ANCHOR_COUNT)) continue;
    if (typeof candidate.symbol !== 'string') continue;
    if (!Array.isArray(candidate.anchors) || candidate.anchors.length === 0) continue;
    const anchors = candidate.anchors.filter(
      (anchor) => Number.isFinite(anchor?.time) && Number.isFinite(anchor?.price),
    );
    if (anchors.length !== ANCHOR_COUNT[candidate.kind as DrawingKind]) continue;
    out.push({
      id: typeof candidate.id === 'string' ? candidate.id : id('draw'),
      kind: candidate.kind as DrawingKind,
      symbol: candidate.symbol,
      anchors,
      // Through the normaliser, so a workspace saved before border and fill
      // were separate comes back as the drawing the trader made rather than as
      // a shape with no interior.
      style: normalizeStyle(candidate.style),
      options: sanitizeOptions(candidate.options),
      text: typeof candidate.text === 'string' ? candidate.text : '',
      locked: candidate.locked === true,
      hidden: candidate.hidden === true,
      timeframes: Array.isArray(candidate.timeframes)
        ? candidate.timeframes.filter((interval): interval is string => typeof interval === 'string')
        : [],
      createdAt: Number.isFinite(candidate.createdAt) ? candidate.createdAt! : Date.now(),
    });
  }
  return out;
}
