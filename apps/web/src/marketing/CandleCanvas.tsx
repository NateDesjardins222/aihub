/*
 * Canvas renderer for the synthetic candle motion.
 *
 * The engine owns the market state (pure function of wall-clock time); this
 * component only draws it. It never drives React state per frame. The rAF loop
 * pauses when the tab is hidden or the canvas is scrolled offscreen, and resumes
 * cleanly because the frame is recomputed from `now`. Under prefers-reduced-motion
 * it paints a single static frame and stops.
 *
 * Occlusion: each candle is drawn opaque — wick first, then the body rectangle
 * painted over it — so a body always covers its own wick. The strip as a whole is
 * subdued through the element's CSS opacity, not per-shape alpha.
 */
import { useEffect, useRef, type JSX } from 'react';
import { CandleEngine, type EngineConfig, type Frame } from './candleEngine';

interface Palette {
  up: string;
  down: string;
  upWick: string;
  downWick: string;
}

const MONO: Palette = { up: '#d6dae2', down: '#7b8290', upWick: '#aab0bc', downWick: '#5c626f' };

export interface CandleCanvasProps {
  readonly className?: string;
  readonly engineConfig?: EngineConfig;
  readonly palette?: Partial<Palette>;
  /** Fraction of a slot used by the candle body (0..1). */
  readonly bodyRatio?: number;
  /** Draw a faint horizontal grid + last-price line (used by the Atlas visual). */
  readonly grid?: boolean;
  /** Accessible label for the decorative canvas. */
  readonly ariaLabel?: string;
}

export function CandleCanvas({
  className,
  engineConfig,
  palette,
  bodyRatio = 0.62,
  grid = false,
  ariaLabel = 'Decorative animated candlestick chart',
}: CandleCanvasProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const engine = new CandleEngine(engineConfig);
    const pal: Palette = { ...MONO, ...palette };
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let cssW = 0;
    let cssH = 0;
    let dpr = 1;
    // Smoothed price scale, so the chart does not "breathe" as candles enter/exit.
    let sMin = Number.NaN;
    let sMax = Number.NaN;

    function resize(): void {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      cssW = Math.max(1, Math.round(rect.width));
      cssH = Math.max(1, Math.round(rect.height));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }

    function draw(now: number): void {
      if (!ctx) return;
      const frame: Frame = engine.frame(now);
      const slots = engine.visible + 1;
      const slotW = cssW / slots;
      const candleW = Math.max(2, slotW * bodyRatio);
      const progress = frame.progress;

      // Target price range across everything on screen (+ partial), padded.
      let lo = Infinity;
      let hi = -Infinity;
      for (const c of frame.candles) {
        if (c.low < lo) lo = c.low;
        if (c.high > hi) hi = c.high;
      }
      if (frame.partial.low < lo) lo = frame.partial.low;
      if (frame.partial.high > hi) hi = frame.partial.high;
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
        hi = lo + 1;
      }
      const padP = (hi - lo) * 0.14;
      const tMin = lo - padP;
      const tMax = hi + padP;
      // Smooth toward the target range.
      if (Number.isNaN(sMin)) {
        sMin = tMin;
        sMax = tMax;
      } else {
        const a = reduce ? 1 : 0.12;
        sMin += (tMin - sMin) * a;
        sMax += (tMax - sMax) * a;
      }

      const padY = 12;
      const h = cssH - padY * 2;
      const yOf = (p: number): number => padY + ((sMax - p) / (sMax - sMin)) * h;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      if (grid) {
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        for (let g = 0; g <= 4; g += 1) {
          const y = Math.round(padY + (h / 4) * g) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(cssW, y);
          ctx.stroke();
        }
      }

      const drawCandle = (
        cx: number,
        o: number,
        hg: number,
        lw: number,
        cl: number,
      ): void => {
        const up = cl >= o;
        const bodyTop = yOf(Math.max(o, cl));
        const bodyBot = yOf(Math.min(o, cl));
        const bodyH = Math.max(1.5, bodyBot - bodyTop);
        const left = Math.round(cx - candleW / 2);
        const w = Math.round(candleW);
        // Wick first (behind), then the body opaque over it → occlusion.
        ctx.fillStyle = up ? pal.upWick : pal.downWick;
        const wickX = Math.round(cx);
        ctx.fillRect(wickX, Math.round(yOf(hg)), 1.5, Math.max(1, yOf(lw) - yOf(hg)));
        ctx.fillStyle = up ? pal.up : pal.down;
        ctx.fillRect(left, Math.round(bodyTop), w, Math.round(bodyH));
      };

      // Completed candles glide left as the active candle forms.
      frame.candles.forEach((c, k) => {
        const cx = (k + 0.5 - progress) * slotW;
        if (cx < -candleW || cx > cssW + candleW) return;
        drawCandle(cx, c.open, c.high, c.low, c.close);
      });
      // Active (forming) candle.
      const px = (frame.candles.length + 0.5 - progress) * slotW;
      drawCandle(px, frame.partial.open, frame.partial.high, frame.partial.low, frame.partial.price);

      if (grid) {
        const y = Math.round(yOf(frame.partial.price)) + 0.5;
        ctx.strokeStyle = 'rgba(214,218,226,0.35)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(cssW, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    let raf = 0;
    let running = false;
    const tick = (): void => {
      draw(performance.timeOrigin + performance.now());
      raf = requestAnimationFrame(tick);
    };
    const start = (): void => {
      if (running || reduce) return;
      running = true;
      raf = requestAnimationFrame(tick);
    };
    const stop = (): void => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const ro = new ResizeObserver(() => {
      resize();
      // Redraw immediately so a resize while paused still looks right.
      draw(performance.timeOrigin + performance.now());
    });
    ro.observe(canvas);
    resize();

    // Only animate while on screen.
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible) start();
        else stop();
      },
      { threshold: 0 },
    );
    io.observe(canvas);

    const onVisibility = (): void => {
      if (document.hidden) stop();
      else {
        // Recompute from wall-clock and resume — no flat catch-up candles.
        draw(performance.timeOrigin + performance.now());
        start();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // First paint (covers the reduced-motion case, which never starts the loop).
    draw(performance.timeOrigin + performance.now());
    if (!reduce) start();

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={ref} className={className} role="img" aria-label={ariaLabel} />;
}
