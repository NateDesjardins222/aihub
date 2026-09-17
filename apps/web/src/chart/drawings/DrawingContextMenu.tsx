/**
 * The object context menu.
 *
 * Right-clicking an object should offer everything that can be done to it
 * without hunting for a toolbar: settings, order, lock, visibility, templates
 * and delete. It is positioned at the cursor and flipped back inside the
 * viewport when it would overflow.
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { useChartStore } from '../../state/chart-store';
import { KIND_LABEL } from './model';
import { Icon } from '../../ui/Icon';
import './DrawingMenus.css';

export interface DrawingContextMenuProps {
  readonly drawingId: string;
  readonly x: number;
  readonly y: number;
  readonly onClose: () => void;
  readonly onOpenProperties: (drawingId: string) => void;
}

const WIDTH = 210;

export function DrawingContextMenu({
  drawingId,
  x,
  y,
  onClose,
  onOpenProperties,
}: DrawingContextMenuProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: y, left: x });
  const drawing = useChartStore((s) => s.drawings.find((item) => item.id === drawingId) ?? null);
  const templates = useChartStore((s) => s.templates);
  const updateDrawing = useChartStore((s) => s.updateDrawing);
  const commitHistory = useChartStore((s) => s.commitHistory);
  const duplicateDrawing = useChartStore((s) => s.duplicateDrawing);
  const removeDrawing = useChartStore((s) => s.removeDrawing);
  const reorderDrawing = useChartStore((s) => s.reorderDrawing);
  const applyTemplate = useChartStore((s) => s.applyTemplate);
  const setToolDefault = useChartStore((s) => s.setToolDefault);

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 240;
    setPosition({
      top: Math.max(6, Math.min(y, window.innerHeight - height - 8)),
      left: Math.max(6, Math.min(x, window.innerWidth - WIDTH - 8)),
    });
  }, [x, y]);

  /*
   * Registered once, reading the current onClose through a ref: a handler that
   * runs earlier in the same dispatch can trigger a synchronous React update,
   * and a listener removed and re-added mid-dispatch misses that event. See
   * the same note in Popover.
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current?.contains(event.target as Node)) return;
      closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeRef.current();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  if (!drawing) return null;
  const mine = templates.filter((template) => template.kind === drawing.kind);

  const act = (run: () => void) => (): void => {
    run();
    onClose();
  };

  return (
    <div
      className="dm-menu"
      role="menu"
      ref={ref}
      data-testid="drawing-context-menu"
      aria-label={`${KIND_LABEL[drawing.kind]} menu`}
      style={{ top: position.top, left: position.left, width: WIDTH }}
    >
      <div className="dm-head">{KIND_LABEL[drawing.kind]}</div>

      <button className="dm-item" onClick={act(() => onOpenProperties(drawing.id))}>
        <Icon name="gear" size={12} />
        Settings…
      </button>
      <button className="dm-item" onClick={act(() => duplicateDrawing(drawing.id))}>
        <Icon name="copy" size={12} />
        Duplicate
        <span className="dm-key">Ctrl D</span>
      </button>

      <div className="dm-sep" />

      <button className="dm-item" onClick={act(() => reorderDrawing(drawing.id, 'FRONT'))}>
        Bring to front
      </button>
      <button className="dm-item" onClick={act(() => reorderDrawing(drawing.id, 'BACK'))}>
        Send to back
      </button>

      <div className="dm-sep" />

      <button
        className="dm-item"
        onClick={act(() => {
          updateDrawing(drawing.id, { locked: !drawing.locked });
          commitHistory();
        })}
      >
        <Icon name={drawing.locked ? 'unlock' : 'lock'} size={12} />
        {drawing.locked ? 'Unlock' : 'Lock'}
      </button>
      <button
        className="dm-item"
        onClick={act(() => {
          updateDrawing(drawing.id, { hidden: !drawing.hidden });
          commitHistory();
        })}
      >
        <Icon name={drawing.hidden ? 'eye' : 'eye-off'} size={12} />
        {drawing.hidden ? 'Show' : 'Hide'}
      </button>

      <div className="dm-sep" />

      <button className="dm-item" onClick={act(() => setToolDefault(drawing.id))}>
        Use as default for this tool
      </button>
      {mine.length > 0 ? (
        <>
          <div className="dm-head">Templates</div>
          {mine.map((template) => (
            <button
              key={template.id}
              className="dm-item"
              onClick={act(() => applyTemplate(template.id, drawing.id))}
            >
              <span className="dm-dot" style={{ background: template.style.color }} />
              {template.name}
            </button>
          ))}
        </>
      ) : null}

      <div className="dm-sep" />

      <button
        className="dm-item dm-danger"
        disabled={drawing.locked}
        title={drawing.locked ? 'Unlock it first' : undefined}
        onClick={act(() => removeDrawing(drawing.id))}
      >
        <Icon name="trash" size={12} />
        Delete
        <span className="dm-key">Del</span>
      </button>
    </div>
  );
}
