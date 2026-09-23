/**
 * The chart header.
 *
 * One row, 28px tall: symbol, contract, favourite timeframes as plain text
 * controls, the chart style, indicators, settings and an overflow menu. What
 * used to be a strip of shouty chips is either gone, in Settings, or behind the
 * overflow - the header's job is to get out of the chart's way.
 */
import { useMemo, useRef, useState, type JSX } from 'react';
import type { Timeframe } from '@atlas/contracts';
import { useSession } from '../state/session';
import { useLayout } from '../state/layout-store';
import { useWorkspace, ALL_TIMEFRAMES } from '../state/workspace';
import { PHASE_1_CHART_TYPES, type ChartType } from './ChartAdapter';
import { INDICATORS, indicatorDef, indicatorTitle, searchIndicators } from './indicators/registry';
import { rankInstruments, resolveEnterSelection } from './symbol-search';
import { Icon, type IconName } from '../ui/Icon';
import { Popover, usePopover } from '../ui/Popover';
import './ChartHeader.css';

const STYLE_ICON: Record<ChartType, IconName> = {
  CANDLES: 'candles',
  HOLLOW_CANDLES: 'hollow',
  BARS: 'bars',
  LINE: 'line',
  LINE_WITH_MARKERS: 'line-markers',
  AREA: 'area',
  BASELINE: 'baseline',
  HEIKIN_ASHI: 'heikin',
  RENKO: 'bars',
  KAGI: 'line',
  LINE_BREAK: 'bars',
  POINT_AND_FIGURE: 'bars',
  HIGH_LOW: 'bars',
};

const STYLE_LABEL: Record<ChartType, string> = {
  CANDLES: 'Candles',
  HOLLOW_CANDLES: 'Hollow candles',
  BARS: 'Bars',
  LINE: 'Line',
  LINE_WITH_MARKERS: 'Line with markers',
  AREA: 'Area',
  BASELINE: 'Baseline',
  HEIKIN_ASHI: 'Heikin Ashi',
  RENKO: 'Renko',
  KAGI: 'Kagi',
  LINE_BREAK: 'Line break',
  POINT_AND_FIGURE: 'Point & figure',
  HIGH_LOW: 'High-low',
};

/**
 * Styles that need information this feed does not carry.
 *
 * Renko, Kagi, line break and point & figure are built from the sequence of
 * trades inside a bar, not from its four prices. They are listed so it is
 * clear they exist and unavailable rather than approximated, because an
 * approximated Renko chart is a chart of prices the market never printed.
 */
const NEEDS_TICK_DATA: readonly ChartType[] = ['RENKO', 'KAGI', 'LINE_BREAK', 'POINT_AND_FIGURE'];

export interface ChartHeaderProps {
  /** The pane this header belongs to. Every control acts on that pane alone. */
  readonly paneId: string;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly onTimeframe: (tf: Timeframe) => void;
  readonly onScreenshot: () => void;
  /** Shown only when more than one chart is open. */
  readonly onMaximize?: (() => void) | undefined;
  readonly maximized?: boolean;
}

