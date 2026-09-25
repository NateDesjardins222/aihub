/*
 * A dark, monochrome particle field behind the account selector.
 *
 * Particles drift slowly and lean toward the cursor; when a family is hovered they
 * also bias toward a focus point (passed by ref), so the field subtly gathers around
 * the account the visitor is considering. It never drives React state per frame —
 * the cursor and focus are read from refs. The loop pauses when offscreen or the tab
 * is hidden, and does nothing under prefers-reduced-motion (a few static dots).
 */
import { useEffect, useRef, type JSX } from 'react';

export interface ParticleFieldHandle {
  /** 0..1 horizontal focus target (e.g. the hovered family tab centre), or null. */
  setFocus: (x: number | null, y: number | null) => void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  a: number;
}

export function ParticleField({
  className,
  focusRef,
}: {
  className?: string;
  focusRef?: React.MutableRefObject<ParticleFieldHandle | null>;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let cssW = 0;
    let cssH = 0;
    let dpr = 1;
    let particles: Particle[] = [];
    const mouse = { x: -1, y: -1, active: false };
    const focus = { x: -1, y: -1, active: false };

    if (focusRef) {
      focusRef.current = {
        setFocus: (fx, fy) => {
          if (fx == null || fy == null) {
            focus.active = false;
          } else {
            focus.active = true;
            focus.x = fx * cssW;
            focus.y = fy * cssH;
          }
        },
      };
    }

    function build(): void {
      const density = Math.min(120, Math.floor((cssW * cssH) / 14000));
      const count = reduce ? Math.min(36, density) : density;
      particles = new Array(count).fill(0).map(() => ({
        x: Math.random() * cssW,
        y: Math.random() * cssH,
        vx: (Math.random() - 0.5) * 0.12,
        vy: (Math.random() - 0.5) * 0.12,
        r: 0.6 + Math.random() * 1.6,
        a: 0.06 + Math.random() * 0.26,
      }));
    }

    function resize(): void {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      cssW = Math.max(1, Math.round(rect.width));
      cssH = Math.max(1, Math.round(rect.height));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      build();
    }

    function drawStatic(): void {
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      for (const p of particles) {
        ctx.beginPath();
        ctx.fillStyle = `rgba(200,206,216,${p.a})`;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function step(): void {
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const tx = focus.active ? focus.x : mouse.active ? mouse.x : -1;
      const ty = focus.active ? focus.y : mouse.active ? mouse.y : -1;
      const pullActive = tx >= 0;

      for (const p of particles) {
        // Gentle drift.
        p.x += p.vx;
        p.y += p.vy;

        if (pullActive) {
          const dx = tx - p.x;
          const dy = ty - p.y;
          const d2 = dx * dx + dy * dy;
          const d = Math.sqrt(d2) || 1;
          // Soft attraction that falls off with distance; stronger for the focus point.
          const strength = (focus.active ? 900 : 500) / (d2 + 6000);
          p.vx += (dx / d) * strength * 0.02;
          p.vy += (dy / d) * strength * 0.02;
        }
        // Damping keeps it calm.
        p.vx *= 0.96;
        p.vy *= 0.96;
        // Re-inject a whisper of drift so it never fully stalls.
        p.vx += (Math.random() - 0.5) * 0.01;
        p.vy += (Math.random() - 0.5) * 0.01;

        // Wrap around the edges.
        if (p.x < -4) p.x = cssW + 4;
        if (p.x > cssW + 4) p.x = -4;
        if (p.y < -4) p.y = cssH + 4;
        if (p.y > cssH + 4) p.y = -4;

        const glow = pullActive ? Math.min(0.5, p.a + 220 / ((tx - p.x) ** 2 + (ty - p.y) ** 2 + 400)) : p.a;
        ctx.beginPath();
        ctx.fillStyle = `rgba(206,211,221,${glow})`;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    let raf = 0;
    let running = false;
    const loop = (): void => {
      step();
      raf = requestAnimationFrame(loop);
    };
    const start = (): void => {
      if (running || reduce) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const stop = (): void => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const onMove = (e: MouseEvent): void => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      mouse.active = true;
    };
    const onLeave = (): void => {
      mouse.active = false;
    };

    const ro = new ResizeObserver(() => {
      resize();
      if (reduce) drawStatic();
    });
    ro.observe(canvas);
    resize();

    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.some((e) => e.isIntersecting);
        if (vis) start();
        else stop();
      },
      { threshold: 0 },
    );
    io.observe(canvas);

    const onVis = (): void => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVis);
    // Listen on the parent section so the field reacts across the whole area.
    const host = canvas.parentElement ?? canvas;
    host.addEventListener('mousemove', onMove as EventListener);
    host.addEventListener('mouseleave', onLeave);

    if (reduce) drawStatic();
    else start();

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      host.removeEventListener('mousemove', onMove as EventListener);
      host.removeEventListener('mouseleave', onLeave);
      if (focusRef) focusRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
