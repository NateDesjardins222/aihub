/**
 * Display preferences that survive a reload.
 *
 * Chart motion, the training mode and what it hides. All of it is presentation:
 * none of it can reach the execution engine, and the server stores it as an
 * opaque blob for exactly that reason.
 *
 * Writes are debounced, because a slider produces a preference change per
 * frame and none of them is worth a request.
 */
import type { Timeframe } from '@atlas/contracts';
import { drawingsApi, preferencesApi } from '../trading/journal-api';
import { ApiRequestError } from '../api/client';
import { usePersistence } from './persistence-status';
import { applyTheme } from '../chart/themes';
import { useMotion } from './motion-store';
import { normalizeMotion, type MotionSettings } from '../chart/motion';
import { FULL_VISIBILITY, useTraining, type TrainingModeId, type Visibility } from './training';
import { useChartStore, type StoredChart } from './chart-store';
import { useLayout, type StoredLayout } from './layout-store';
import { useWorkspace } from './workspace';
import { useExecution, type ExecutionDefaults } from './execution';

interface StoredPreferences {
  motion?: Partial<MotionSettings>;
  training?: { modeId?: TrainingModeId; visibility?: Partial<Visibility> };
  /** Chart appearance and drawings. */
  chart?: StoredChart;
  /** The chart layout: how many charts, and what each one shows. */
  layout?: StoredLayout;
  workspace?: { favouriteTimeframes?: readonly Timeframe[] };
  execution?: Partial<ExecutionDefaults>;
}

const WRITE_DEBOUNCE_MS = 600;
let timer: number | null = null;
/**
 * A preview is a change the trader has not made yet.
 *
 * Hovering a theme applies it to the real chart, because that is the only
 * honest preview - a swatch is a guess about what a chart will look like. But
 * a hover is not a decision, and saving one would mean a trader who moved the
 * pointer across five presets and then closed the dialog had their workspace
 * rewritten five times and left on the last one they happened to pass over.
 */
let suspended = false;
let restored = false;
/** The drawings last sent, so a preference change does not re-send them. */
let sentDrawings = '';

/** Apply changes without saving them, for a preview the trader can abandon. */
export function suspendSaving(): void {
  suspended = true;
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
}

/** Saving again. Call it before the change that IS a decision. */
export function resumeSaving(): void {
  suspended = false;
}

function write(): void {
  if (suspended) return;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    const chart = useChartStore.getState().snapshot();
    // The drawings travel separately and are NOT part of the preferences blob:
    // a busy chart is bigger than the whole preference budget, and sharing one
    // meant a trader who drew a lot lost their motion settings too.
    const { drawings, ...display } = chart;
    const preferences: StoredPreferences = {
      motion: useMotion.getState().settings,
      training: {
        modeId: useTraining.getState().modeId,
        visibility: useTraining.getState().visibility,
      },
      chart: display,
      layout: useLayout.getState().snapshot(),
      workspace: { favouriteTimeframes: useWorkspace.getState().favouriteTimeframes },
      execution: useExecution.getState().snapshot(),
    };
    void preferencesApi
      .write(preferences as Record<string, unknown>)
      .then(() => usePersistence.getState().succeed('workspace'))
      .catch((err: unknown) =>
        usePersistence.getState().fail('workspace', reason(err, 'workspace')),
      );

    const encoded = JSON.stringify(drawings ?? []);
    if (encoded === sentDrawings) return;
    const attempt = encoded;
    void drawingsApi
      .write(drawings ?? [])
      .then(() => {
        sentDrawings = attempt;
        usePersistence.getState().succeed('drawings');
      })
      .catch((err: unknown) =>
        usePersistence.getState().fail('drawings', reason(err, 'drawings')),
      );
  }, WRITE_DEBOUNCE_MS);
}

/** The server's own reason where there is one: it is the actionable part. */
function reason(err: unknown, what: 'workspace' | 'drawings'): string {
  if (err instanceof ApiRequestError) {
    return `Your ${what} could not be saved. ${err.message}`;
  }
  return `Your ${what} could not be saved. The server did not respond.`;
}

/**
 * Load a trader's preferences and keep them saved from then on.
 *
 * Safe to call more than once: the restore happens once, and the subscriptions
 * are attached once.
 */
export async function attachPreferences(): Promise<void> {
  if (restored) return;
  restored = true;

  try {
    const { preferences } = await preferencesApi.read();
    const stored = preferences as StoredPreferences;
    if (stored.motion) useMotion.getState().set(normalizeMotion(stored.motion));
    if (stored.training?.modeId) {
      useTraining.getState().restore({
        modeId: stored.training.modeId,
        visibility: { ...FULL_VISIBILITY, ...(stored.training.visibility ?? {}) },
      });
    }
    /*
     * A stored chart blob was written by some earlier build of this file, so
     * every field is validated on the way in by `restore` rather than trusted:
     * a drawing that no longer makes sense is dropped, and never becomes a
     * broken object on the chart.
     *
     * The drawings come from their own store, with the preference blob as the
     * fallback: a workspace saved before they moved still has them in `chart`,
     * and that trader's objects have to come back on the first load after the
     * change.
     */
    let drawings: unknown[] | null = null;
    try {
      drawings = (await drawingsApi.read()).drawings;
    } catch {
      // No drawing row yet, or the request failed: the preference blob may
      // still carry them, and an empty chart is better than a broken load.
    }
    if (stored.chart || drawings) {
      useChartStore.getState().restore({
        ...(stored.chart ?? {}),
        ...(drawings ? { drawings: drawings as StoredChart['drawings'] } : {}),
      });
      sentDrawings = JSON.stringify(
        drawings ?? (stored.chart?.drawings as unknown[] | undefined) ?? [],
      );
    }
    /*
     * The layout, with the old single-chart settings as the fallback.
     *
     * A workspace saved before the terminal had panes kept its chart style and
     * its indicators in `chart`; those become the first pane rather than being
     * dropped on the floor.
     */
    useLayout.getState().restore(stored.layout ?? {}, {
      chartType: (stored.chart as { chartType?: unknown } | undefined)?.chartType,
      indicators: (stored.chart as { indicators?: unknown } | undefined)?.indicators,
    });
    if (stored.workspace) useWorkspace.getState().restore(stored.workspace);
    if (stored.execution) useExecution.getState().restore(stored.execution);
  } catch {
    // A trader with no stored preferences is not an error; they get the
    // defaults, and the first change they make saves them.
  }

  /*
   * The theme, before anything is drawn.
   *
   * A trader with no stored workspace still gets the tokens written onto the
   * document, so `data-theme` is there for the rules that key off it rather
   * than only after the first theme change.
   */
  applyTheme(
    useChartStore.getState().themeId,
    useChartStore.getState().customThemes,
    useChartStore.getState().surfaceOverrides,
  );

  useMotion.subscribe(write);
  useTraining.subscribe(write);
  useChartStore.subscribe(write);
  useLayout.subscribe(write);
  useWorkspace.subscribe(write);
  useExecution.subscribe(write);
}
