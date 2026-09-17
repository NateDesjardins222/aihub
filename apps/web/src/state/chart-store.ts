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
  type Drawing,
  type DrawingKind,
  type DrawingStyle,
} from '../chart/drawings/model';

export type DrawingTool = DrawingKind | 'CURSOR';

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
  magnet: boolean;
  selectedDrawingId: string | null;
  /** Tools the trader pinned to the top of the rail. */
  favouriteTools: readonly DrawingKind[];
  /** The style new drawings are created with. */
  defaultStyle: DrawingStyle;

  setAppearance: (patch: DeepPartial<ChartAppearance>) => void;
  resetAppearance: () => void;
  setChartType: (type: ChartType) => void;

  addIndicator: (kind: string) => void;
  removeIndicator: (id: string) => void;
  updateIndicator: (id: string, params: ParamValues) => void;
  toggleIndicator: (id: string) => void;

  setTool: (tool: DrawingTool, sticky?: boolean) => void;
  toggleMagnet: () => void;
  toggleFavouriteTool: (kind: DrawingKind) => void;
  addDrawing: (drawing: Drawing) => void;
  updateDrawing: (id: string, patch: Partial<Drawing>) => void;
  removeDrawing: (id: string) => void;
  duplicateDrawing: (id: string) => void;
  clearDrawings: (symbol: string) => void;
  select: (id: string | null) => void;
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
  magnet?: boolean;
}

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

function id(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
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
  magnet: true,
  selectedDrawingId: null,
  favouriteTools: DEFAULT_FAVOURITE_TOOLS,
  defaultStyle: DEFAULT_STYLE,

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
    if (!def) return;
    set({
      indicators: [
        ...get().indicators,
        { id: id('ind'), kind, params: { ...def.defaults }, visible: true },
      ],
    });
  },

  removeIndicator(instanceId) {
    set({ indicators: get().indicators.filter((instance) => instance.id !== instanceId) });
  },

  updateIndicator(instanceId, params) {
    set({
      indicators: get().indicators.map((instance) =>
        instance.id === instanceId ? { ...instance, params: { ...instance.params, ...params } } : instance,
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

  toggleMagnet() {
    set({ magnet: !get().magnet });
  },

  toggleFavouriteTool(kind) {
    const current = get().favouriteTools;
    set({
      favouriteTools: current.includes(kind)
        ? current.filter((tool) => tool !== kind)
        : [...current, kind],
    });
  },

  addDrawing(drawing) {
    set({
      drawings: [...get().drawings, drawing],
      // A finished drawing is selected, so its style can be edited at once.
      selectedDrawingId: drawing.id,
      tool: get().toolSticky ? get().tool : 'CURSOR',
    });
  },

  updateDrawing(drawingId, patch) {
    set({
      drawings: get().drawings.map((drawing) =>
        drawing.id === drawingId ? { ...drawing, ...patch } : drawing,
      ),
    });
  },

  removeDrawing(drawingId) {
    set({
      drawings: get().drawings.filter((drawing) => drawing.id !== drawingId),
      selectedDrawingId: get().selectedDrawingId === drawingId ? null : get().selectedDrawingId,
    });
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
  },

  clearDrawings(symbol) {
    set({
      drawings: get().drawings.filter((drawing) => drawing.symbol !== symbol),
      selectedDrawingId: null,
    });
  },

  select(drawingId) {
    set({ selectedDrawingId: drawingId });
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
      defaultStyle: { ...DEFAULT_STYLE, ...(stored.defaultStyle ?? {}) },
      magnet: typeof stored.magnet === 'boolean' ? stored.magnet : true,
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
    };
  },
}));

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
      style: { ...DEFAULT_STYLE, ...(candidate.style ?? {}) },
      text: typeof candidate.text === 'string' ? candidate.text : '',
      locked: candidate.locked === true,
      hidden: candidate.hidden === true,
      createdAt: Number.isFinite(candidate.createdAt) ? candidate.createdAt! : Date.now(),
    });
  }
  return out;
}
