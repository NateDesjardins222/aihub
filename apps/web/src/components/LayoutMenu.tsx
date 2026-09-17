/**
 * The chart layout control.
 *
 * In the terminal's own top bar, with the icon showing the layout currently in
 * use, because "how do I get two charts" should be answerable by looking. It
 * also carries what is kept in step between panes: crosshair, time, symbol and
 * interval, each off by default, because a trader who opens four charts usually
 * wants four different things.
 */
import { type JSX } from 'react';
import { Icon, type IconName } from '../ui/Icon';
import { Popover, usePopover } from '../ui/Popover';
import { useLayout, LAYOUT_LABEL, PANE_COUNT, type LayoutKind } from '../state/layout-store';
import './LayoutMenu.css';

const LAYOUT_ICON: Record<LayoutKind, IconName> = {
  ONE: 'layout-1',
  TWO_V: 'layout-2v',
  TWO_H: 'layout-2h',
  THREE: 'layout-3',
  FOUR: 'layout-4',
};

const ORDER: readonly LayoutKind[] = ['ONE', 'TWO_V', 'TWO_H', 'THREE', 'FOUR'];

const SYNC_ROWS: ReadonlyArray<{
  key: 'crosshair' | 'time' | 'symbol' | 'interval';
  label: string;
  hint: string;
}> = [
  { key: 'crosshair', label: 'Crosshair', hint: 'Point at a bar on one chart and the others follow' },
  { key: 'time', label: 'Time range', hint: 'Pan or zoom one chart and the others move with it' },
  { key: 'symbol', label: 'Symbol', hint: 'Change the instrument on one chart and all of them change' },
  { key: 'interval', label: 'Interval', hint: 'Change the interval on one chart and all of them change' },
];

export function LayoutMenu(): JSX.Element {
  const layout = useLayout((s) => s.layout);
  const setLayout = useLayout((s) => s.setLayout);
  const sync = useLayout((s) => s.sync);
  const setSync = useLayout((s) => s.setSync);
  const menu = usePopover();

  return (
    <>
      <button
        className={`abar-icon ${layout === 'ONE' ? '' : 'abar-icon-on'}`}
        onClick={menu.toggle}
        title={`Chart layout: ${LAYOUT_LABEL[layout]}`}
        aria-label="Chart layout"
        data-testid="layout-button"
      >
        <Icon name={LAYOUT_ICON[layout]} size={13} />
      </button>
      <Popover
        open={menu.open}
        onClose={menu.close}
        anchor={menu.anchor}
        align="right"
        width={250}
        label="Chart layout"
      >
        <div className="pop-head">Charts</div>
        <div className="lm-grid" data-testid="layout-choices">
          {ORDER.map((kind) => (
            <button
              key={kind}
              className={`lm-choice ${kind === layout ? 'lm-choice-on' : ''}`}
              onClick={() => {
                setLayout(kind);
                menu.close();
              }}
              title={LAYOUT_LABEL[kind]}
              aria-label={LAYOUT_LABEL[kind]}
              data-layout={kind}
            >
              <Icon name={LAYOUT_ICON[kind]} size={18} />
              <span className="lm-count">{PANE_COUNT[kind]}</span>
            </button>
          ))}
        </div>

        <div className="pop-sep" />
        <div className="pop-head">Keep in step</div>
        {SYNC_ROWS.map((row) => (
          <label className="lm-sync" key={row.key} title={row.hint}>
            <input
              type="checkbox"
              checked={sync[row.key]}
              onChange={(event) => setSync({ [row.key]: event.target.checked })}
              aria-label={`Sync ${row.label.toLowerCase()}`}
            />
            <span>{row.label}</span>
          </label>
        ))}
      </Popover>
    </>
  );
}
