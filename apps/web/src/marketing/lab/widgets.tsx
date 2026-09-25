/*
 * Small interaction widgets shared across the lab: a magnetic button (the label +
 * arrow lead the cursor, the surface follows with a soft compress on press) and an
 * animated number that tweens when its value changes (for the account configurator).
 * Both keep per-frame work off React state.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { clamp, lerp, prefersReduced } from './hooks';

export function MagneticButton({
  children,
  onClick,
  variant = 'primary',
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'gold';
  className?: string;
}): JSX.Element {
  const ref = useRef<HTMLButtonElement | null>(null);
  const inner = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReduced()) return;
    let raf = 0;
    const target = { x: 0, y: 0 };
    const cur = { x: 0, y: 0 };
    const onMove = (e: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const reach = 90;
      const d = Math.hypot(dx, dy);
      const pull = d < reach ? 1 - d / reach : 0;
      target.x = clamp(dx * 0.3 * pull, -14, 14);
      target.y = clamp(dy * 0.4 * pull, -10, 10);
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const tick = (): void => {
      cur.x = lerp(cur.x, target.x, 0.2);
      cur.y = lerp(cur.y, target.y, 0.2);
      el.style.transform = `translate(${cur.x.toFixed(2)}px, ${cur.y.toFixed(2)}px)`;
      if (inner.current) inner.current.style.transform = `translate(${(cur.x * 0.4).toFixed(2)}px, ${(cur.y * 0.4).toFixed(2)}px)`;
      if (Math.abs(cur.x - target.x) > 0.1 || Math.abs(cur.y - target.y) > 0.1) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = 0;
      }
    };
    const reset = (): void => {
      target.x = 0; target.y = 0;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerleave', reset);
    return () => {
      window.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', reset);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <button ref={ref} className={`ht-btn ht-btn--${variant} lab-mag ${className ?? ''}`} onClick={onClick}>
      <span ref={inner} className="lab-mag-inner">
        {children}
        <span className="lab-mag-arrow" aria-hidden="true">→</span>
      </span>
    </button>
  );
}

export function AnimatedNumber({
  value,
  format,
  className,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
}): JSX.Element {
  const [display, setDisplay] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (prefersReduced()) {
      setDisplay(value);
      from.current = value;
      return;
    }
    const start = performance.now();
    const a = from.current;
    const b = value;
    const dur = 480;
    let raf = 0;
    const tick = (t: number): void => {
      const k = clamp((t - start) / dur, 0, 1);
      const eased = 1 - Math.pow(1 - k, 3);
      setDisplay(a + (b - a) * eased);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = b;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className={className}>{format(display)}</span>;
}
