/**
 * V2AccountPanel — the account object, rebuilt at human-rejection #1.
 *
 * A professional financial account object, not a generic empty card: product +
 * masked id + one compact status → balance → a DENSE state-aware metric grid (the
 * authoritative truth a trader needs) → quiet target progress → quiet lifecycle →
 * action hierarchy (Details quiet, Trade primary). Takes a PROJECTED view model
 * (`V2AccountView`); money stays server-authoritative.
 */
import type { JSX } from 'react';
import { V2Status, V2Button, type StatusKind } from './primitives';
import { V2Lifecycle } from './Lifecycle';
import './AccountPanel.css';

export interface V2Metric {
  label: string;
  value: string;
  tone?: 'default' | 'positive' | 'negative' | 'muted';
}

export interface V2AccountView {
  productLabel: string;      // e.g. "CORE 100K"
  maskedId: string;          // e.g. "•••• 1005"
  accountKind: string;       // "Evaluation" | "Funded"
  statusKind: StatusKind;
  statusLabel: string;       // e.g. "Evaluation"
  portalState: string;       // authoritative state → lifecycle
  balanceText: string;       // pre-formatted, e.g. "$103,200"
  metrics: V2Metric[];       // dense, state-aware, authoritative
  progressLabel?: string;    // e.g. "Profit target"
  progressPct?: number;      // 0..100 (clamped); omit to hide the bar
  progressDetail?: string;   // e.g. "$3,200 of $6,000"
  tradable: boolean;
}

export function V2AccountPanel({ a, onDetails, onTrade }: {
  a: V2AccountView;
  onDetails?: () => void;
  onTrade?: () => void;
}): JSX.Element {
  const pct = a.progressPct == null ? null : Math.max(0, Math.min(100, a.progressPct));
  return (
    <article className="htv2-acct" data-testid="htv2-account-panel">
      <header className="htv2-acct-head">
        <div className="htv2-acct-id">
          <div className="htv2-acct-product ht-t-section">{a.productLabel}</div>
          <div className="htv2-acct-sub ht-t-meta ht-num">{a.accountKind} · {a.maskedId}</div>
        </div>
        <V2Status kind={a.statusKind}>{a.statusLabel}</V2Status>
      </header>

      <div className="htv2-acct-balance">
        <span className="htv2-acct-balance-value ht-t-fin-lg ht-num">{a.balanceText}</span>
        <span className="htv2-acct-balance-label ht-t-label">Balance</span>
      </div>

      {pct != null && (
        <div className="htv2-acct-progress">
          <div className="htv2-acct-progress-head">
            {a.progressLabel != null && <span className="ht-t-label">{a.progressLabel}</span>}
            {a.progressDetail != null && <span className="ht-t-meta ht-num">{a.progressDetail}</span>}
          </div>
          <div className="htv2-acct-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <dl className="htv2-acct-metrics">
        {a.metrics.map((metric) => (
          <div className="htv2-acct-metric" key={metric.label}>
            <dt className="ht-t-label">{metric.label}</dt>
            <dd className={`htv2-acct-metric-v ht-t-fin-sm ht-num htv2-tone-${metric.tone ?? 'default'}`}>{metric.value}</dd>
          </div>
        ))}
      </dl>

      <V2Lifecycle portalState={a.portalState} />

      <footer className="htv2-acct-actions">
        <V2Button variant="tertiary" size="sm" onClick={onDetails}>Details →</V2Button>
        {a.tradable && <V2Button variant="primary" size="sm" onClick={onTrade}>Trade ↗</V2Button>}
      </footer>
    </article>
  );
}
