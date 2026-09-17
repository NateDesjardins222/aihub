/**
 * The drawing toolbar.
 *
 * Favourites at the top, then expandable categories, then the object controls.
 * The previous version showed twenty-seven disabled buttons at once; this one
 * shows the four or five tools a trader actually reaches for and puts the rest
 * one click away, and every tool in it works.
 */
import { useRef, useState, type JSX } from 'react';
import { useChartStore, type DrawingTool } from '../state/chart-store';
import { KIND_LABEL, type DrawingKind } from '../chart/drawings/model';
import { Icon, type IconName } from '../ui/Icon';
import { Popover, usePopover } from '../ui/Popover';
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
};

const CATEGORIES: ReadonlyArray<{ name: string; tools: readonly DrawingKind[] }> = [
  { name: 'Lines', tools: ['TREND_LINE', 'RAY', 'EXTENDED_LINE', 'HORIZONTAL_LINE', 'VERTICAL_LINE'] },
  { name: 'Shapes', tools: ['RECTANGLE'] },
  { name: 'Fibonacci', tools: ['FIB_RETRACEMENT'] },
  { name: 'Annotation', tools: ['TEXT'] },
  { name: 'Measure', tools: ['MEASURE'] },
];

const DASHES: ReadonlyArray<{ id: 'SOLID' | 'DASHED' | 'DOTTED'; label: string }> = [
  { id: 'SOLID', label: 'Solid' },
  { id: 'DASHED', label: 'Dashed' },
  { id: 'DOTTED', label: 'Dotted' },
];

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
  const toggleMagnet = useChartStore((s) => s.toggleMagnet);
  const favourites = useChartStore((s) => s.favouriteTools);
  const toggleFavouriteTool = useChartStore((s) => s.toggleFavouriteTool);
  const drawings = useChartStore((s) => s.drawings);
  const selectedId = useChartStore((s) => s.selectedDrawingId);
  const updateDrawing = useChartStore((s) => s.updateDrawing);
  const removeDrawing = useChartStore((s) => s.removeDrawing);
  const duplicateDrawing = useChartStore((s) => s.duplicateDrawing);
  const clearDrawings = useChartStore((s) => s.clearDrawings);
  const defaultStyle = useChartStore((s) => s.defaultStyle);
  const setDefaultStyle = useChartStore((s) => s.setDefaultStyle);

  const more = usePopover();
  const style = usePopover();
  const [expanded, setExpanded] = useState<string | null>(null);
  const railRef = useRef<HTMLElement>(null);

  const selected = drawings.find((drawing) => drawing.id === selectedId) ?? null;
  const mine = drawings.filter((drawing) => drawing.symbol === symbol);
  const activeStyle = selected?.style ?? defaultStyle;

  const pick = (next: DrawingTool): void => setTool(tool === next ? 'CURSOR' : next);

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

      <div className="rail-sep" />

      {favourites.map((kind) => (
        <button
          key={kind}
          className={`rail-btn ${tool === kind ? 'rail-btn-on' : ''}`}
          onClick={() => pick(kind)}
          title={KIND_LABEL[kind]}
          aria-label={KIND_LABEL[kind]}
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
        className={`rail-btn ${magnet ? 'rail-btn-on' : ''}`}
        onClick={toggleMagnet}
        title={
          magnet
            ? 'Magnet on: anchors snap to a price the bar printed'
            : 'Magnet off: anchors go exactly where you click'
        }
        aria-label="Magnet"
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
                  ? updateDrawing(selected.id, { style: { ...selected.style, color: colour } })
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
                ? updateDrawing(selected.id, { style: { ...selected.style, dash: dash.id } })
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
                  ? updateDrawing(selected.id, { style: { ...selected.style, width } })
                  : setDefaultStyle({ width })
              }
            >
              {width}px
            </button>
          ))}
        </div>
      </Popover>

      {selected ? (
        <>
          <div className="rail-sep" />
          <button
            className="rail-btn"
            onClick={() => updateDrawing(selected.id, { locked: !selected.locked })}
            title={selected.locked ? 'Unlock' : 'Lock'}
            aria-label="Lock"
          >
            <Icon name={selected.locked ? 'lock' : 'unlock'} />
          </button>
          <button
            className="rail-btn"
            onClick={() => updateDrawing(selected.id, { hidden: !selected.hidden })}
            title={selected.hidden ? 'Show' : 'Hide'}
            aria-label="Hide"
          >
            <Icon name={selected.hidden ? 'eye-off' : 'eye'} />
          </button>
          <button
            className="rail-btn"
            onClick={() => duplicateDrawing(selected.id)}
            title="Duplicate"
            aria-label="Duplicate"
          >
            <Icon name="copy" />
          </button>
          <button
            className="rail-btn rail-btn-danger"
            onClick={() => removeDrawing(selected.id)}
            disabled={selected.locked}
            title={selected.locked ? 'Unlock it first' : 'Delete'}
            aria-label="Delete"
          >
            <Icon name="trash" />
          </button>
        </>
      ) : null}

      <div className="rail-grow" />

      {mine.length > 0 ? (
        <button
          className="rail-btn rail-btn-danger"
          onClick={() => clearDrawings(symbol)}
          title={`Remove all ${mine.length} drawings on ${symbol}`}
          aria-label="Remove all drawings"
        >
          <span className="rail-count">{mine.length}</span>
        </button>
      ) : null}
    </nav>
  );
}
