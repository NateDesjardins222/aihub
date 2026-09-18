/**
 * The chart layout: how many charts, and what each one is showing.
 *
 * A terminal with one chart is a chart; a terminal a trader can work in has
 * two or four, each on its own instrument and its own interval, and says which
 * one the next keystroke belongs to. That is what this store holds.
 *
 * What lives HERE is per-chart: the instrument, the interval, the chart style
 * and the indicator instances. What stays in the chart store is workspace-wide
 * and shared on purpose: the appearance, the drawing tools, the templates, and
 * the drawings themselves, which are anchored to an INSTRUMENT - so the same
 * symbol in two panes shows the same objects, which is what a trader means by
 * a level they drew.
 */
import { create } from 'zustand';
import type { ChartType } from '../chart/ChartAdapter';
import {
  indicatorDef,
  type IndicatorInstance,
  type ParamValues,
} from '../chart/indicators/registry';

export type LayoutKind = 'ONE' | 'TWO_V' | 'TWO_H' | 'THREE' | 'FOUR';

/** How many charts each layout shows. */
export const PANE_COUNT: Record<LayoutKind, number> = {
  ONE: 1,
  TWO_V: 2,
  TWO_H: 2,
  THREE: 3,
  FOUR: 4,
};

export const LAYOUT_LABEL: Record<LayoutKind, string> = {
  ONE: 'Single chart',
  TWO_V: 'Two, side by side',
  TWO_H: 'Two, stacked',
  THREE: 'Three',
  FOUR: 'Four',
};

export interface PaneState {
  readonly id: string;
  /**
   * The instrument this chart shows, or null to follow the terminal's own.
   *
   * Null is the default for the first pane: the chart the trader is executing
   * on should be the chart the order ticket is pointed at, and a pane that
   * silently disagreed with the ticket would be a way to lose money.
   */
  readonly symbol: string | null;
  readonly timeframe: string;
  readonly chartType: ChartType;
  readonly indicators: readonly IndicatorInstance[];
  /**
   * How the chart's own height is divided between the price and the studies
   * below it, as one stretch factor per pane, or null while it is automatic.
   *
   * A trader who drags that line has made a reading decision, and a reading
   * decision belongs in the workspace beside the instrument and the interval.
   */
  readonly paneSplit: readonly number[] | null;
}

/** What is kept in step between panes. Everything is off until asked for. */
export interface SyncOptions {
  readonly crosshair: boolean;
  readonly time: boolean;
  readonly symbol: boolean;
  readonly interval: boolean;
}

export interface StoredLayout {
  readonly layout?: unknown;
  readonly panes?: unknown;
  readonly activePaneId?: unknown;
  readonly sync?: unknown;
}

interface LayoutStore {
  layout: LayoutKind;
  /** Four panes always exist; the layout decides how many are shown. */
  panes: readonly PaneState[];
  activePaneId: string;
  /** One pane filling the layout, while the others keep their settings. */
  maximizedPaneId: string | null;
  sync: SyncOptions;

  setLayout: (layout: LayoutKind) => void;
  setActivePane: (id: string) => void;
  maximizePane: (id: string | null) => void;
  setSync: (patch: Partial<SyncOptions>) => void;

  setPaneSymbol: (id: string, symbol: string | null) => void;
  setPaneTimeframe: (id: string, timeframe: string) => void;
  setPaneChartType: (id: string, chartType: ChartType) => void;
  setPaneSplit: (id: string, split: readonly number[] | null) => void;

  addIndicator: (paneId: string, kind: string) => string;
  removeIndicator: (id: string) => void;
  updateIndicator: (id: string, patch: ParamValues | { visible: boolean }) => void;
  toggleIndicator: (id: string) => void;
  duplicateIndicator: (id: string) => void;
  /** Which indicator instance has its settings panel open, across every pane. */
  indicatorSettingsFor: string | null;
  openIndicatorSettings: (id: string | null) => void;

  /** The panes the current layout shows. */
  visiblePanes: () => readonly PaneState[];
  paneOf: (indicatorId: string) => PaneState | null;

  snapshot: () => StoredLayout;
  restore: (stored: StoredLayout, legacy?: LegacyChart) => void;
}

