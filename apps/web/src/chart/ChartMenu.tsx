/**
 * A context menu on the chart.
 *
 * The object menu and the order menu are the same control: a compact list at
 * the cursor, flipped back inside the viewport, dismissed on Escape or on a
 * press anywhere else. Only the items differ, so they are passed in and the
 * caller keeps the actions next to the code that performs them - an order
 * menu's items end in a request to the execution engine, and that logic does
 * not belong in a menu component.
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { Icon, type IconName } from '../ui/Icon';
import './drawings/DrawingMenus.css';

export interface ChartMenuItem {
  readonly id: string;
  /** A separator. Nothing else on the item is read. */
  readonly separator?: boolean;
  readonly label?: string;
  readonly icon?: IconName;
  /** The shortcut that does the same thing, shown on the right. */
  readonly shortcut?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly run?: () => void;
}

export interface ChartMenuProps {
  readonly head: string;
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly testId?: string;
  readonly items: readonly ChartMenuItem[];
  readonly onClose: () => void;
}

export function ChartMenu({
  head,
  x,
  y,
  width = 210,
  testId,
  items,
  onClose,
}: ChartMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState({ top: y, left: x });

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 220;
    setPlaced({
      top: Math.max(6, Math.min(y, window.innerHeight - height - 8)),
      left: Math.max(6, Math.min(x, window.innerWidth - width - 8)),
    });
  }, [x, y, width]);

  /*
   * Registered once, reading the current onClose through a ref: a handler that
   * runs earlier in the same dispatch can trigger a synchronous React update,
   * and a listener removed and re-added mid-dispatch misses that event.
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current?.contains(event.target as Node)) return;
      closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  return (
    <div
      className="dm-menu"
      role="menu"
      ref={ref}
      data-testid={testId}
      aria-label={head}
      style={{ top: placed.top, left: placed.left, width }}
    >
      <div className="dm-head">{head}</div>
      {items.map((item) =>
        item.separator ? (
          <div className="dm-sep" key={item.id} />
        ) : (
          <button
            key={item.id}
            className={`dm-item${item.danger ? ' dm-danger' : ''}`}
            role="menuitem"
            disabled={item.disabled}
            title={item.title}
            onClick={() => {
              item.run?.();
              onClose();
            }}
          >
            {item.icon ? <Icon name={item.icon} size={12} /> : null}
            {item.label}
            {item.shortcut ? <span className="dm-key">{item.shortcut}</span> : null}
          </button>
        ),
      )}
    </div>
  );
}
