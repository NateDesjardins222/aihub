/**
 * Keeping panes in step, without going through React.
 *
 * A crosshair move on one chart is a pointer-rate event, and a pan is worse.
 * Routing either through a store would re-render every pane sixty times a
 * second to move a vertical line - which is exactly the cost the performance
 * work removed from the single-chart case, and it would come back multiplied
 * by four.
 *
 * So this is a plain publish-and-subscribe with no state: the pane that moved
 * publishes, the others apply it inside their own animation frame, and the one
 * that published ignores its own message.
 */
export interface CrosshairMessage {
  readonly from: string;
  /** The bar time under the pointer, or null when it left the plot. */
  readonly timeMs: number | null;
}

export interface RangeMessage {
  readonly from: string;
  readonly fromMs: number;
  readonly toMs: number;
}

type Listener<T> = (message: T) => void;

const crosshairListeners = new Set<Listener<CrosshairMessage>>();
const rangeListeners = new Set<Listener<RangeMessage>>();

/**
 * Suppression around applying a message.
 *
 * Applying a range to a pane makes THAT pane report a range change, and a
 * renderer reports it on its own next frame rather than inside the call. A
 * plain in-call flag therefore caught nothing: pane A moved, pane B applied
 * it, pane B's own callback fired a frame later and published back, pane A
 * applied that, and the two charts zoomed themselves into a five-minute window
 * in about a second. So the window is measured in TIME, long enough to cover
 * the renderer's callback and short enough that the next real gesture is not
 * swallowed.
 */
const QUIET_MS = 350;
let quietUntil = 0;

export function publishCrosshair(message: CrosshairMessage): void {
  for (const listener of crosshairListeners) listener(message);
}

export function publishRange(message: RangeMessage): void {
  if (performance.now() < quietUntil) return;
  for (const listener of rangeListeners) listener(message);
}

export function onCrosshairSync(listener: Listener<CrosshairMessage>): () => void {
  crosshairListeners.add(listener);
  return () => crosshairListeners.delete(listener);
}

export function onRangeSync(listener: Listener<RangeMessage>): () => void {
  rangeListeners.add(listener);
  return () => rangeListeners.delete(listener);
}

/**
 * What each pane last followed, for the browser suite.
 *
 * Whether a pane followed another pane's crosshair is not readable from the
 * DOM - the crosshair is painted on a canvas by the renderer - so the panes
 * record what they applied. A measurement hook, like the chart's own geometry
 * hook, not a feature.
 */
export interface SyncDiagnostics {
  crosshair: Record<string, number | null>;
  range: Record<string, { fromMs: number; toMs: number }>;
}

const diagnostics: SyncDiagnostics = { crosshair: {}, range: {} };

export function recordCrosshairApplied(paneId: string, timeMs: number | null): void {
  diagnostics.crosshair[paneId] = timeMs;
}

export function recordRangeApplied(paneId: string, fromMs: number, toMs: number): void {
  diagnostics.range[paneId] = { fromMs, toMs };
}

export function syncDiagnostics(): SyncDiagnostics {
  return diagnostics;
}

/** Run something that changes a chart without it echoing back as a message. */
export function whileApplying(work: () => void): void {
  quietUntil = performance.now() + QUIET_MS;
  try {
    work();
  } finally {
    quietUntil = performance.now() + QUIET_MS;
  }
}