/** The single-chart settings a terminal saved before it had panes. */
export interface LegacyChart {
  readonly chartType?: unknown;
  readonly indicators?: unknown;
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

const PANE_IDS = ['p1', 'p2', 'p3', 'p4'] as const;

function freshPane(id: string, timeframe: string): PaneState {
  return { id, symbol: null, timeframe, chartType: 'CANDLES', indicators: [], paneSplit: null };
}

function defaultPanes(): PaneState[] {
  // The extra panes open on longer intervals, because the reason to have four
  // charts is usually one instrument on four timeframes.
  const timeframes = ['1m', '5m', '15m', '1h'];
  return PANE_IDS.map((id, index) => freshPane(id, timeframes[index] ?? '1m'));
}

let counter = 0;
function instanceId(): string {
  counter += 1;
  return `ind-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export const useLayout = create<LayoutStore>((set, get) => ({
  layout: 'ONE',
  panes: defaultPanes(),
  activePaneId: 'p1',
  maximizedPaneId: null,
  sync: { crosshair: false, time: false, symbol: false, interval: false },

  setLayout(layout) {
    const count = PANE_COUNT[layout];
    const active = get().activePaneId;
    const stillShown = PANE_IDS.slice(0, count).includes(active as (typeof PANE_IDS)[number]);
    set({
      layout,
      // Leaving a pane active that the layout no longer shows would send every
      // keystroke to a chart nobody can see.
      activePaneId: stillShown ? active : 'p1',
      maximizedPaneId: null,
    });
  },

  setActivePane(id) {
    if (get().activePaneId === id) return;
    set({ activePaneId: id });
  },

  maximizePane(id) {
    set({ maximizedPaneId: id, ...(id ? { activePaneId: id } : {}) });
  },

  setSync(patch) {
    set({ sync: { ...get().sync, ...patch } });
  },

  setPaneSymbol(id, symbol) {
    const sync = get().sync.symbol;
    set({
      panes: get().panes.map((pane) =>
        pane.id === id || sync ? { ...pane, symbol } : pane,
      ),
    });
  },

  setPaneTimeframe(id, timeframe) {
    const sync = get().sync.interval;
    set({
      panes: get().panes.map((pane) =>
        pane.id === id || sync ? { ...pane, timeframe } : pane,
      ),
    });
  },

  setPaneChartType(id, chartType) {
    set({
      panes: get().panes.map((pane) => (pane.id === id ? { ...pane, chartType } : pane)),
    });
  },

  setPaneSplit(id, split) {
    const current = get().panes.find((pane) => pane.id === id)?.paneSplit ?? null;
    // Dragging a separator fires once, but the chart re-applies a split it was
    // given; writing an identical value would save the workspace for nothing.
    if (JSON.stringify(current) === JSON.stringify(split)) return;
    set({
      panes: get().panes.map((pane) =>
        pane.id === id ? { ...pane, paneSplit: split === null ? null : [...split] } : pane,
      ),
    });
  },

  addIndicator(paneId, kind) {
    const def = indicatorDef(kind);
    // An unknown kind adds nothing and has no instance to point at.
    if (!def) return '';
    const pane = get().panes.find((item) => item.id === paneId);
    if (!pane) return '';
    /*
     * A second EMA in the same colour as the first is two lines a trader
     * cannot tell apart. Each further instance of a kind takes the next
     * colour in the palette; the first keeps the indicator's own default.
     */
    const sameKind = pane.indicators.filter((instance) => instance.kind === kind).length;
    const params: ParamValues = { ...def.defaults };
    if (sameKind > 0 && typeof params['color'] === 'string') {
      params['color'] =
        INSTANCE_COLOURS[(sameKind - 1) % INSTANCE_COLOURS.length] ?? params['color'];
    }
    const id = instanceId();
    set({
      panes: get().panes.map((item) =>
        item.id === paneId
          ? { ...item, indicators: [...item.indicators, { id, kind, params, visible: true }] }
          : item,
      ),
    });
    return id;
  },

  removeIndicator(id) {
    set({
      panes: get().panes.map((pane) => ({
        ...pane,
        indicators: pane.indicators.filter((instance) => instance.id !== id),
      })),
      indicatorSettingsFor: get().indicatorSettingsFor === id ? null : get().indicatorSettingsFor,
    });
  },

  updateIndicator(id, patch) {
    /*
     * One entry point for both a parameter change and a visibility change.
     *
     * `visible` is a property of the INSTANCE rather than one of the
     * indicator's inputs, so it is recognised here rather than being written
     * into the params where the compute function would ignore it.
     */
    const visibility = 'visible' in patch ? (patch as { visible: boolean }) : null;
    set({
      panes: get().panes.map((pane) => ({
        ...pane,
        indicators: pane.indicators.map((instance) =>
          instance.id === id
            ? visibility
              ? { ...instance, visible: visibility.visible }
              : { ...instance, params: { ...instance.params, ...(patch as ParamValues) } }
            : instance,
        ),
      })),
    });
  },

  toggleIndicator(id) {
    const pane = get().paneOf(id);
    const instance = pane?.indicators.find((item) => item.id === id);
    if (!instance) return;
    get().updateIndicator(id, { visible: !instance.visible });
  },

  duplicateIndicator(id) {
    const pane = get().paneOf(id);
    const source = pane?.indicators.find((item) => item.id === id);
    if (!pane || !source) return;
    set({
      panes: get().panes.map((item) =>
        item.id === pane.id
          ? {
              ...item,
              indicators: [
                ...item.indicators,
                { ...source, id: instanceId(), params: { ...source.params } },
              ],
            }
          : item,
      ),
    });
  },

  indicatorSettingsFor: null,

  openIndicatorSettings(id) {
    set({ indicatorSettingsFor: id });
  },

  visiblePanes() {
    return get().panes.slice(0, PANE_COUNT[get().layout]);
  },

  paneOf(indicatorId) {
    return (
      get().panes.find((pane) =>
        pane.indicators.some((instance) => instance.id === indicatorId),
      ) ?? null
    );
  },

  snapshot() {
    const state = get();
    return {
      layout: state.layout,
      panes: state.panes,
      activePaneId: state.activePaneId,
      sync: state.sync,
    };
  },

  restore(stored, legacy) {
    const layout = isLayout(stored.layout) ? stored.layout : 'ONE';
    const panes = sanitizePanes(stored.panes);
    /*
     * A workspace saved before the terminal had panes.
     *
     * Its single chart's style and indicators become the first pane, so a
     * trader who had an EMA and a Heikin Ashi chart still has them after the
     * update rather than a blank chart and a shrug.
     */
    if (!Array.isArray(stored.panes) && legacy) {
      const first = panes[0]!;
      panes[0] = {
        ...first,
        chartType: typeof legacy.chartType === 'string' ? (legacy.chartType as ChartType) : first.chartType,
        indicators: sanitizeIndicators(legacy.indicators),
      };
    }
    const active =
      typeof stored.activePaneId === 'string' &&
      panes.some((pane) => pane.id === stored.activePaneId)
        ? stored.activePaneId
        : 'p1';
    set({
      layout,
      panes,
      activePaneId: active,
      maximizedPaneId: null,
      sync: sanitizeSync(stored.sync),
    });
  },
}));

function isLayout(value: unknown): value is LayoutKind {
  return typeof value === 'string' && value in PANE_COUNT;
}

function sanitizeSync(raw: unknown): SyncOptions {
  const value = (raw ?? {}) as Partial<SyncOptions>;
  return {
    crosshair: value.crosshair === true,
    time: value.time === true,
    symbol: value.symbol === true,
    interval: value.interval === true,
  };
}

/** Always four panes, whatever was stored: the layout decides what is shown. */
function sanitizePanes(raw: unknown): PaneState[] {
  const defaults = defaultPanes();
  if (!Array.isArray(raw)) return defaults;
  return defaults.map((fallback, index) => {
    const candidate = raw[index] as Partial<PaneState> | undefined;
    if (!candidate) return fallback;
    return {
      id: fallback.id,
      symbol: typeof candidate.symbol === 'string' ? candidate.symbol : null,
      timeframe: typeof candidate.timeframe === 'string' ? candidate.timeframe : fallback.timeframe,
      chartType:
        typeof candidate.chartType === 'string'
          ? (candidate.chartType as ChartType)
          : fallback.chartType,
      indicators: sanitizeIndicators(candidate.indicators),
      paneSplit: sanitizeSplit(candidate.paneSplit),
    };
  });
}

/**
 * A stored split, or nothing.
 *
 * Anything that is not a list of finite positive numbers becomes null, which
 * is the automatic split: a corrupt stored value must not be able to collapse
 * a pane to nothing on the next load.
 */
function sanitizeSplit(raw: unknown): readonly number[] | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 8) return null;
  const out: number[] = [];
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    out.push(value);
  }
  return out;
}

function sanitizeIndicators(raw: unknown): IndicatorInstance[] {
  if (!Array.isArray(raw)) return [];
  const out: IndicatorInstance[] = [];
  for (const item of raw) {
    const candidate = item as Partial<IndicatorInstance>;
    if (typeof candidate.kind !== 'string' || !indicatorDef(candidate.kind)) continue;
    out.push({
      id: typeof candidate.id === 'string' ? candidate.id : instanceId(),
      kind: candidate.kind,
      params: (candidate.params ?? {}) as ParamValues,
      visible: candidate.visible !== false,
    });
  }
  return out;
}
