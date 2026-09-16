import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A resizable panel dimension that survives reload.
 *
 * Panels remembering their size is a stated requirement, so the value is written
 * to localStorage on every settle rather than held only in component state.
 */
export function usePersistentSize(
  key: string,
  initial: number,
  bounds: { min: number; max: number },
): [number, (next: number) => void] {
  const [size, setSize] = useState<number>(() => {
    const stored = Number(localStorage.getItem(key));
    if (!Number.isFinite(stored) || stored <= 0) return initial;
    return Math.min(bounds.max, Math.max(bounds.min, stored));
  });

  const set = useCallback(
    (next: number) => {
      const clamped = Math.min(bounds.max, Math.max(bounds.min, next));
      setSize(clamped);
      localStorage.setItem(key, String(clamped));
    },
    [key, bounds.min, bounds.max],
  );

  return [size, set];
}

export function usePersistentFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    const stored = localStorage.getItem(key);
    return stored === null ? initial : stored === 'true';
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      localStorage.setItem(key, String(next));
    },
    [key],
  );
  return [value, set];
}

type Axis = 'x' | 'y';

/**
 * Drag handler for a splitter. `sign` is +1 when dragging toward larger values
 * grows the panel, -1 when the panel is anchored to the right or bottom edge.
 */
export function useDragResize(
  axis: Axis,
  current: number,
  onChange: (next: number) => void,
  sign: 1 | -1 = 1,
): (event: React.PointerEvent) => void {
  const stateRef = useRef({ start: 0, base: 0 });

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      const target = event.currentTarget as HTMLElement;
      target.setPointerCapture(event.pointerId);
      stateRef.current = { start: axis === 'x' ? event.clientX : event.clientY, base: current };

      const move = (e: PointerEvent): void => {
        const pos = axis === 'x' ? e.clientX : e.clientY;
        onChange(stateRef.current.base + sign * (pos - stateRef.current.start));
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [axis, current, onChange, sign],
  );

  return onPointerDown;
}

/** Keeps a ticking clock without re-rendering anything that does not need it. */
export function useClock(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
