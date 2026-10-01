/**
 * HAPPY TRADER — Portal V2 EXPERIENCE primitives (Phase 2).
 *
 * Reusable, systemic experience components for the canonical /portal. Presentation
 * only — they take already-authoritative values and never fabricate. All motion
 * respects prefers-reduced-motion. Scoped under `.htv2`; styled by experience.css.
 */
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import './experience.css';

/** True when the user asked for reduced motion (SSR-safe). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = (): void => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/**
 * The single living background layer. Rendered ONCE behind the shell workspace. It is
 * decorative (aria-hidden) and never intercepts pointer events. Subtle rose-gold +
 * champagne radials, a faint grid and an abstract upward arc; it drifts slowly where
 * motion is allowed, and is static under reduced motion.
 */
export function V2Background(): JSX.Element {
  return (
    <div className="htv2-bg" aria-hidden="true" data-testid="htv2-bg">
      <div className="htv2-bg-grid" />
      <div className="htv2-bg-arc" />
    </div>
  );
}

/**
 * V2NumberFlow — animates a numeric value toward its authoritative target, formatting
 * each frame with `format`. The FINAL rendered text always equals `format(value)`
 * exactly (no rounding drift, no misrepresentation). Only animates when the value
 * actually changes and motion is allowed; otherwise it renders the exact value.
 */
export function V2NumberFlow({ value, format, durationMs = 650, className = '' }: {
  value: number; format: (n: number) => string; durationMs?: number; className?: string;
}): JSX.Element {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef<number | null>(null);
  const prevValue = useRef(value);

  useEffect(() => {
    if (value === prevValue.current) return;
    if (reduced || typeof window === 'undefined' || typeof requestAnimationFrame === 'undefined') {
      setShown(value); prevValue.current = value; return;
    }
    const from = fromRef.current;
    const start = performance.now();
    prevValue.current = value;
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = from + (value - from) * eased;
      if (t >= 1) { setShown(value); fromRef.current = value; rafRef.current = null; }
      else { setShown(v); rafRef.current = requestAnimationFrame(tick); }
    };
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [value, durationMs, reduced]);

  // Final/at-rest frames show the exact authoritative value.
  const text = shown === value ? format(value) : format(shown);
  return <span className={`htv2-num-flow ${className}`} data-testid="htv2-num-flow" data-final={format(value)}>{text}</span>;
}

/**
 * V2ProgressRing — a circular progress indicator for tracked goals / club progress.
 * `pct` is 0..1 (authoritative). `done` turns it green. Center renders `children`.
 */
export function V2ProgressRing({ pct, size = 56, stroke = 5, done = false, children, ariaLabel }: {
  pct: number; size?: number; stroke?: number; done?: boolean; children?: ReactNode; ariaLabel?: string;
}): JSX.Element {
  const clamped = Math.max(0, Math.min(1, pct));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped);
  return (
    <span className="htv2-ring" style={{ width: size, height: size }} role="img"
      aria-label={ariaLabel ?? `${Math.round(clamped * 100)}% complete`} data-testid="htv2-ring">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle className="htv2-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        <circle className={`htv2-ring-fill${done ? ' is-done' : ''}`} cx={size / 2} cy={size / 2} r={r}
          strokeWidth={stroke} strokeDasharray={c} strokeDashoffset={done ? 0 : offset} />
      </svg>
      {children != null && <span className="htv2-ring-label">{children}</span>}
    </span>
  );
}

/**
 * V2InteractiveCard — premium interactive surface with a cursor-follow rose sheen and
 * a subtle lift. Compose with `.htv2-card`. Keeps data readable; no dramatic tilt.
 */
export function V2InteractiveCard({ children, className = '', onClick, testId, as = 'div' }: {
  children: ReactNode; className?: string; onClick?: () => void; testId?: string; as?: 'div' | 'button';
}): JSX.Element {
  const ref = useRef<HTMLDivElement | HTMLButtonElement>(null);
  const onMove = (e: React.MouseEvent): void => {
    const el = ref.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${((e.clientX - rect.left) / rect.width) * 100}%`);
    el.style.setProperty('--my', `${((e.clientY - rect.top) / rect.height) * 100}%`);
  };
  const cls = `htv2-card htv2-icard ${className}`;
  const inner = <><span className="htv2-icard-sheen" aria-hidden />{children}</>;
  if (as === 'button') {
    return <button ref={ref as React.RefObject<HTMLButtonElement>} type="button" className={cls} onMouseMove={onMove} onClick={onClick} data-testid={testId}>{inner}</button>;
  }
  return <div ref={ref as React.RefObject<HTMLDivElement>} className={cls} onMouseMove={onMove} onClick={onClick} data-testid={testId}>{inner}</div>;
}

/** Skeleton primitives — layout-matching, never fake numbers. */
export function V2Skeleton({ variant = 'line', className = '' }: { variant?: 'line' | 'line-sm' | 'line-lg' | 'block'; className?: string }): JSX.Element {
  const map = { line: 'htv2-skel-line', 'line-sm': 'htv2-skel-line sm', 'line-lg': 'htv2-skel-line lg', block: 'htv2-skel-block' } as const;
  return <div className={`htv2-skel ${map[variant]} ${className}`} aria-hidden data-testid="htv2-skel" />;
}

/** A page-shaped skeleton: a title + a few rows. Used by containers while loading. */
export function V2PageSkeleton({ title, rows = 3 }: { title: string; rows?: number }): JSX.Element {
  return (
    <div className="htv2-page" data-testid="htv2-page-skeleton" aria-busy="true">
      <header className="htv2-page-head"><h1 className="ht-t-page-title">{title}</h1><p className="ht-t-meta">Loading your authoritative records…</p></header>
      <div className="htv2-card" style={{ padding: 'var(--ht-space-5)' }}>
        <V2Skeleton variant="line-lg" />
        {Array.from({ length: rows }).map((_, i) => (
          <div className="htv2-skel-row" key={i}>
            <V2Skeleton variant="line" />
            <V2Skeleton variant="line-sm" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Journey (§40–42) -------------------------------------------------------

export type JourneyState = 'past' | 'now' | 'future';
export interface JourneyNode {
  id: string;
  state: JourneyState;
  when?: string;
  label: string;
  detail?: string;
  onSelect?: () => void;
}

/** The visual journey rail: past → now → ahead. Horizontal on desktop, vertical on
 *  mobile (CSS). Nodes with `onSelect` become interactive. */
export function V2Journey({ nodes }: { nodes: JourneyNode[] }): JSX.Element {
  return (
    <div className="htv2-journey" data-testid="htv2-journey">
      <ol className="htv2-journey-track">
        {nodes.map((n) => {
          const body = (
            <span className="htv2-jnode-body">
              {n.when != null && <span className="htv2-jnode-when ht-t-meta ht-num">{n.when}</span>}
              <span className="htv2-jnode-label ht-t-body-sm">{n.label}</span>
              {n.detail != null && <span className="htv2-jnode-detail ht-t-meta ht-num">{n.detail}</span>}
            </span>
          );
          return (
            <li key={n.id} className={`htv2-jnode is-${n.state}`} data-testid="htv2-jnode" data-state={n.state}>
              <span className="htv2-jdot" aria-hidden />
              {n.onSelect
                ? <button type="button" className="htv2-jnode-interactive" onClick={n.onSelect}>{body}</button>
                : body}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
