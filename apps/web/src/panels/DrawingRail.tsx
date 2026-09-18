/**
 * The drawing toolbar.
 *
 * Favourites at the top, then expandable categories, then the workspace
 * controls: magnet, the style for new objects, undo, redo and the object tree.
 * The previous version showed twenty-seven disabled buttons at once; this one
 * shows the four or five tools a trader actually reaches for and puts the rest
 * one click away, and every tool in it works.
 *
 * What can be done to the SELECTED object is not here. It is on the floating
 * style bar and in the object's context menu, next to the object itself, so the
 * rail keeps a constant size whatever is selected and nothing is offered twice.
 */
import { useRef, useState, type JSX } from 'react';
import { useChartStore, type DrawingTool } from '../state/chart-store';
import { KIND_LABEL, type DrawingKind } from '../chart/drawings/model';
import { Icon, type IconName } from '../ui/Icon';
import { Popover, usePopover } from '../ui/Popover';
import { ObjectTree } from '../chart/drawings/ObjectTree';
import './DrawingRail.css';

const TOOL_ICON: Record<DrawingKind, IconName> = {
  TREND_LINE: 'trend',
  RAY: 'ray',
  EXTENDED_LINE: 'trend',
  HORIZONTAL_LINE: 'horizontal',
  VERTICAL_LINE: 'vertical',
  RECTANGLE: 'rect',
  FIB_RETRACEMENT: 'fib',
  TEXT: 'text',
  MEASURE: 'measure',
  LONG_POSITION: 'position-long',
  SHORT_POSITION: 'position-short',
};

const CATEGORIES: ReadonlyArray<{ name: string; tools: readonly DrawingKind[] }> = [
  { name: 'Lines', tools: ['TREND_LINE', 'RAY', 'EXTENDED_LINE', 'HORIZONTAL_LINE', 'VERTICAL_LINE'] },
  { name: 'Shapes', tools: ['RECTANGLE'] },
  { name: 'Fibonacci', tools: ['FIB_RETRACEMENT'] },
  { name: 'Risk and reward', tools: ['LONG_POSITION', 'SHORT_POSITION'] },
  { name: 'Annotation', tools: ['TEXT'] },
  { name: 'Measure', tools: ['MEASURE'] },
];

const DASHES: ReadonlyArray<{ id: 'SOLID' | 'DASHED' | 'DOTTED'; label: string }> = [
  { id: 'SOLID', label: 'Solid' },
  { id: 'DASHED', label: 'Dashed' },
  { id: 'DOTTED', label: 'Dotted' },
];

const MAGNET_HINT: Record<'OFF' | 'WEAK' | 'STRONG', string> = {
  OFF: 'Magnet off: anchors go exactly where you click',
  WEAK: 'Weak magnet: snaps to an open, high, low or close when you are close to one',
  STRONG: 'Strong magnet: always snaps to the nearest open, high, low or close',
};

const SWATCHES = [
  '#4d8dff',
  '#2ec4a6',
  '#f2544b',
  '#f5a524',
  '#a879f0',
  '#e4e9f2',
  '#63708a',
];

