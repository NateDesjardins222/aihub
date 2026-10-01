/**
 * useTilt — subtle pointer-follow 3D tilt for a premium physical surface (the payment
 * card). Restrained (±maxDeg, default 3°), rAF-throttled (no rerender storm — it mutates
 * CSS vars directly), and fully disabled under prefers-reduced-motion and on touch.
 *
 * Returns props to spread on the tilting element (give it className `htv2-tilt`). The CSS
 * reads --rx/--ry for the transform and --lx/--ly for a soft light highlight; the element
 * smoothly returns to neutral on pointer leave via the CSS transition.
 */
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useTilt(maxDeg = 3): {
  ref: (el: HTMLElement | null) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerLeave: () => void;
} {
  const elRef = useRef<HTMLElement | null>(null);
  const raf = useRef(0);
  const enabled = useRef(true);

  useEffect(() => {
    enabled.current = !prefersReducedMotion();
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, []);

  const setRef = useCallback((el: HTMLElement | null) => { elRef.current = el; }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    if (!enabled.current || e.pointerType === 'touch') return;
    const el = elRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const ry = (px - 0.5) * 2 * maxDeg;   // left/right → rotateY
      const rx = -(py - 0.5) * 2 * maxDeg;  // up/down → rotateX
      el.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
      el.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
      el.style.setProperty('--lx', `${(px * 100).toFixed(1)}%`);
      el.style.setProperty('--ly', `${(py * 100).toFixed(1)}%`);
      el.style.setProperty('--tilt-active', '1');
    });
  }, [maxDeg]);

  const onPointerLeave = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    if (raf.current) cancelAnimationFrame(raf.current);
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
    el.style.setProperty('--tilt-active', '0');
  }, []);

  return { ref: setRef, onPointerMove, onPointerLeave };
}
