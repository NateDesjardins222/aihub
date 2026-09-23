/**
 * The chart area: one chart, or several.
 *
 * Panes are laid out by CSS grid. The division between charts is a real,
 * draggable divider (not a preset ratio): the trader grabs the line between two
 * charts and the pane widths/heights change continuously, the proportion is
 * clamped so neither pane collapses, and it persists with the workspace. Every
 * pane is the same `ChartPanel`; there is no separate multi-chart code path.
 */
import { useCallback, useEffect, useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import { ChartPanel } from './ChartPanel';
import { useLayout, PANE_COUNT, clampSplit, type LayoutKind } from '../state/layout-store';
import { useSession } from '../state/session';
import './ChartGrid.css';

/** Which dividers a layout has: a column (vertical) split, a row (horizontal) split, or both. */
function dividersFor(layout: LayoutKind): { col: boolean; row: boolean } {
  switch (layout) {
    case 'TWO_V':
      return { col: true, row: false };
    case 'TWO_H':
      return { col: false, row: true };
    case 'THREE':
    case 'FOUR':
      return { col: true, row: true };
    default:
      return { col: false, row: false };
  }
}

export function ChartGrid(): JSX.Element {
  const layout = useLayout((s) => s.layout);
  const panes = useLayout((s) => s.panes);
  const activePaneId = useLayout((s) => s.activePaneId);
  const maximizedPaneId = useLayout((s) => s.maximizedPaneId);
  const setActivePane = useLayout((s) => s.setActivePane);
  const maximizePane = useLayout((s) => s.maximizePane);
  const setPaneSymbol = useLayout((s) => s.setPaneSymbol);
  const colSplit = useLayout((s) => s.colSplit);
  const rowSplit = useLayout((s) => s.rowSplit);
  const setColSplit = useLayout((s) => s.setColSplit);
  const setRowSplit = useLayout((s) => s.setRowSplit);
  const terminalSymbol = useSession((s) => s.activeSymbol);
  const setActiveSymbol = useSession((s) => s.setActiveSymbol);

  const gridRef = useRef<HTMLDivElement>(null);

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

  const dividers = maximizedPaneId ? { col: false, row: false } : dividersFor(layout);

  // Inline grid tracks from the stored proportions, so a drag is continuous and
  // the exact ratio is what the workspace saves. Layouts without a given split
  // keep the CSS default (1fr …).
  const style: Record<string, string> = {};
  if (dividers.col) style.gridTemplateColumns = `${colSplit}fr ${1 - colSplit}fr`;
  if (dividers.row) style.gridTemplateRows = `${rowSplit}fr ${1 - rowSplit}fr`;

  const startDrag = useCallback(
    (axis: 'col' | 'row') => (event: ReactPointerEvent<HTMLDivElement>) => {
      // The divider is its own control: activating a pane, panning a chart or
      // starting a drawing must not happen because the trader grabbed the line.
      event.preventDefault();
      event.stopPropagation();
      const el = event.currentTarget;
      el.setPointerCapture(event.pointerId);
      const move = (moveEvent: PointerEvent): void => {
        const rect = gridRef.current?.getBoundingClientRect();
        if (!rect) return;
        const fraction =
          axis === 'col'
            ? (moveEvent.clientX - rect.left) / rect.width
            : (moveEvent.clientY - rect.top) / rect.height;
        if (axis === 'col') setColSplit(clampSplit(fraction));
        else setRowSplit(clampSplit(fraction));
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [setColSplit, setRowSplit],
  );

  // Double-clicking a divider restores the even split — the professional
  // "reset this division" gesture, matching double-click-to-auto elsewhere.
  const resetSplit = (axis: 'col' | 'row') => (): void => {
    if (axis === 'col') setColSplit(0.5);
    else setRowSplit(0.5);
  };

  return (
    <div
      ref={gridRef}
      className={`grid grid-${maximizedPaneId ? 'ONE' : layout}`}
      data-testid="chart-grid"
      data-layout={layout}
      data-panes={shown.length}
      style={style}
    >
      {shown.map((pane) => (
        <div
          className={`grid-pane ${
            !single && pane.id === activePaneId ? 'grid-pane-active' : ''
          }`}
          key={pane.id}
          data-testid="chart-pane"
          data-pane={pane.id}
          onPointerDownCapture={() => setActivePane(pane.id)}
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

      {dividers.col ? (
        <div
          className="grid-divider grid-divider-col"
          // In THREE the top pane spans both columns, so the vertical divider
          // only makes sense across the bottom row; elsewhere it is full height.
          style={{
            left: `${colSplit * 100}%`,
            top: layout === 'THREE' ? `${rowSplit * 100}%` : '0',
            bottom: '0',
          }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize charts left and right"
          data-testid="chart-divider-col"
          onPointerDown={startDrag('col')}
          onDoubleClick={resetSplit('col')}
        />
      ) : null}
      {dividers.row ? (
        <div
          className="grid-divider grid-divider-row"
          style={{ top: `${rowSplit * 100}%`, left: '0', right: '0' }}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize charts top and bottom"
          data-testid="chart-divider-row"
          onPointerDown={startDrag('row')}
          onDoubleClick={resetSplit('row')}
        />
      ) : null}
    </div>
  );
}
