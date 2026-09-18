/**
 * The indicator legend: one row per indicator, top left of its own pane.
 *
 * What it replaces was a single line of text in the status bar - "RSI 14 43.87
 * — MA 20 29717.30" - which is unreadable at three indicators and offers
 * nothing to click. Every charting package a trader has used lists indicators
 * as rows where they are drawn, each with its own controls, and the value
 * beside each one follows the crosshair.
 *
 * The VALUES are written straight into the DOM by an animation frame, never
 * through React. A crosshair move produces a value change for every indicator
 * on the chart; re-rendering this component for each of them is exactly the
 * cost the performance work removed.
 */
import { useEffect, useRef, type JSX } from 'react';
import type { ChartAdapter } from './ChartAdapter';
import { useLayout } from '../state/layout-store';
import { indicatorDef, indicatorTitle, type IndicatorInstance } from './indicators/registry';
import { Icon } from '../ui/Icon';
import './IndicatorRows.css';

/** One frozen empty list, so a pane with no indicators is a stable selector. */
const EMPTY: readonly IndicatorInstance[] = [];

/** Where the status line itself starts - `.chart-status { top: 4px }`. */
const STATUS_TOP = 4;

export interface IndicatorRowsProps {
  /** The pane whose indicators these are. */
  readonly paneId: string;
  readonly adapterRef: React.RefObject<ChartAdapter | null>;
  /** The crosshair's bar time, or null when the pointer is off the plot. */
  readonly hoverTimeRef: React.RefObject<number | null>;
  /**
   * The status line above the plot. Its height is READ rather than assumed,
   * because it wraps: a narrow pane puts the OHLC, and then the bar countdown,
   * on rows of their own, and a legend pinned to a fixed offset lands on top
   * of them.
   */
  readonly statusRef: React.RefObject<HTMLElement | null>;
  readonly onOpenSettings: (instanceId: string) => void;
}

/**
 * Which pane an instance is drawn in.
 *
 * Mirrors how the adapter allocates them - overlays on the price pane, every
 * oscillator its own pane below, in the order they were added - so a row can
 * be rendered into the right group before the renderer has laid the pane out.
 */
function panesOf(
  indicators: readonly { id: string; kind: string; visible: boolean }[],
): Map<string, number> {
  const out = new Map<string, number>();
  let next = 1;
  for (const instance of indicators) {
    const def = indicatorDef(instance.kind);
    if (!def) continue;
    if (!instance.visible) {
      // A hidden oscillator has no pane; its row stays with the price pane.
      out.set(instance.id, 0);
      continue;
    }
    out.set(instance.id, def.overlay ? 0 : next++);
  }
  return out;
}

