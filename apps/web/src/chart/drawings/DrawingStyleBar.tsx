/**
 * The floating style bar.
 *
 * Follows the selected object so its colour, thickness and line style are one
 * click away without crossing the screen to a panel. It is React-rendered but
 * positioned in an animation frame from the projection, so panning or zooming
 * the chart drags it along without a re-render per frame.
 *
 * It is an overlay, not an input surface for the chart: it sits above the
 * canvas and its own buttons stop their events, so a click on the bar can
 * never reach the chart underneath.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import type { ChartAdapter } from '../ChartAdapter';
import { useChartStore } from '../../state/chart-store';
import { drawingBounds } from './model';
import { toolDef } from './registry';
import { Icon } from '../../ui/Icon';
import './DrawingMenus.css';

const SWATCHES = ['#4d8dff', '#2ec4a6', '#f2544b', '#f5a524', '#a879f0', '#e8edf7', '#63708a'];
const WIDTHS = [1, 2, 3];
const DASHES = [
  { id: 'SOLID' as const, label: 'Solid', pattern: '——' },
  { id: 'DASHED' as const, label: 'Dashed', pattern: '– –' },
  { id: 'DOTTED' as const, label: 'Dotted', pattern: '· ·' },
];

/** Bar height plus the gap it leaves above the object. */
const BAR_HEIGHT = 30;
const GAP = 10;

