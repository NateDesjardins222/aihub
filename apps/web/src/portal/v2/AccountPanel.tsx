/**
 * V2AccountPanel — the account centrepiece (Product Rebuild Phase 0, STEP 15/16).
 *
 * Takes a PROJECTED view model (`V2AccountView`), never the raw API shape, so the
 * visual component and the server contract can evolve independently and money
 * stays server-authoritative (the projection is built from AccountSummary during
 * the real migration; here the harness supplies representative dev values).
 *
 * Hierarchy: product + masked id + status → balance (hero) → net P&L / MLL room →
 * progress → lifecycle → View details / Trade. Presentation only.
 */
import type { JSX } from 'react';
import { V2Status, V2Button, V2FinancialValue, type StatusKind } from './primitives';
import { V2Lifecycle } from './Lifecycle';
import './AccountPanel.css';

export interface V2AccountView {
  productLabel: string;      // e.g. "CORE 100K"
  maskedId: string;          // e.g. "•••• 1005"
  statusKind: StatusKind;
  statusLabel: string;       // e.g. "Evaluation"
  portalState: string;       // authoritative state → lifecycle
  balanceText: string;       // pre-formatted, e.g. "$100,000"
  netPnlText: string;        // e.g. "+$0"
  netPnlTone: 'default' | 'positive' | 'negative' | 'muted';
  mllRoomText: string;       // e.g. "$4,000"
  progressLabel?: string;    // e.g. "Profit target" / "Winning days"
  progressPct?: number;      // 0..100 (clamped); omit to hide the bar
  progressDetail?: string;   // e.g. "$3,200 / $6,000"
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
          <div className="htv2-acct-masked ht-t-meta ht-num">Account {a.maskedId}</div>
        </div>
        <V2Status kind={a.statusKind}>{a.statusLabel}</V2Status>
      </header>

      <div className="htv2-acct-balance">
        <div className="htv2-acct-balance-value ht-t-display ht-num">{a.balanceText}</div>
        <div className="htv2-acct-balance-label ht-t-label">Balance</div>
      </div>

      <div className="htv2-acct-metrics">
        <div className="htv2-acct-metric">
          <span className="ht-t-label">Net P&amp;L</span>
          <V2FinancialValue tone={a.netPnlTone} size="sm">{a.netPnlText}</V2FinancialValue>
        </div>
        <div className="htv2-acct-metric htv2-acct-metric-right">
          <span className="ht-t-label">MLL room</span>
          <V2FinancialValue size="sm">{a.mllRoomText}</V2FinancialValue>
        </div>
      </div>

      {pct != null && (
        <div className="htv2-acct-progress">
          <div className="htv2-acct-progress-head">
            {a.progressLabel != null && <span className="ht-t-meta">{a.progressLabel}</span>}
            {a.progressDetail != null && <span className="ht-t-meta ht-num">{a.progressDetail}</span>}
          </div>
          <div className="htv2-acct-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <V2Lifecycle portalState={a.portalState} />

      <footer className="htv2-acct-actions">
        <V2Button variant="tertiary" size="sm" onClick={onDetails}>View details</V2Button>
        {a.tradable && <V2Button variant="primary" size="sm" onClick={onTrade}>Trade →</V2Button>}
      </footer>
    </article>
  );
}
