/**
 * The object tree.
 *
 * Every object on the instrument, newest at the top, with the three things a
 * trader needs when a chart gets busy: find it, hide it, lock it. Selecting a
 * row selects the object on the chart, so a line lost behind a cluster of
 * candles can still be reached.
 *
 * Rows are in reverse paint order - the topmost object first - which is the
 * order a click picks them in.
 */
import type { JSX } from 'react';
import { useChartStore } from '../../state/chart-store';
import { KIND_LABEL, type Drawing } from './model';
import { Icon } from '../../ui/Icon';
import './ObjectTree.css';

export function ObjectTree({ symbol }: { symbol: string }): JSX.Element {
  const drawings = useChartStore((s) => s.drawings);
  const selectedId = useChartStore((s) => s.selectedDrawingId);
  const select = useChartStore((s) => s.select);
  const updateDrawing = useChartStore((s) => s.updateDrawing);
  const commitHistory = useChartStore((s) => s.commitHistory);
  const removeDrawing = useChartStore((s) => s.removeDrawing);
  const openProperties = useChartStore((s) => s.openProperties);
  const reorderDrawing = useChartStore((s) => s.reorderDrawing);

  const mine = drawings.filter((drawing) => drawing.symbol === symbol);
  const rows = [...mine].reverse();

  if (rows.length === 0) {
    return <p className="ot-empty">Nothing drawn on {symbol} yet.</p>;
  }

  return (
    <div className="ot" data-testid="object-tree">
      {rows.map((drawing) => (
        <div
          className={`ot-row ${drawing.id === selectedId ? 'ot-row-on' : ''}`}
          key={drawing.id}
          data-testid="object-tree-row"
        >
          <button
            className="ot-name"
            onClick={() => select(drawing.id)}
            onDoubleClick={() => openProperties(drawing.id)}
            title="Click to select, double-click for settings"
          >
            <span className="ot-dot" style={{ background: drawing.style.color }} />
            <span className="ot-label">{KIND_LABEL[drawing.kind]}</span>
            <span className="ot-detail">{describe(drawing)}</span>
          </button>

          <button
            className="ot-btn"
            onClick={() => {
              updateDrawing(drawing.id, { hidden: !drawing.hidden });
              commitHistory();
            }}
            title={drawing.hidden ? 'Show' : 'Hide'}
            aria-label={`${drawing.hidden ? 'Show' : 'Hide'} ${KIND_LABEL[drawing.kind]}`}
          >
            <Icon name={drawing.hidden ? 'eye-off' : 'eye'} size={11} />
          </button>
          <button
            className="ot-btn"
            onClick={() => {
              updateDrawing(drawing.id, { locked: !drawing.locked });
              commitHistory();
            }}
            title={drawing.locked ? 'Unlock' : 'Lock'}
            aria-label={`${drawing.locked ? 'Unlock' : 'Lock'} ${KIND_LABEL[drawing.kind]}`}
          >
            <Icon name={drawing.locked ? 'lock' : 'unlock'} size={11} />
          </button>
          <button
            className="ot-btn"
            onClick={() => reorderDrawing(drawing.id, 'FRONT')}
            title="Bring to front"
            aria-label={`Bring ${KIND_LABEL[drawing.kind]} to front`}
          >
            <Icon name="chevron-up" size={11} />
          </button>
          <button
            className="ot-btn ot-btn-danger"
            onClick={() => removeDrawing(drawing.id)}
            disabled={drawing.locked}
            title={drawing.locked ? 'Unlock it first' : 'Delete'}
            aria-label={`Delete ${KIND_LABEL[drawing.kind]}`}
          >
            <Icon name="trash" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** A one-glance description: the price a level sits at, or the span it covers. */
function describe(drawing: Drawing): string {
  const first = drawing.anchors[0];
  if (!first) return '';
  if (drawing.kind === 'TEXT') return drawing.text.slice(0, 18);
  if (drawing.anchors.length === 1) return format(first.price);
  const last = drawing.anchors[drawing.anchors.length - 1]!;
  return `${format(first.price)} → ${format(last.price)}`;
}

function format(price: number): string {
  return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
