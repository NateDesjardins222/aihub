import type { JSX } from 'react';
import { useSession, activeInstrument } from '../state/session';
import { AccountBar } from './AccountBar';
import { AppRail } from './AppRail';
import { DrawingRail } from '../panels/DrawingRail';
import { ChartGrid } from '../panels/ChartGrid';
import { OrderTicket } from '../panels/OrderTicket';
import { ActivityPanel } from '../panels/ActivityPanel';
import { Drawer } from '../panels/Drawer';
import { JournalPanel } from '../panels/JournalPanel';
import { SettingsDialog } from '../settings/SettingsDialog';
import { useWorkspace } from '../state/workspace';
import { usePersistentFlag, usePersistentSize, useDragResize } from './usePersistentSize';
import './TerminalShell.css';

/**
 * The terminal.
 *
 *   ACCOUNT BAR   account, money, rule headroom, session, navigation
 *   LEFT          drawing rail
 *   CENTRE        the charts, one to four of them, which are the application
 *   RIGHT         the order ticket
 *   BOTTOM        positions, orders, trades - collapsible
 *   OVER          one drawer (practice or journal) or the settings dialog
 *
 * Everything that is not the chart, the ticket or the blotter is secondary and
 * lives behind navigation. That is the whole layout rule: at 1440px the chart
 * gets about three quarters of the width, and at 1920px rather more.
 */
export function TerminalShell(): JSX.Element {
  const instrument = useSession(activeInstrument);
  const surface = useWorkspace((s) => s.surface);
  const openSurface = useWorkspace((s) => s.openSurface);

  const [rightWidth, setRightWidth] = usePersistentSize('atlas.panel.right', 224, {
    min: 196,
    max: 340,
  });
  const [bottomHeight, setBottomHeight] = usePersistentSize('atlas.panel.bottom', 172, {
    min: 110,
    max: 520,
  });
  const [rightOpen, setRightOpen] = usePersistentFlag('atlas.panel.right.open', true);
  const [bottomOpen, setBottomOpen] = usePersistentFlag('atlas.panel.bottom.open', true);
  const [railOpen, setRailOpen] = usePersistentFlag('atlas.panel.rail.open', true);

  // The right column is anchored to the right edge, so dragging left grows it.
  const onDragRight = useDragResize('x', rightWidth, setRightWidth, -1);
  const onDragBottom = useDragResize('y', bottomHeight, setBottomHeight, -1);

  return (
    <div className="terminal">
      {/*
        The application rail is OUTSIDE the account bar and runs the full
        height, so the bar and the charts both begin to the right of it. That
        is what makes it read as navigation for the product rather than as one
        more group of icons inside the chart's chrome.
      */}
      <AppRail />

      <div className="terminal-column">
        <AccountBar onToggleRail={() => setRailOpen(!railOpen)} railOpen={railOpen} />

        <div className="terminal-body">
        <div className="terminal-main" style={{ paddingBottom: bottomOpen ? bottomHeight : 22 }}>
          {railOpen ? (
            <DrawingRail symbol={instrument?.root ?? ''} />
          ) : (
            <button
              className="rail-expand rail-expand-left"
              onClick={() => setRailOpen(true)}
              title="Show the drawing tools"
              aria-label="Show the drawing tools"
            >
              ›
            </button>
          )}

          <div className="terminal-centre">
            <ChartGrid />
          </div>

          {rightOpen ? (
            <>
              <div
                className="splitter splitter-v"
                onPointerDown={onDragRight}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize the order ticket"
              />
              <div className="terminal-right" style={{ width: rightWidth }}>
                <div className="terminal-right-head">
                  <span className="label">Order</span>
                  <div className="hdr-spacer" />
                  <button
                    className="icon-btn"
                    onClick={() => setRightOpen(false)}
                    title="Collapse the order ticket"
                  >
                    ›
                  </button>
                </div>
                <div className="terminal-right-body">
                  <OrderTicket />
                </div>
              </div>
            </>
          ) : (
            <button
              className="rail-expand rail-expand-right"
              onClick={() => setRightOpen(true)}
              title="Show the order ticket"
              aria-label="Show the order ticket"
            >
              ‹
            </button>
          )}

          {surface === 'JOURNAL' ? (
            <Drawer title="Journal" onClose={() => openSurface(null)} width={640} testId="drawer-journal">
              <JournalPanel />
            </Drawer>
          ) : null}

        </div>

        <div className="terminal-bottom" style={{ height: bottomOpen ? bottomHeight : 22 }}>
          {bottomOpen ? (
            <div
              className="splitter splitter-h"
              onPointerDown={onDragBottom}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize the activity panel"
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

      <SettingsDialog />
    </div>
  );
}