export function ChartHeader({
  paneId,
  symbol,
  timeframe,
  onTimeframe,
  onScreenshot,
  onMaximize,
  maximized = false,
}: ChartHeaderProps): JSX.Element {
  const instruments = useSession((s) => s.instruments);
  const activeSymbol = symbol;
  const instrument = useSession((s) => s.instruments.find((i) => i.root === symbol) ?? null);

  const pane = useLayout((s) => s.panes.find((item) => item.id === paneId) ?? null);
  const chartType = pane?.chartType ?? 'CANDLES';
  const setPaneChartType = useLayout((s) => s.setPaneChartType);
  const setChartType = (type: ChartType): void => setPaneChartType(paneId, type);
  const indicators = pane?.indicators ?? [];
  const addPaneIndicator = useLayout((s) => s.addIndicator);
  const addIndicator = (kind: string): string => addPaneIndicator(paneId, kind);
  const openIndicatorSettings = useLayout((s) => s.openIndicatorSettings);
  const removeIndicator = useLayout((s) => s.removeIndicator);
  const toggleIndicator = useLayout((s) => s.toggleIndicator);
  const setPaneSymbol = useLayout((s) => s.setPaneSymbol);
  const applyConfigToOtherPanes = useLayout((s) => s.applyConfigToOtherPanes);
  const multiPane = useLayout((s) => s.visiblePanes().length > 1);
  /*
   * A symbol change belongs to THIS pane.
   *
   * The order ticket follows the ACTIVE pane (see ChartGrid), so choosing an
   * instrument on the chart being worked in re-points the ticket, and choosing
   * one on another chart does not touch it.
   */
  const setSymbolFor = (root: string): void => setPaneSymbol(paneId, root);

  const favourites = useWorkspace((s) => s.favouriteTimeframes);
  const toggleFavourite = useWorkspace((s) => s.toggleFavourite);
  const openSettings = useWorkspace((s) => s.openSettings);

  const symbolMenu = usePopover();
  const tfMenu = usePopover();
  const styleMenu = usePopover();
  const indicatorMenu = usePopover();
  const overflow = usePopover();

  const [symbolQuery, setSymbolQuery] = useState('');
  const [symbolHi, setSymbolHi] = useState(0);
  const [indicatorQuery, setIndicatorQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Ranked so an exact/prefix root match beats an incidental description hit
  // (every description contains "Futures", whose "es" used to match everything
  // and make Enter pick NQ instead of ES). See chart/symbol-search.ts.
  const matches = useMemo(
    () => rankInstruments(instruments, symbolQuery),
    [instruments, symbolQuery],
  );

  const indicatorMatches = useMemo(() => searchIndicators(indicatorQuery), [indicatorQuery]);
  const categories = useMemo(
    () => [...new Set(indicatorMatches.map((def) => def.category))],
    [indicatorMatches],
  );

  return (
    <div className="chdr">
      <button
        className="chdr-symbol"
        onClick={(event) => {
          symbolQuery && setSymbolQuery('');
          setSymbolHi(0);
          symbolMenu.toggle(event);
          window.setTimeout(() => searchRef.current?.focus(), 0);
        }}
        title="Change instrument"
      >
        <Icon name="search" size={12} />
        <span className="chdr-symbol-root">{activeSymbol}</span>
      </button>
      <Popover
        open={symbolMenu.open}
        onClose={symbolMenu.close}
        anchor={symbolMenu.anchor}
        width={300}
        label="Instruments"
      >
        <input
          ref={searchRef}
          className="pop-search"
          placeholder="Search instruments"
          value={symbolQuery}
          onChange={(event) => {
            setSymbolQuery(event.target.value);
            // A fresh filter highlights its first row, so Enter takes the best
            // match without an arrow press.
            setSymbolHi(0);
          }}
          onKeyDown={(event) => {
            // Full keyboard operation: the filtered list is driven without ever
            // reaching for the mouse.
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSymbolHi((h) => Math.min(h + 1, matches.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSymbolHi((h) => Math.max(h - 1, 0));
            } else if (event.key === 'Enter') {
              // An exact recognised symbol always wins; otherwise the
              // highlighted row; never the wrong symbol from a stale highlight.
              const chosen = resolveEnterSelection(instruments, symbolQuery, symbolHi);
              if (chosen) {
                event.preventDefault();
                setSymbolFor(chosen.root);
                symbolMenu.close();
              }
            } else if (event.key === 'Escape') {
              event.preventDefault();
              symbolMenu.close();
            }
          }}
        />
        {matches.length === 0 ? <div className="pop-empty">No instrument matches.</div> : null}
        {matches.map((i, index) => (
          <button
            key={i.root}
            className={`pop-item ${i.root === activeSymbol ? 'pop-item-on' : ''} ${
              index === symbolHi ? 'pop-item-hi' : ''
            }`}
            onMouseEnter={() => setSymbolHi(index)}
            onClick={() => {
              setSymbolFor(i.root);
              symbolMenu.close();
            }}
          >
            <b className="chdr-pop-root">{i.root}</b>
            <span className="chdr-pop-desc">{i.description}</span>
            <span className="pop-item-sub">{i.exchange}</span>
          </button>
        ))}
      </Popover>

      {instrument ? (
        <span className="chdr-contract" title="Front month, from the exchange listing cycle">
          {instrument.activeContract.code}
        </span>
      ) : null}

      <span className="chdr-div" />

      <div className="chdr-tfs">
        {favourites.map((tf) => (
          <button
            key={tf}
            className={`chdr-tf ${tf === timeframe ? 'chdr-tf-on' : ''}`}
            onClick={() => onTimeframe(tf)}
          >
            {tf}
          </button>
        ))}
        <button className="chdr-tf chdr-tf-more" onClick={tfMenu.toggle} title="All intervals">
          <Icon name="chevron-down" size={11} />
        </button>
      </div>
      <Popover
        open={tfMenu.open}
        onClose={tfMenu.close}
        anchor={tfMenu.anchor}
        width={210}
        label="Intervals"
      >
        <div className="pop-head">Interval</div>
        {ALL_TIMEFRAMES.map((tf) => (
          <div className="chdr-tf-row" key={tf}>
            <button
              className={`pop-item ${tf === timeframe ? 'pop-item-on' : ''}`}
              onClick={() => {
                onTimeframe(tf);
                tfMenu.close();
              }}
            >
              {tf}
            </button>
            <button
              className={`chdr-fav ${favourites.includes(tf) ? 'chdr-fav-on' : ''}`}
              onClick={() => toggleFavourite(tf)}
              title={favourites.includes(tf) ? 'Remove from the toolbar' : 'Add to the toolbar'}
              aria-label={`Favourite ${tf}`}
            >
              <Icon name="star" size={11} />
            </button>
          </div>
        ))}
      </Popover>

      <span className="chdr-div" />

      <button className="chdr-icon" onClick={styleMenu.toggle} title={STYLE_LABEL[chartType]}>
        <Icon name={STYLE_ICON[chartType]} />
      </button>
      <Popover
        open={styleMenu.open}
        onClose={styleMenu.close}
        anchor={styleMenu.anchor}
        width={220}
        label="Chart style"
      >
        <div className="pop-head">Style</div>
        {PHASE_1_CHART_TYPES.map((type) => (
          <button
            key={type}
            className={`pop-item ${type === chartType ? 'pop-item-on' : ''}`}
            onClick={() => {
              setChartType(type);
              styleMenu.close();
            }}
          >
            <Icon name={STYLE_ICON[type]} />
            {STYLE_LABEL[type]}
          </button>
        ))}
        <div className="pop-sep" />
        <div className="pop-head">Needs tick data</div>
        {NEEDS_TICK_DATA.map((type) => (
          <button
            key={type}
            className="pop-item"
            disabled
            title="Built from the sequence of trades inside a bar, which this feed does not carry. It is not approximated from the four prices."
          >
            <Icon name={STYLE_ICON[type]} />
            {STYLE_LABEL[type]}
            <span className="pop-item-sub">unavailable</span>
          </button>
        ))}
      </Popover>

      <button className="chdr-btn" onClick={indicatorMenu.toggle} title="Indicators">
        <Icon name="indicators" size={13} />
        <span>Indicators</span>
        {indicators.length > 0 ? <span className="chdr-count">{indicators.length}</span> : null}
      </button>
      <Popover
        open={indicatorMenu.open}
        onClose={indicatorMenu.close}
        anchor={indicatorMenu.anchor}
        width={320}
        label="Indicators"
      >
        <input
          className="pop-search"
          placeholder="Search indicators"
          value={indicatorQuery}
          onChange={(event) => setIndicatorQuery(event.target.value)}
        />
        {/*
          The added list is hidden while searching: a query is a search of the
          CATALOGUE, and leaving the instances in it made "rsi" match both the
          indicator and the one already on the chart.
        */}
        {indicators.length > 0 && indicatorQuery.trim().length === 0 ? (
          <>
            <div className="pop-head">On this chart</div>
            {indicators.map((instance) => {
              const def = indicatorDef(instance.kind);
              return (
                <div className="chdr-ind-row" key={instance.id}>
                  <button
                    className="pop-item chdr-ind-item"
                    onClick={() => {
                      /*
                       * This instance's own settings - not the chart's.
                       * It used to open the chart settings dialog on its
                       * SYMBOL tab, which had nothing to do with the
                       * indicator the gear was sitting next to.
                       */
                      openIndicatorSettings(instance.id);
                      indicatorMenu.close();
                    }}
                    title="Edit this indicator's settings"
                  >
                    <Icon name="gear" size={11} />
                    {indicatorTitle(instance.kind, instance.params)}
                    <span className="pop-item-sub">{def?.name ?? instance.kind}</span>
                  </button>
                  <button
                    className="chdr-ind-btn"
                    onClick={() => toggleIndicator(instance.id)}
                    title={instance.visible ? 'Hide' : 'Show'}
                  >
                    <Icon name={instance.visible ? 'eye' : 'eye-off'} size={12} />
                  </button>
                  <button
                    className="chdr-ind-btn"
                    onClick={() => removeIndicator(instance.id)}
                    title="Remove"
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              );
            })}
            <div className="pop-sep" />
          </>
        ) : null}
        {indicatorMatches.length === 0 ? <div className="pop-empty">Nothing matches.</div> : null}
        {categories.map((category) => (
          <div key={category} data-testid="indicator-catalogue">
            <div className="pop-head">{category}</div>
            {indicatorMatches
              .filter((def) => def.category === category)
              .map((def) => (
                <button
                  key={def.kind}
                  className="pop-item"
                  onClick={() => {
                    /*
                     * Added AND opened.
                     *
                     * "Adding EMA should expose a real numeric Length input" -
                     * so the new instance's settings appear with it, rather
                     * than the trader having to hunt for where its length
                     * lives.
                     */
                    const id = addIndicator(def.kind);
                    indicatorMenu.close();
                    if (id) openIndicatorSettings(id);
                  }}
                  title={def.description}
                >
                  <Icon name="plus" size={11} />
                  {def.name}
                  <span className="pop-item-sub">{def.overlay ? 'overlay' : 'pane'}</span>
                </button>
              ))}
          </div>
        ))}
        <div className="pop-sep" />
        <div className="pop-empty">
          {INDICATORS.length} indicators, all computed from genuine bars.
        </div>
      </Popover>

      <div className="chdr-spacer" />

      {onMaximize ? (
        <button
          className={`chdr-icon ${maximized ? 'chdr-icon-on' : ''}`}
          onClick={onMaximize}
          title={maximized ? 'Back to the layout' : 'Fill the layout with this chart'}
          aria-label={maximized ? 'Restore the layout' : 'Maximize this chart'}
        >
          <Icon name={maximized ? 'minimize' : 'maximize'} size={12} />
        </button>
      ) : null}
      <button className="chdr-icon" onClick={() => openSettings('SYMBOL')} title="Chart settings">
        <Icon name="gear" />
      </button>
      <button className="chdr-icon" onClick={overflow.toggle} title="More">
        <Icon name="more" />
      </button>
      <Popover
        open={overflow.open}
        onClose={overflow.close}
        anchor={overflow.anchor}
        align="right"
        width={210}
        label="More"
      >
        {multiPane ? (
          <>
            <button
              className="pop-item"
              onClick={() => {
                // Chart type + indicators to the other panes; never the symbol,
                // interval, or any trading state (D-04).
                applyConfigToOtherPanes(paneId);
                overflow.close();
              }}
              title="Copy this chart's type and indicators to the other charts"
            >
              <Icon name="copy" size={12} />
              Apply to other charts
            </button>
            <div className="pop-sep" />
          </>
        ) : null}
        <button
          className="pop-item"
          onClick={() => {
            onScreenshot();
            overflow.close();
          }}
        >
          <Icon name="camera" size={12} />
          Save chart image
        </button>
        <div className="pop-sep" />
        <button
          className="pop-item"
          onClick={() => {
            openSettings('SCALES');
            overflow.close();
          }}
        >
          <Icon name="gear" size={12} />
          Scales and lines
        </button>
        <button
          className="pop-item"
          onClick={() => {
            openSettings('CANVAS');
            overflow.close();
          }}
        >
          <Icon name="gear" size={12} />
          Canvas
        </button>
      </Popover>
    </div>
  );
}
