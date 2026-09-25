/*
 * Motion primitives for the design lab.
 *
 * All of these keep animation OUT of the React render loop: pointer state and
 * frame callbacks are delivered through refs and rAF, never setState-per-frame.
 * Loops pause when the element is offscreen (IntersectionObserver) or the tab is
 * hidden, and everything no-ops under prefers-reduced-motion.
 */
import { useEffect, useRef, type RefObject } from 'react';

export function prefersReduced(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export interface Pointer {
  /** -1..1 across the element (0 = centre). */
  x: number;
  y: number;
  /** Raw client-space position, for global effects. */
  cx: number;
  cy: number;
  inside: boolean;
}

/**
 * Tracks the pointer relative to `ref`'s box, updating a ref (no re-render).
 * When `global` is true it also tracks while the pointer is outside the element,
 * measured against the element centre — useful for a hero object that should lean
 * toward the cursor anywhere on the page.
 */
export function usePointer(ref: RefObject<HTMLElement | null>, global = false): RefObject<Pointer> {
  const p = useRef<Pointer>({ x: 0, y: 0, cx: 0, cy: 0, inside: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onMove = (e: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
      p.current.cx = e.clientX;
      p.current.cy = e.clientY;
      p.current.x = clamp(nx, -1.6, 1.6);
      p.current.y = clamp(ny, -1.6, 1.6);
      p.current.inside = nx >= -1 && nx <= 1 && ny >= -1 && ny <= 1;
    };
    const onLeave = (): void => {
      p.current.inside = false;
      if (!global) {
        p.current.x = 0;
        p.current.y = 0;
      }
    };
    const target: HTMLElement | Window = global ? window : el;
    target.addEventListener('pointermove', onMove as EventListener, { passive: true });
    if (!global) el.addEventListener('pointerleave', onLeave);
    return () => {
      target.removeEventListener('pointermove', onMove as EventListener);
      if (!global) el.removeEventListener('pointerleave', onLeave);
    };
  }, [ref, global]);
  return p;
}

/**
 * A requestAnimationFrame loop bound to an element's visibility. The callback
 * receives (timeMs, dtMs). It is skipped entirely under reduced motion (the caller
 * is expected to render a sane static state first).
 */
export function useRaf(
  ref: RefObject<HTMLElement | null>,
  cb: (timeMs: number, dtMs: number) => void,
  opts: { runWhenReduced?: boolean } = {},
): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReduced() && !opts.runWhenReduced) return;
    let raf = 0;
    let last = performance.now();
    let onscreen = true;
    let running = false;
    const frame = (t: number): void => {
      const dt = Math.min(64, t - last);
      last = t;
      cbRef.current(t, dt);
      raf = requestAnimationFrame(frame);
    };
    const start = (): void => {
      if (running || document.hidden || !onscreen) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = (): void => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const io = new IntersectionObserver(
      (entries) => {
        onscreen = entries.some((e) => e.isIntersecting);
        if (onscreen) start();
        else stop();
      },
      { threshold: 0 },
    );
    io.observe(el);
    const onVis = (): void => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVis);
    start();
    return () => {
      stop();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);
}

/**
 * Scroll progress of an element through the viewport, delivered to a callback via
 * rAF-on-scroll (passive). 0 when the element's top hits the bottom of the
 * viewport, 1 when its bottom passes the top. No state churn.
 */
export function useScrollProgress(
  ref: RefObject<HTMLElement | null>,
  cb: (p: number) => void,
): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let ticking = false;
    const compute = (): void => {
      ticking = false;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      const total = r.height + vh;
      const passed = vh - r.top;
      cbRef.current(clamp(passed / total, 0, 1));
    };
    const onScroll = (): void => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(compute);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    compute();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [ref]);
}
