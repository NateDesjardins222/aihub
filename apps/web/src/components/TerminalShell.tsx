import { useSession, activeInstrument } from '../state/session';
import { TerminalHeader } from './TerminalHeader';
import { DrawingRail } from '../panels/DrawingRail';
import { ChartPanel } from '../panels/ChartPanel';
import { RightPanel } from '../panels/RightPanel';
import { ActivityPanel } from '../panels/ActivityPanel';
import { usePersistentFlag, usePersistentSize, useDragResize } from './usePersistentSize';
import './TerminalShell.css';
import type { JSX } from 'react';

/**
 * Terminal layout.
 *
 *   HEADER   account | balance | day P&L | open P&L | drawdown | connection
 *   LEFT     drawing rail
 *   CENTRE   chart (maximised: everything else is sized to leave it the space)
 *   RIGHT    order panel / DOM
 *   BOTTOM   positions | orders | trades | accounts | quotes
 *
 * The splitters are real: they drag, they clamp, they collapse, and the sizes
 * are written to localStorage so the workspace comes back as it was left.
 */
export function TerminalShell(): JSX.Element {
  const instrument = useSession(activeInstrument);
  const [rightWidth, setRightWidth] = usePersistentSize('atlas.panel.right', 320, {
    min: 240,
    max: 560,
  });
  const [bottomHeight, setBottomHeight] = usePersistentSize('atlas.panel.bottom', 220, {
    min: 120,
    max: 620,
  });
  const [rightOpen, setRightOpen] = usePersistentFlag('atlas.panel.right.open', true);
  const [bottomOpen, setBottomOpen] = usePersistentFlag('atlas.panel.bottom.open', true);

  // The right panel is anchored to the right edge, so dragging left grows it.
  const onDragRight = useDragResize('x', rightWidth, setRightWidth, -1);
  const onDragBottom = useDragResize('y', bottomHeight, setBottomHeight, -1);

  return (
    <div className="terminal">
      <TerminalHeader />

      <div className="terminal-body">
        <div className="terminal-main" style={{ paddingBottom: bottomOpen ? bottomHeight : 26 }}>
          <DrawingRail />

          <div className="terminal-centre">
            <ChartPanel />
          </div>

          {rightOpen ? (
            <>
              <div
                className="splitter splitter-v"
                onPointerDown={onDragRight}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize trading panel"
              />
              <div className="terminal-right" style={{ width: rightWidth }}>
                <RightPanel onCollapse={() => setRightOpen(false)} />
              </div>
            </>
          ) : (
            <button
              className="rail-expand rail-expand-right"
              onClick={() => setRightOpen(true)}
              title="Show trading panel"
            >
              ‹
            </button>
          )}
        </div>

        <div
          className="terminal-bottom"
          style={{ height: bottomOpen ? bottomHeight : 26 }}
        >
          {bottomOpen ? (
            <div
              className="splitter splitter-h"
              onPointerDown={onDragBottom}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize activity panel"
            />
          ) : null}
          <ActivityPanel
            collapsed={!bottomOpen}
            onToggle={() => setBottomOpen(!bottomOpen)}
            instrument={instrument}
          />
        </div>
      </div>
    </div>
  );
}
