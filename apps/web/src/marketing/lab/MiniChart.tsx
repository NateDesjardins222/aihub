/*
 * A clean product line/area chart for the Atlas experiments — deliberately NOT a
 * candlestick strip (that concept is retired). A smooth synthetic price line that
 * scrolls left, with an area fill, a moving last-price marker and a faint grid. It
 * reads as the real product surface, not decorative market imagery, and is labelled
 * as illustrative. Canvas-only; pauses offscreen/hidden; still under reduced motion.
 */
import { useEffect, useRef, type JSX } from 'react';
import { useRaf } from './hooks';

export function MiniChart({
  className,
  seed = 7,
  live = true,
}: {
  className?: string;
  seed?: number;
  live?: boolean;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const state = useRef({ t: seed * 1000, offset: 0 });

  const draw = (canvas: HTMLCanvasElement, phase: number): void => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Faint grid.
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    for (let g = 1; g < 4; g += 1) {
      const y = Math.round((h / 4) * g) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // Smooth synthetic series (pure function of x + slow phase) — bounded, no drift.
    const pad = 14;
    const val = (x: number): number => {
      const k = x * 0.012 + phase;
      return (
        Math.sin(k) * 0.5 +
        Math.sin(k * 2.3 + 1.7) * 0.22 +
        Math.sin(k * 0.6 + 4.1) * 0.3 +
        Math.sin(k * 5.1) * 0.06
      );
    };
    let min = Infinity;
    let max = -Infinity;
    const pts: Array<[number, number]> = [];
    for (let px = 0; px <= w; px += 4) {
      const v = val(px + phase * 60);
      pts.push([px, v]);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min || 1;
    const yOf = (v: number): number => pad + (1 - (v - min) / range) * (h - pad * 2);

    // Area fill.
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (const [px, v] of pts) ctx.lineTo(px, yOf(v));
    ctx.lineTo(w, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(210,215,225,0.16)');
    grad.addColorStop(1, 'rgba(210,215,225,0)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Line.
    ctx.beginPath();
    pts.forEach(([px, v], i) => (i ? ctx.lineTo(px, yOf(v)) : ctx.moveTo(px, yOf(v))));
    ctx.strokeStyle = 'rgba(233,236,241,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Last-price marker.
    const last = pts[pts.length - 1];
    if (last) {
      const y = yOf(last[1]);
      ctx.strokeStyle = 'rgba(233,236,241,0.28)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(w - 3, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#f4f5f7'; ctx.fill();
    }
  };

  useRaf(ref, (_t, dt) => {
    if (!ref.current) return;
    if (live) state.current.offset += dt * 0.00018;
    draw(ref.current, state.current.offset);
  });

  // First static paint — covers the reduced-motion case, where the rAF loop never runs.
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const id = requestAnimationFrame(() => draw(c, state.current.offset));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={ref} className={className} role="img" aria-label="Illustrative Atlas price chart" />;
}