export function DrawingRail({ symbol }: { symbol: string }): JSX.Element {
  const tool = useChartStore((s) => s.tool);
  const setTool = useChartStore((s) => s.setTool);
  const magnet = useChartStore((s) => s.magnet);
  const cycleMagnet = useChartStore((s) => s.cycleMagnet);
  const favourites = useChartStore((s) => s.favouriteTools);
  const toggleFavouriteTool = useChartStore((s) => s.toggleFavouriteTool);
  const drawings = useChartStore((s) => s.drawings);
  const selectedId = useChartStore((s) => s.selectedDrawingId);
  const updateDrawing = useChartStore((s) => s.updateDrawing);
  const commitHistory = useChartStore((s) => s.commitHistory);
  const clearDrawings = useChartStore((s) => s.clearDrawings);
  const defaultStyle = useChartStore((s) => s.defaultStyle);
  const undo = useChartStore((s) => s.undo);
  const redo = useChartStore((s) => s.redo);
  const history = useChartStore((s) => s.history);
  const historyIndex = useChartStore((s) => s.historyIndex);
  const setDefaultStyle = useChartStore((s) => s.setDefaultStyle);
  const setDrawingStyle = useChartStore((s) => s.setDrawingStyle);

  const more = usePopover();
  const style = usePopover();
  const objects = usePopover();
  const [expanded, setExpanded] = useState<string | null>(null);
  const sticky = useChartStore((state) => state.toolSticky);
  const setSticky = (next: boolean): void => useChartStore.setState({ toolSticky: next });
  const railRef = useRef<HTMLElement>(null);

  const selected = drawings.find((drawing) => drawing.id === selectedId) ?? null;
  const mine = drawings.filter((drawing) => drawing.symbol === symbol);
  const activeStyle = selected?.style ?? defaultStyle;

  /*
   * Arming a tool does not hijack the chart.
   *
   * One click, one object, and the cursor comes back - which is the default
   * because the alternative is a chart that has stopped panning and a trader
   * who has to work out why. Persistent mode is the pin beside the cursor: an
   * explicit choice, visible while it is in force, and Escape or the cursor
   * button ends it.
   */
  const pick = (next: DrawingTool): void =>
    setTool(tool === next ? 'CURSOR' : next, sticky);

  return (
    <nav className="rail" ref={railRef} aria-label="Drawing tools">
      <button
        className={`rail-btn ${tool === 'CURSOR' ? 'rail-btn-on' : ''}`}
        onClick={() => setTool('CURSOR')}
        title="Cursor"
        aria-label="Cursor"
      >
        <Icon name="cursor" />
      </button>

      <button
        className={`rail-btn ${sticky ? 'rail-btn-on' : ''}`}
        onClick={() => {
          const next = !sticky;
          setSticky(next);
          // Applying it to whatever is armed right now, so the toggle takes
          // effect on the tool in the trader's hand rather than the next one.
          setTool(tool, next);
        }}
        title={
          sticky
            ? 'Keeping the tool armed: it stays selected after each object'
            : 'Keep the tool armed after drawing, instead of returning to the cursor'
        }
        aria-label="Keep the drawing tool armed"
        aria-pressed={sticky}
        data-testid="tool-sticky"
      >
        <Icon name={sticky ? 'lock' : 'unlock'} />
      </button>

      <div className="rail-sep" />

      {/*
        The favourites, marked as TOOLS.
        
        The rail also holds a cursor, a sticky-mode pin, a magnet, an object
        tree and undo/redo - all of which are modes and actions rather than
        things you draw with. Marking the tools lets a check count the drawing
        tools on show without counting the controls around them.
      */}
      {favourites.map((kind) => (
        <button
          key={kind}
          className={`rail-btn ${tool === kind ? 'rail-btn-on' : ''}`}
          onClick={() => pick(kind)}
          title={KIND_LABEL[kind]}
          aria-label={KIND_LABEL[kind]}
          data-rail="tool"
        >
          <Icon name={TOOL_ICON[kind]} />
        </button>
      ))}

      <button className="rail-btn" onClick={more.toggle} title="All drawing tools" aria-label="All drawing tools">
        <Icon name="chevron-right" size={12} />
      </button>
      <Popover open={more.open} onClose={more.close} anchor={more.anchor} width={230} label="Drawing tools">
        {CATEGORIES.map((category) => {
          const open = expanded === category.name || CATEGORIES.length === 1;
          return (
            <div key={category.name}>
              <button
                className="pop-item"
                onClick={() => setExpanded(open ? null : category.name)}
                aria-expanded={open}
              >
                <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
                {category.name}
                <span className="pop-item-sub">{category.tools.length}</span>
              </button>
              {open
                ? category.tools.map((kind) => (
                    <div className="rail-tool-row" key={kind}>
                      <button
                        className={`pop-item rail-tool-item ${tool === kind ? 'pop-item-on' : ''}`}
                        onClick={() => {
                          pick(kind);
                          more.close();
                        }}
                      >
                        <Icon name={TOOL_ICON[kind]} size={12} />
                        {KIND_LABEL[kind]}
                      </button>
                      <button
                        className={`rail-fav ${favourites.includes(kind) ? 'rail-fav-on' : ''}`}
                        onClick={() => toggleFavouriteTool(kind)}
                        title={favourites.includes(kind) ? 'Unpin from the rail' : 'Pin to the rail'}
                        aria-label={`Favourite ${KIND_LABEL[kind]}`}
                      >
                        <Icon name="star" size={11} />
                      </button>
                    </div>
                  ))
                : null}
            </div>
          );
        })}
      </Popover>

      <div className="rail-sep" />

      <button
        className={`rail-btn ${magnet === 'OFF' ? '' : 'rail-btn-on'} ${
          magnet === 'STRONG' ? 'rail-btn-strong' : ''
        }`}
        onClick={cycleMagnet}
        title={MAGNET_HINT[magnet]}
        aria-label="Magnet"
        data-magnet={magnet}
      >
        <Icon name="magnet" />
      </button>

      <button
        className="rail-btn"
        onClick={style.toggle}
        title={selected ? 'Style of the selected object' : 'Style for new objects'}
        aria-label="Drawing style"
      >
        <span className="rail-swatch" style={{ background: activeStyle.color }} />
      </button>
      <Popover open={style.open} onClose={style.close} anchor={style.anchor} width={210} label="Style">
        <div className="pop-head">{selected ? KIND_LABEL[selected.kind] : 'New objects'}</div>
        <div className="rail-swatches">
          {SWATCHES.map((colour) => (
            <button
              key={colour}
              className={`rail-swatch-btn ${activeStyle.color === colour ? 'rail-swatch-on' : ''}`}
              style={{ background: colour }}
              onClick={() =>
                selected
                  ? setDrawingStyle(selected.id, { color: colour })
                  : setDefaultStyle({ color: colour })
              }
              aria-label={colour}
            />
          ))}
        </div>
        <div className="pop-head">Line</div>
        {DASHES.map((dash) => (
          <button
            key={dash.id}
            className={`pop-item ${activeStyle.dash === dash.id ? 'pop-item-on' : ''}`}
            onClick={() =>
              selected
                ? setDrawingStyle(selected.id, { dash: dash.id })
                : setDefaultStyle({ dash: dash.id })
            }
          >
            {dash.label}
          </button>
        ))}
        <div className="pop-head">Width</div>
        <div className="rail-widths">
          {[1, 2, 3].map((width) => (
            <button
              key={width}
              className={`pop-item ${activeStyle.width === width ? 'pop-item-on' : ''}`}
              onClick={() =>
                selected
                  ? setDrawingStyle(selected.id, { width })
                  : setDefaultStyle({ width })
              }
            >
              {width}px
            </button>
          ))}
        </div>
      </Popover>

      <div className="rail-sep" />

      <button
        className="rail-btn"
        onClick={undo}
        disabled={historyIndex <= 0}
        title="Undo"
        aria-label="Undo"
      >
        <Icon name="undo" />
      </button>
      <button
        className="rail-btn"
        onClick={redo}
        disabled={historyIndex >= history.length - 1}
        title="Redo"
        aria-label="Redo"
      >
        <Icon name="redo" />
      </button>

      <div className="rail-grow" />

      <button
        className="rail-btn"
        onClick={objects.toggle}
        title={`Objects on ${symbol}`}
        aria-label="Object tree"
      >
        <Icon name="layers" />
        {mine.length > 0 ? <span className="rail-count">{mine.length}</span> : null}
      </button>
      <Popover
        open={objects.open}
        onClose={objects.close}
        anchor={objects.anchor}
        width={280}
        label="Objects"
      >
        <div className="pop-head">Objects on {symbol}</div>
        <ObjectTree symbol={symbol} />
        {mine.length > 0 ? (
          <>
            <div className="pop-sep" />
            <button
              className="pop-item rail-clear"
              onClick={() => {
                clearDrawings(symbol);
                objects.close();
              }}
            >
              <Icon name="trash" size={12} />
              Remove all {mine.length}
            </button>
          </>
        ) : null}
      </Popover>
    </nav>
  );
}
