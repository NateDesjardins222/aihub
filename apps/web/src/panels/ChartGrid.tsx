/**
 * The chart area: one chart, or several.
 *
 * Panes are laid out by CSS grid rather than by nested splitters, because the
 * layouts a trader actually uses are a handful of fixed divisions and a grid
 * says which is which in one line. One pane is the ACTIVE pane: it carries a
 * thin outline, and it is the chart the order ticket and the drawing rail
 * belong to.
 *
 * Every pane is the same `ChartPanel`. There is no "multi-chart mode" with its
 * own code path to drift out of step with the single-chart one.
 */
import { useEffect, type JSX } from 'react';
import { ChartPanel } from './ChartPanel';
import { useLayout, PANE_COUNT } from '../state/layout-store';
import { useSession } from '../state/session';
import './ChartGrid.css';

export function ChartGrid(): JSX.Element {
  const layout = useLayout((s) => s.layout);
  const panes = useLayout((s) => s.panes);
  const activePaneId = useLayout((s) => s.activePaneId);
  const maximizedPaneId = useLayout((s) => s.maximizedPaneId);
  const setActivePane = useLayout((s) => s.setActivePane);
  const maximizePane = useLayout((s) => s.maximizePane);
  const setPaneSymbol = useLayout((s) => s.setPaneSymbol);
  const terminalSymbol = useSession((s) => s.activeSymbol);
  const setActiveSymbol = useSession((s) => s.setActiveSymbol);

  /*
   * The order ticket trades the chart you are working in.
   *
   * The active pane's instrument IS the terminal's instrument - anything else
   * means the BUY button and the chart under it can disagree, which is a way
   * to lose money. A pane with no instrument of its own takes the terminal's,
   * once, so it starts on what the trader was already looking at.
   */
  const active = panes.find((pane) => pane.id === activePaneId) ?? null;
  useEffect(() => {
    if (!active) return;
    if (active.symbol === null) {
      if (terminalSymbol) setPaneSymbol(active.id, terminalSymbol);
      return;
    }
    if (active.symbol !== terminalSymbol) setActiveSymbol(active.symbol);
  }, [active, terminalSymbol, setActiveSymbol, setPaneSymbol]);

  const shown = maximizedPaneId
    ? panes.filter((pane) => pane.id === maximizedPaneId)
    : panes.slice(0, PANE_COUNT[layout]);
  const single = shown.length === 1;

  return (
    <div
      className={`grid grid-${maximizedPaneId ? 'ONE' : layout}`}
      data-testid="chart-grid"
      data-layout={layout}
      data-panes={shown.length}
    >
      {shown.map((pane) => (
        <div
          className={`grid-pane ${
            !single && pane.id === activePaneId ? 'grid-pane-active' : ''
          }`}
          key={pane.id}
          data-testid="chart-pane"
          data-pane={pane.id}
          /*
           * Capture, and never stop the event: clicking a chart makes it the
           * active one AND does whatever the click was for - starting a
           * drawing, moving the crosshair, taking hold of the scale.
           */
          onPointerDownCapture={() => setActivePane(pane.id)}
          /* A wheel is a deliberate zoom, and it never presses a button. */
          onWheelCapture={() => setActivePane(pane.id)}
        >
          <ChartPanel
            paneId={pane.id}
            active={pane.id === activePaneId}
            onActivate={() => setActivePane(pane.id)}
            onMaximize={
              single && !maximizedPaneId
                ? undefined
                : () => maximizePane(maximizedPaneId ? null : pane.id)
            }
            maximized={maximizedPaneId === pane.id}
          />
        </div>
      ))}
    </div>
  );
}
