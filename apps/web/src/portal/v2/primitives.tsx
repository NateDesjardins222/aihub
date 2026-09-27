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