export function IndicatorRows({
  paneId,
  adapterRef,
  hoverTimeRef,
  statusRef,
  onOpenSettings,
}: IndicatorRowsProps): JSX.Element | null {
  const indicators = useLayout(
    (s) => s.panes.find((pane) => pane.id === paneId)?.indicators ?? EMPTY,
  );
  const updateIndicator = useLayout((s) => s.updateIndicator);
  const removeIndicator = useLayout((s) => s.removeIndicator);
  const duplicateIndicator = useLayout((s) => s.duplicateIndicator);
  const rootRef = useRef<HTMLDivElement>(null);

  // One frame reads every value and writes the ones that changed.
  useEffect(() => {
    let frame = 0;
    const written = new Map<string, string>();
    const tick = (): void => {
      frame = requestAnimationFrame(tick);
      const root = rootRef.current;
      const adapter = adapterRef.current;
      if (!root || !adapter) return;
      const rows = adapter.indicatorLegend(hoverTimeRef.current);
      for (const row of rows) {
        if (written.get(row.id) === row.value) continue;
        const node = root.querySelector<HTMLElement>(`[data-plot="${row.id}"]`);
        if (!node) continue;
        node.textContent = row.value;
        written.set(row.id, row.value);
      }

      // Each group rides its own pane. Pane heights change with the window
      // and with every indicator added, so the offset is read, not cached -
      // and so is the status line's height, which changes when it wraps.
      const status = statusRef.current?.offsetHeight ?? 0;
      for (const entry of adapter.indicatorPanes()) {
        const group = root.querySelector<HTMLElement>(`[data-pane="${entry.pane}"]`);
        if (!group) continue;
        const top =
          entry.pane === 0 ? entry.top + STATUS_TOP + Math.max(status, 20) + 2 : entry.top + 30;
        const key = `pane:${entry.pane}`;
        if (written.get(key) === String(top)) continue;
        group.style.transform = `translateY(${top}px)`;
        written.set(key, String(top));
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [adapterRef, hoverTimeRef, statusRef, indicators]);

  if (indicators.length === 0) return null;

  const panes = panesOf(indicators);
  const order = [...new Set(indicators.map((i) => panes.get(i.id) ?? 0))].sort((a, b) => a - b);

  return (
    <div className="ind-rows" ref={rootRef} data-testid="indicator-rows">
      {order.map((pane) => (
        <div className="ind-pane-rows" key={pane} data-pane={pane}>
          {indicators
            .filter((instance) => (panes.get(instance.id) ?? 0) === pane)
            .map((instance) => (
              <Row
                key={instance.id}
                instance={instance}
                adapterRef={adapterRef}
                onOpenSettings={onOpenSettings}
                onToggle={() => updateIndicator(instance.id, { visible: !instance.visible })}
                onDuplicate={() => duplicateIndicator(instance.id)}
                onRemove={() => removeIndicator(instance.id)}
              />
            ))}
        </div>
      ))}
    </div>
  );
}

interface RowProps {
  readonly instance: IndicatorInstance;
  readonly adapterRef: React.RefObject<ChartAdapter | null>;
  readonly onOpenSettings: (instanceId: string) => void;
  readonly onToggle: () => void;
  readonly onDuplicate: () => void;
  readonly onRemove: () => void;
}

function Row({
  instance,
  adapterRef,
  onOpenSettings,
  onToggle,
  onDuplicate,
  onRemove,
}: RowProps): JSX.Element {
  const def = indicatorDef(instance.kind);
  const title = indicatorTitle(instance.kind, instance.params);
  const plots = adapterRef.current?.indicatorLegend() ?? [];
  const mine = plots.filter((plot) => plot.instanceId === instance.id);
  const colour = mine[0]?.color ?? String(instance.params['color'] ?? 'var(--text-secondary)');

  return (
    <div
      className={`ind-row ${instance.visible ? '' : 'ind-row-off'}`}
      data-testid="indicator-row"
      data-kind={instance.kind}
      onDoubleClick={() => onOpenSettings(instance.id)}
      title={def?.name ?? instance.kind}
    >
      <span className="ind-dot" style={{ background: colour }} />
      <span className="ind-title">{title}</span>

      {/* The value at the crosshair, written by the frame above. */}
      {mine.length <= 1 ? (
        <span className="num ind-value" data-plot={mine[0]?.id ?? `${instance.id}:none`} />
      ) : (
        <span className="ind-values">
          {mine.map((plot) => (
            <span className="num ind-value" key={plot.id} data-plot={plot.id} />
          ))}
        </span>
      )}

      <span className="ind-actions">
        <button
          className="ind-btn"
          onClick={onToggle}
          title={instance.visible ? 'Hide' : 'Show'}
          aria-label={`${instance.visible ? 'Hide' : 'Show'} ${title}`}
        >
          <Icon name={instance.visible ? 'eye' : 'eye-off'} size={11} />
        </button>
        <button
          className="ind-btn"
          onClick={() => onOpenSettings(instance.id)}
          title="Settings"
          aria-label={`Settings for ${title}`}
        >
          <Icon name="gear" size={11} />
        </button>
        <button
          className="ind-btn"
          onClick={onDuplicate}
          title="Add another with the same settings"
          aria-label={`Duplicate ${title}`}
        >
          <Icon name="copy" size={11} />
        </button>
        <button
          className="ind-btn ind-btn-danger"
          onClick={onRemove}
          title="Remove"
          aria-label={`Remove ${title}`}
        >
          <Icon name="close" size={11} />
        </button>
      </span>
    </div>
  );
}
