/**
 * A small anchored popover.
 *
 * Every menu in the terminal is one of these: the symbol search, the chart
 * style picker, the indicator list, the overflow menu. Having one makes them
 * behave the same - click outside to dismiss, Escape to dismiss, and never
 * taller than the viewport.
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react';
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
  const [style, setStyle] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const panelWidth = width ?? Math.max(rect.width, 180);
    const left =
      align === 'right'
        ? Math.max(6, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 6))
        : Math.max(6, Math.min(rect.left, window.innerWidth - panelWidth - 6));
    const top = rect.bottom + 3;
    setStyle({ top, left, maxHeight: Math.max(160, window.innerHeight - top - 10) });
  }, [open, anchor, align, width]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchor?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    // Capture, so a click that also opens another menu still closes this one.
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose, anchor]);

  if (!open || !style) return null;

  return (
    <div
      className="popover"
      ref={ref}
      role="dialog"
      aria-label={label}
      style={{
        top: style.top,
        left: style.left,
        width: width ?? undefined,
        maxHeight: style.maxHeight,
      }}
    >
      {children}
    </div>
  );
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
  return {
    open,
    anchor,
    toggle: (event) => {
      setAnchor(event.currentTarget as HTMLElement);
      setOpen((value) => !value);
    },
    close: () => setOpen(false),
  };
}