export function DrawingStyleBar({
  adapterRef,
  containerRef,
  symbol,
  ready,
  onOpenProperties,
}: {
  readonly adapterRef: React.RefObject<ChartAdapter | null>;
  readonly containerRef: React.RefObject<HTMLElement | null>;
  readonly symbol: string;
  readonly ready: boolean;
  readonly onOpenProperties: (drawingId: string) => void;
}): JSX.Element | null {
  const barRef = useRef<HTMLDivElement>(null);
  const selectedId = useChartStore((s) => s.selectedDrawingId);
  const drawing = useChartStore((s) => s.drawings.find((item) => item.id === selectedId) ?? null);
  const setDrawingStyle = useChartStore((s) => s.setDrawingStyle);
  const updateDrawing = useChartStore((s) => s.updateDrawing);
  const commitHistory = useChartStore((s) => s.commitHistory);
  const duplicateDrawing = useChartStore((s) => s.duplicateDrawing);
  const removeDrawing = useChartStore((s) => s.removeDrawing);
  const [expanded, setExpanded] = useState<'COLOUR' | 'WIDTH' | 'DASH' | null>(null);

  // The selection is read by the frame loop, which must not wait for a render.
  const liveRef = useRef<{ id: string | null }>({ id: null });
  liveRef.current.id = drawing && drawing.symbol === symbol ? drawing.id : null;

  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    const place = (): void => {
      frame = requestAnimationFrame(place);
      const bar = barRef.current;
      const id = liveRef.current.id;
      if (!bar) return;
      if (!id) {
        bar.style.visibility = 'hidden';
        return;
      }
      const projection = adapterRef.current?.projection() ?? null;
      const found = useChartStore.getState().drawings.find((item) => item.id === id) ?? null;
      if (!projection || !found) {
        bar.style.visibility = 'hidden';
        return;
      }
      const bounds = drawingBounds(found, projection);
      if (!bounds) {
        bar.style.visibility = 'hidden';
        return;
      }
      const width = bar.offsetWidth || 200;
      const centre = (bounds.left + bounds.right) / 2;
      const left = Math.max(4, Math.min(centre - width / 2, projection.width - width - 4));
      // Above the object, or below it when there is no room above.
      const above = bounds.top - BAR_HEIGHT - GAP;
      const top = above >= 4 ? above : Math.min(bounds.bottom + GAP, projection.height - BAR_HEIGHT - 4);
      bar.style.visibility = 'visible';
      bar.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [adapterRef, ready]);

  // Collapse an open sub-menu when the selection changes or clears.
  useEffect(() => setExpanded(null), [selectedId]);

  if (!ready || !containerRef) return null;
  const visible = drawing !== null && drawing.symbol === symbol;
  const def = drawing ? toolDef(drawing.kind) : null;
  const supports = (key: string): boolean =>
    def?.props.some((prop) => prop.key === key) ?? false;

  return (
    <div
      className="dsb"
      ref={barRef}
      role="toolbar"
      aria-label="Object style"
      data-testid="drawing-style-bar"
      hidden={!visible}
      // The bar owns its own clicks; the chart below must never see them.
      onPointerDown={(event) => event.stopPropagation()}
    >
      {drawing && supports('color') ? (
        <div className="dsb-group">
          <button
            className="dsb-btn"
            onClick={() => setExpanded(expanded === 'COLOUR' ? null : 'COLOUR')}
            title="Colour"
            aria-label="Colour"
          >
            <span className="dsb-swatch" style={{ background: drawing.style.color }} />
          </button>
          {expanded === 'COLOUR' ? (
            <div className="dsb-pop">
              {SWATCHES.map((colour) => (
                <button
                  key={colour}
                  className="dsb-swatch-btn"
                  style={{ background: colour }}
                  aria-label={colour}
                  onClick={() => {
                    setDrawingStyle(drawing.id, { color: colour });
                    setExpanded(null);
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {drawing && supports('width') ? (
        <div className="dsb-group">
          <button
            className="dsb-btn dsb-text"
            onClick={() => setExpanded(expanded === 'WIDTH' ? null : 'WIDTH')}
            title="Thickness"
            aria-label="Thickness"
          >
            {drawing.style.width}px
          </button>
          {expanded === 'WIDTH' ? (
            <div className="dsb-pop dsb-pop-list">
              {WIDTHS.map((width) => (
                <button
                  key={width}
                  className={`dsb-item ${drawing.style.width === width ? 'dsb-item-on' : ''}`}
                  onClick={() => {
                    setDrawingStyle(drawing.id, { width });
                    setExpanded(null);
                  }}
                >
                  {width}px
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {drawing && supports('dash') ? (
        <div className="dsb-group">
          <button
            className="dsb-btn dsb-text"
            onClick={() => setExpanded(expanded === 'DASH' ? null : 'DASH')}
            title="Line style"
            aria-label="Line style"
          >
            {DASHES.find((dash) => dash.id === drawing.style.dash)?.pattern ?? '——'}
          </button>
          {expanded === 'DASH' ? (
            <div className="dsb-pop dsb-pop-list">
              {DASHES.map((dash) => (
                <button
                  key={dash.id}
                  className={`dsb-item ${drawing.style.dash === dash.id ? 'dsb-item-on' : ''}`}
                  onClick={() => {
                    setDrawingStyle(drawing.id, { dash: dash.id });
                    setExpanded(null);
                  }}
                >
                  {dash.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="dsb-sep" />

      {drawing ? (
        <>
          <button
            className="dsb-btn"
            onClick={() => onOpenProperties(drawing.id)}
            title="Settings"
            aria-label="Object settings"
          >
            <Icon name="gear" size={12} />
          </button>
          <button
            className="dsb-btn"
            onClick={() => {
              updateDrawing(drawing.id, { locked: !drawing.locked });
              commitHistory();
            }}
            title={drawing.locked ? 'Unlock' : 'Lock'}
            aria-label="Lock object"
          >
            <Icon name={drawing.locked ? 'lock' : 'unlock'} size={12} />
          </button>
          <button
            className="dsb-btn"
            onClick={() => duplicateDrawing(drawing.id)}
            title="Duplicate"
            aria-label="Duplicate object"
          >
            <Icon name="copy" size={12} />
          </button>
          <button
            className="dsb-btn dsb-danger"
            onClick={() => removeDrawing(drawing.id)}
            disabled={drawing.locked}
            title={drawing.locked ? 'Unlock it first' : 'Delete'}
            aria-label="Delete object"
          >
            <Icon name="trash" size={12} />
          </button>
        </>
      ) : null}
    </div>
  );
}
