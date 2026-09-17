import { useEffect, useState, type JSX } from 'react';
import { useSession, activeInstrument } from '../state/session';
import { AccountBar } from './AccountBar';
import { DrawingRail } from '../panels/DrawingRail';
import { ChartPanel } from '../panels/ChartPanel';
import { OrderTicket } from '../panels/OrderTicket';
import { ActivityPanel } from '../panels/ActivityPanel';
import { Drawer } from '../panels/Drawer';
import { PracticePanel } from '../panels/PracticePanel';
import { ReplayPanel } from '../panels/ReplayPanel';
import { JournalPanel } from '../panels/JournalPanel';
import { DomPanel } from '../panels/DomPanel';
import { SettingsDialog } from '../settings/SettingsDialog';
import { useWorkspace } from '../state/workspace';
import { usePersistentFlag, usePersistentSize, useDragResize } from './usePersistentSize';
import type { BracketMode } from '../chart/PriceMarkers';
import './TerminalShell.css';

/**
 * The terminal.
 *
 *   ACCOUNT BAR   account, money, rule headroom, session, navigation
 *   LEFT          drawing rail
 *   CENTRE        the chart, which is the application
 *   RIGHT         the order ticket
 *   BOTTOM        positions, orders, trades - collapsible
 *   OVER          one drawer (practice, journal, ladder) or the settings dialog
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

  /**
   * Bracket defaults, owned here so the ticket and the chart agree.
   *
   * MANUAL is the default: a fill draws the position marker and nothing
   * protective exists until the trader asks for it, from the marker or from
   * the ticket. That is the behaviour that was asked for, and the reason these
   * three values live above both of them.
   */
  const [bracketMode, setBracketMode] = useState<BracketMode>(
    () => (localStorage.getItem('atlas.bracket.mode') as BracketMode) ?? 'MANUAL',
  );
  const [stopTicks, setStopTicks] = useState(
    () => Number(localStorage.getItem('atlas.bracket.stop')) || 40,
  );
  const [targetTicks, setTargetTicks] = useState(
    () => Number(localStorage.getItem('atlas.bracket.target')) || 80,
  );

  useEffect(() => localStorage.setItem('atlas.bracket.mode', bracketMode), [bracketMode]);
  useEffect(() => localStorage.setItem('atlas.bracket.stop', String(stopTicks)), [stopTicks]);
  useEffect(() => localStorage.setItem('atlas.bracket.target', String(targetTicks)), [targetTicks]);

  // The right column is anchored to the right edge, so dragging left grows it.
  const onDragRight = useDragResize('x', rightWidth, setRightWidth, -1);
  const onDragBottom = useDragResize('y', bottomHeight, setBottomHeight, -1);

  return (
    <div className="terminal">
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
            <ChartPanel bracketMode={bracketMode} stopTicks={stopTicks} targetTicks={targetTicks} />
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
                  <OrderTicket
                    bracketMode={bracketMode}
                    onBracketMode={setBracketMode}
                    stopTicks={stopTicks}
                    targetTicks={targetTicks}
                    onStopTicks={setStopTicks}
                    onTargetTicks={setTargetTicks}
                  />
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

          {surface === 'PRACTICE' ? (
            <Drawer title="Practice" onClose={() => openSurface(null)} width={460} testId="drawer-practice">
              <PracticePanel />
              <div className="drawer-section">
                <ReplayPanel />
              </div>
            </Drawer>
          ) : null}

          {surface === 'JOURNAL' ? (
            <Drawer title="Journal" onClose={() => openSurface(null)} width={640} testId="drawer-journal">
              <JournalPanel />
            </Drawer>
          ) : null}

          {surface === 'LADDER' ? (
            <Drawer title="Price ladder" onClose={() => openSurface(null)} width={320} testId="drawer-ladder">
              <DomPanel />
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

      <SettingsDialog />
    </div>
  );
}
