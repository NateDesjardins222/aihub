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
import { useSession, activeInstrument } from '../state/session';
import { useChartStore } from '../state/chart-store';
import { useWorkspace, ALL_TIMEFRAMES } from '../state/workspace';
import { PHASE_1_CHART_TYPES, type ChartType } from './ChartAdapter';
import { INDICATORS, indicatorDef, searchIndicators } from './indicators/registry';
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
  readonly timeframe: Timeframe;
  readonly onTimeframe: (tf: Timeframe) => void;
  readonly onScreenshot: () => void;
}

export function ChartHeader({ timeframe, onTimeframe, onScreenshot }: ChartHeaderProps): JSX.Element {
  const instruments = useSession((s) => s.instruments);
  const activeSymbol = useSession((s) => s.activeSymbol);
  const setActiveSymbol = useSession((s) => s.setActiveSymbol);
  const instrument = useSession(activeInstrument);

  const chartType = useChartStore((s) => s.chartType);
  const setChartType = useChartStore((s) => s.setChartType);
  const indicators = useChartStore((s) => s.indicators);
  const addIndicator = useChartStore((s) => s.addIndicator);
  const removeIndicator = useChartStore((s) => s.removeIndicator);
  const toggleIndicator = useChartStore((s) => s.toggleIndicator);

  const favourites = useWorkspace((s) => s.favouriteTimeframes);
  const toggleFavourite = useWorkspace((s) => s.toggleFavourite);
  const openSettings = useWorkspace((s) => s.openSettings);

  const symbolMenu = usePopover();
  const tfMenu = usePopover();
  const styleMenu = usePopover();
  const indicatorMenu = usePopover();
  const overflow = usePopover();

  const [symbolQuery, setSymbolQuery] = useState('');
  const [indicatorQuery, setIndicatorQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const needle = symbolQuery.trim().toLowerCase();
    if (needle.length === 0) return instruments;
    return instruments.filter((i) =>
      `${i.root} ${i.description} ${i.exchange}`.toLowerCase().includes(needle),
    );
  }, [instruments, symbolQuery]);

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
          onChange={(event) => setSymbolQuery(event.target.value)}
        />
        {matches.length === 0 ? <div className="pop-empty">No instrument matches.</div> : null}
        {matches.map((i) => (
          <button
            key={i.root}
            className={`pop-item ${i.root === activeSymbol ? 'pop-item-on' : ''}`}
            onClick={() => {
              setActiveSymbol(i.root);
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
        {indicators.length > 0 ? (
          <>
            <div className="pop-head">On this chart</div>
            {indicators.map((instance) => {
              const def = indicatorDef(instance.kind);
              return (
                <div className="chdr-ind-row" key={instance.id}>
                  <button
                    className="pop-item"
                    onClick={() => openSettings('SYMBOL')}
                    title="Edit in Settings"
                  >
                    {def?.name ?? instance.kind}
                    <span className="pop-item-sub">
                      {def?.params
                        .filter((param) => param.type === 'NUMBER')
                        .map((param) => instance.params[param.key])
                        .join(' ')}
                    </span>
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
          <div key={category}>
            <div className="pop-head">{category}</div>
            {indicatorMatches
              .filter((def) => def.category === category)
              .map((def) => (
                <button
                  key={def.kind}
                  className="pop-item"
                  onClick={() => {
                    addIndicator(def.kind);
                    indicatorMenu.close();
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
