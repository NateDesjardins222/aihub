/**
 * A small anchored popover.
 *
 * Every menu in the terminal is one of these: the symbol search, the chart
 * style picker, the indicator list, the overflow menu. Having one makes them
 * behave the same - click outside to dismiss, Escape to dismiss, and never
 * taller than the viewport.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import './Popover.css';

export interface PopoverProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The element the popover is positioned against. */
  readonly anchor: HTMLElement | null;
  readonly align?: 'left' | 'right';
  readonly width?: number;
  readonly children: ReactNode;
  readonly label?: string;
}

export function Popover({
  open,
  onClose,
  anchor,
  align = 'left',
  width,
  children,
  label,
}: PopoverProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const panelWidth = width ?? Math.max(rect.width, 180);
    const left =
      align === 'right'
        ? Math.max(6, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 6))
        : Math.max(6, Math.min(rect.left, window.innerWidth - panelWidth - 6));
    setStyle({ left, ...verticalPlacement(rect, window.innerHeight) });
  }, [open, anchor, align, width]);

  /*
   * The dismiss handlers are registered ONCE per opening and read the current
   * onClose through a ref.
   *
   * Re-registering them on every render looks harmless and is not: a keydown
   * handler that runs earlier in the same dispatch can cause a synchronous
   * React update, and a listener removed and re-added during a dispatch never
   * receives that event. That is exactly how Escape stopped closing this
   * popover once the chart's own Escape handler started clearing a selection.
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeRef.current();
    };
    // Capture, so a click that also opens another menu still closes this one.
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!open || !style) return null;

  return (
    <div
      className="popover"
      ref={ref}
      role="dialog"
      aria-label={label}
      data-side={style.side}
      style={{
        top: style.side === 'below' ? style.offset : undefined,
        bottom: style.side === 'above' ? style.offset : undefined,
        left: style.left,
        width: width ?? undefined,
        maxHeight: style.maxHeight,
      }}
    >
      {children}
    </div>
  );
}

interface Placement {
  readonly left: number;
  readonly side: 'above' | 'below';
  /** Distance from the viewport's top (below) or bottom (above). */
  readonly offset: number;
  readonly maxHeight: number;
}

/** The gap between the anchor and the panel, and between the panel and the edge. */
const GAP = 3;
const EDGE = 10;
/**
 * Below this, a menu is cramped enough that it is worth flipping. It is two
 * rows plus a heading: less than that and the panel is a scroll bar with a
 * list inside it.
 */
const COMFORTABLE = 220;

/**
 * Choose the side to open on.
 *
 * Menus open downwards, which is what a reader expects. The exception is a
 * button near the bottom of the window - the object tree's, at the foot of the
 * drawing rail - where opening downwards leaves a list of eleven objects in a
 * 169px slot with its "remove all" action below the fold. When the space below
 * is cramped AND there is more of it above, the panel opens upwards instead.
 *
 * Exported for the unit test; not part of the component's public surface.
 */
export function verticalPlacement(
  rect: { readonly top: number; readonly bottom: number },
  viewportHeight: number,
): Omit<Placement, 'left'> {
  const below = viewportHeight - rect.bottom - GAP - EDGE;
  const above = rect.top - GAP - EDGE;
  if (below < COMFORTABLE && above > below) {
    return {
      side: 'above',
      offset: viewportHeight - rect.top + GAP,
      maxHeight: Math.max(160, above),
    };
  }
  return { side: 'below', offset: rect.bottom + GAP, maxHeight: Math.max(160, below) };
}

/** A hook for the anchor/open pair every popover needs. */
export function usePopover(): {
  open: boolean;
  anchor: HTMLElement | null;
  toggle: (event: React.MouseEvent) => void;
  close: () => void;
} {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  // Stable identities: see the note on the dismiss handlers above.
  const toggle = useCallback((event: React.MouseEvent) => {
    setAnchor(event.currentTarget as HTMLElement);
    setOpen((value) => !value);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  return useMemo(() => ({ open, anchor, toggle, close }), [open, anchor, toggle, close]);
}
