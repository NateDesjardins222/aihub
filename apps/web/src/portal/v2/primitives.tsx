/**
 * HAPPY TRADER — Portal V2 primitive components (Product Rebuild Phase 0, STEP 13).
 *
 * Isolated foundation. These render ONLY inside a `.htv2` root and use `--ht-*`
 * tokens; they do not touch the live V1 Portal. Presentation contracts for the
 * reference-driven rebuild — deliberately small, no abstraction for its own sake.
 * No data fetching here: components take already-projected values.
 */
import type { JSX, ReactNode } from 'react';
import './primitives.css';

/** Root wrapper that scopes the V2 token/type layer. Everything V2 lives inside one. */
export function V2Root({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={`htv2 ${className}`}>{children}</div>;
}

/** Champagne/metallic emphasis for a short brand/hero string. Solid-colour fallback. */
export function V2Metal({ children, as: As = 'span', className = '' }: { children: ReactNode; as?: 'span' | 'h1' | 'h2'; className?: string }): JSX.Element {
  return <As className={`htv2-metal ${className}`}>{children}</As>;
}

export function V2Button({
  children, variant = 'secondary', size = 'md', disabled, onClick, type = 'button', testId,
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'tertiary' | 'danger';
  size?: 'md' | 'sm';
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  testId?: string;
}): JSX.Element {
  return (
    <button
      type={type}
      data-testid={testId}
      className={`htv2-btn htv2-btn-${variant} htv2-btn-${size} ht-t-button`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export type StatusKind = 'evaluation' | 'funded' | 'payout' | 'completed' | 'failed' | 'hold' | 'neutral';

/** A restrained dot + label, never a saturated pill (STEP 20). */
export function V2Status({ kind, children }: { kind: StatusKind; children: ReactNode }): JSX.Element {
  return (
    <span className={`htv2-status htv2-status-${kind} ht-t-status`} data-testid="htv2-status">
      <span className="htv2-status-dot" aria-hidden />
      {children}
    </span>
  );
}

/** A labelled value block: muted label over a value, with optional sub. */
export function V2Metric({ label, value, sub, tone = 'default' }: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'positive' | 'negative' | 'muted';
}): JSX.Element {
  return (
    <div className="htv2-metric">
      <div className="htv2-metric-label ht-t-label">{label}</div>
      <div className={`htv2-metric-value ht-t-fin-md ht-num htv2-tone-${tone}`}>{value}</div>
      {sub != null && <div className="htv2-metric-sub ht-t-meta">{sub}</div>}
    </div>
  );
}

/** A financial number with sign-aware tone; tabular by default. */
export function V2FinancialValue({ children, tone = 'default', size = 'md' }: {
  children: ReactNode;
  tone?: 'default' | 'positive' | 'negative' | 'muted';
  size?: 'lg' | 'md' | 'sm';
}): JSX.Element {
  return <span className={`ht-t-fin-${size} ht-num htv2-tone-${tone}`}>{children}</span>;
}

export function V2Section({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section className="htv2-section">
      {(title != null || actions != null) && (
        <header className="htv2-section-head">
          {title != null && <h2 className="htv2-section-title ht-t-section">{title}</h2>}
          {actions != null && <div className="htv2-section-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function V2Divider(): JSX.Element {
  return <hr className="htv2-divider" />;
}

export function V2EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="htv2-empty">
      <div className="htv2-empty-title ht-t-section">{title}</div>
      {hint != null && <p className="htv2-empty-hint ht-t-body-sm">{hint}</p>}
      {action}
    </div>
  );
}

export function V2Card({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={`htv2-card ${className}`}>{children}</div>;
}

/**
 * A horizontal financial summary — label-over-value stats separated by thin
 * vertical rules, framed by a single hairline. This is the deliberate alternative
 * to the "four giant stat cards" AI-dashboard cliché: one quiet surface, high
 * density, tabular numerals. Wraps gracefully on narrow widths.
 */
export interface StatStripItem { label: string; value: ReactNode; tone?: 'default' | 'positive' | 'negative' | 'muted'; }
export function V2StatStrip({ items }: { items: StatStripItem[] }): JSX.Element {
  return (
    <div className="htv2-stat-strip" data-testid="htv2-stat-strip">
      {items.map((it, i) => (
        <div className="htv2-stat" key={i}>
          <div className="htv2-stat-label ht-t-label">{it.label}</div>
          <div className={`htv2-stat-value ht-t-fin-md ht-num htv2-tone-${it.tone ?? 'default'}`}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * A quiet attention row — shown ONLY when something authoritative needs the
 * customer's action (payout eligible, breach, hold, billing). Never decorative.
 */
export function V2Attention({ tone = 'default', title, detail, action }: {
  tone?: 'default' | 'positive' | 'warning' | 'negative';
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className={`htv2-attention htv2-attention-${tone}`} role="status" data-testid="htv2-attention">
      <span className="htv2-attention-dot" aria-hidden />
      <div className="htv2-attention-body">
        <span className="htv2-attention-title ht-t-body-sm">{title}</span>
        {detail != null && <span className="htv2-attention-detail ht-t-meta">{detail}</span>}
      </div>
      {action != null && <div className="htv2-attention-action">{action}</div>}
    </div>
  );
}

/** A compact, quiet activity feed row (time · event · optional amount). */
export interface ActivityItem { when: string; label: string; amount?: ReactNode; amountTone?: 'default' | 'positive' | 'negative' | 'muted'; }
export function V2ActivityList({ items }: { items: ActivityItem[] }): JSX.Element {
  return (
    <ul className="htv2-activity" data-testid="htv2-activity">
      {items.map((it, i) => (
        <li className="htv2-activity-row" key={i}>
          <span className="htv2-activity-when ht-t-meta ht-num">{it.when}</span>
          <span className="htv2-activity-label ht-t-body-sm">{it.label}</span>
          {it.amount != null && (
            <span className={`htv2-activity-amt ht-t-fin-sm ht-num htv2-tone-${it.amountTone ?? 'default'}`}>{it.amount}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * V2AreaChart — a dependency-free financial area/line chart (cumulative P&L, balance,
 * etc.). Pure SVG, champagne stroke + faint fill, optional zero baseline. Presentation
 * only: the caller supplies an authoritative numeric series (or an empty one → the
 * caller shows an empty state). Never fabricates data.
 */
export interface SeriesPoint { t: number; v: number }
export function V2AreaChart({ points, height = 180, ariaLabel = 'Performance chart' }: {
  points: SeriesPoint[]; height?: number; ariaLabel?: string;
}): JSX.Element | null {
  if (points.length < 2) return null;
  const W = 1000, H = height, pad = 6;
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs, 0), max = Math.max(...vs, 0);
  const range = max - min || 1;
  const x = (i: number): number => pad + (i / (points.length - 1)) * (W - pad * 2);
  const y = (v: number): number => H - pad - ((v - min) / range) * (H - pad * 2);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(H - pad).toFixed(1)} L${x(0).toFixed(1)},${(H - pad).toFixed(1)} Z`;
  const zeroY = min <= 0 && max >= 0 ? y(0) : null;
  return (
    <svg className="htv2-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel} data-testid="htv2-area-chart">
      {zeroY != null && <path className="htv2-area-zero" d={`M0,${zeroY.toFixed(1)} L${W},${zeroY.toFixed(1)}`} />}
      <path className="htv2-area-fill" d={area} />
      <path className="htv2-area-line" d={line} />
    </svg>
  );
}
