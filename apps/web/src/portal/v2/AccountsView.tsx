/**
 * V2AccountsView — the Accounts experience, REMODELLED at human-review #2 into a
 * professional master/detail account manager (the repeated giant-card wall was
 * rejected).
 *
 *   [ filters ]                       [ Add account ]
 *   ┌───────────────┬──────────────────────────────┐
 *   │ account index │  selected account workspace   │
 *   │  (compact     │  header · balance · dense      │
 *   │   rows)       │  metrics · lifecycle · actions │
 *   └───────────────┴──────────────────────────────┘
 *
 * PRESENTATIONAL and pure: it takes a discriminated load state and renders it; it
 * never fetches and never decides business truth (the adapter maps authoritative
 * state). Loading / empty / error / partial-failure states are all explicit. The
 * zero-account state shows a real empty state that guides to Add account — never
 * demo records.
 */
import { useMemo, useState, type JSX } from 'react';
import type { AccountsView, AccountSummary } from '../lib';
import { V2AccountPanel } from './AccountPanel';
import { toAccountView, type AccountViewExtra } from './account-view';
import { V2Button, V2EmptyState, V2Status } from './primitives';
import { V2Lifecycle } from './Lifecycle';
import './AccountsView.css';

export type V2AccountsState =
  | { status: 'loading' }
  | { status: 'error'; message: string; onRetry?: () => void }
  | { status: 'ready'; view: AccountsView; degraded?: string | null };

export interface AccountsActions {
  onOpen?: (a: AccountSummary) => void;   // open full account detail (route)
  onTrade?: (a: AccountSummary) => void;
  onGetAccount?: () => void;              // Add account → purchase flow
}

type Filter = 'all' | 'evaluation' | 'funded' | 'completed' | 'closed';
const FILTERS: Array<{ key: Filter; label: string; match: (a: AccountSummary) => boolean }> = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'evaluation', label: 'Evaluation', match: (a) => a.portalState.startsWith('EVALUATION') },
  { key: 'funded', label: 'Funded', match: (a) => a.accountType === 'FUNDED_SIM' && a.portalState === 'FUNDED_ACTIVE' },
  { key: 'completed', label: 'Completed', match: (a) => a.portalState === 'COMPLETED_MAX_PAYOUTS' },
  { key: 'closed', label: 'Closed', match: (a) => ['FAILED', 'INACTIVE_CLOSED', 'ARCHIVED'].includes(a.portalState) },
];

export function V2AccountsView({ state, actions = {}, extraFor }: {
  state: V2AccountsState;
  actions?: AccountsActions;
  extraFor?: (a: AccountSummary) => AccountViewExtra | undefined;
}): JSX.Element {
  if (state.status === 'loading') {
    return (
      <div className="htv2-page">
        <AccountsHead />
        <div className="htv2-acctmgr" aria-busy="true" data-testid="htv2-accounts-loading">
          <div className="htv2-acctmgr-index"><span className="htv2-idx-skel" /><span className="htv2-idx-skel" /><span className="htv2-idx-skel" /></div>
          <div className="htv2-acctmgr-detail htv2-acctmgr-skel" />
        </div>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="htv2-page">
        <AccountsHead />
        <div className="htv2-accounts-error" role="alert" data-testid="htv2-accounts-error">
          <div className="ht-t-section">We couldn’t load your accounts</div>
          <p className="ht-t-body-sm">{state.message}</p>
          {state.onRetry && <V2Button variant="secondary" size="sm" onClick={state.onRetry}>Try again</V2Button>}
        </div>
      </div>
    );
  }

  const accounts = state.view.accounts;
  if (accounts.length === 0) {
    return (
      <div className="htv2-page">
        <AccountsHead />
        <div data-testid="htv2-accounts-empty">
          <V2EmptyState
            title="No accounts yet"
            hint="Buy an evaluation to get started — your accounts, progress and payouts will appear here."
            action={<V2Button variant="primary" size="sm" onClick={actions.onGetAccount}>Add account</V2Button>}
          />
        </div>
      </div>
    );
  }

  return <AccountsManager accounts={accounts} view={state.view} degraded={state.degraded ?? null} actions={actions} extraFor={extraFor} />;
}

function AccountsHead({ view, actions }: { view?: AccountsView; actions?: AccountsActions }): JSX.Element {
  return (
    <header className="htv2-page-head htv2-page-head-row">
      <div>
        <h1 className="ht-t-page-title">Accounts</h1>
        <p className="ht-t-meta">
          {view ? `${view.activeSlotsUsed} of ${view.maxActiveSlots} active account slots in use` : 'Your evaluation and funded accounts.'}
        </p>
      </div>
      {actions?.onGetAccount && <V2Button variant="primary" size="sm" onClick={actions.onGetAccount}>Add account</V2Button>}
    </header>
  );
}

function AccountsManager({ accounts, view, degraded, actions, extraFor }: {
  accounts: AccountSummary[];
  view: AccountsView;
  degraded: string | null;
  actions: AccountsActions;
  extraFor?: (a: AccountSummary) => AccountViewExtra | undefined;
}): JSX.Element {
  const [filter, setFilter] = useState<Filter>('all');
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, evaluation: 0, funded: 0, completed: 0, closed: 0 };
    for (const f of FILTERS) c[f.key] = accounts.filter(f.match).length;
    return c;
  }, [accounts]);
  const visible = useMemo(() => accounts.filter(FILTERS.find((f) => f.key === filter)!.match), [accounts, filter]);
  const [selectedId, setSelectedId] = useState<string>(accounts[0]!.id);
  const selected = visible.find((a) => a.id === selectedId) ?? visible[0] ?? accounts[0]!;

  return (
    <div className="htv2-page">
      <AccountsHead view={view} actions={actions} />

      <div className="htv2-acct-filters" role="tablist" aria-label="Filter accounts">
        {FILTERS.filter((f) => f.key === 'all' || counts[f.key] > 0).map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={filter === f.key}
            className={`htv2-acct-filter ht-t-nav${filter === f.key ? ' on' : ''}`}
            onClick={() => setFilter(f.key)}
            data-testid={`htv2-accounts-filter-${f.key}`}
          >
            {f.label}<span className="htv2-acct-filter-n ht-num">{counts[f.key]}</span>
          </button>
        ))}
      </div>

      {degraded && <div className="htv2-accounts-degraded" role="status" data-testid="htv2-accounts-degraded">{degraded}</div>}

      <div className="htv2-acctmgr">
        <div className="htv2-acctmgr-index" role="listbox" aria-label="Accounts" data-testid="htv2-accounts-index">
          {visible.map((a) => {
            const v = toAccountView(a, extraFor?.(a));
            const net = v.metrics.find((m) => m.label === 'Net P&L');
            return (
              <button
                key={a.id}
                role="option"
                aria-selected={selected.id === a.id}
                className={`htv2-idx-row${selected.id === a.id ? ' on' : ''}`}
                onClick={() => setSelectedId(a.id)}
              >
                <span className="htv2-idx-top">
                  <span className="htv2-idx-product ht-t-fin-sm">{v.productLabel}</span>
                  <V2Status kind={v.statusKind}>{v.statusLabel}</V2Status>
                </span>
                <span className="htv2-idx-mid">
                  <span className="htv2-idx-bal ht-t-fin-sm ht-num">{v.balanceText}</span>
                  {net && <span className={`htv2-idx-net ht-num htv2-tone-${net.tone ?? 'default'}`}>{net.value}</span>}
                </span>
                <span className="htv2-idx-sub ht-t-meta ht-num">{v.accountKind} · {v.maskedId}</span>
                {v.progressPct != null && (
                  <span className="htv2-idx-bar"><span style={{ width: `${Math.max(0, Math.min(100, v.progressPct))}%` }} /></span>
                )}
              </button>
            );
          })}
        </div>

        <div className="htv2-acctmgr-detail" data-testid="htv2-accounts-detail">
          <AccountWorkspace
            a={selected}
            extra={extraFor?.(selected)}
            onOpen={actions.onOpen ? () => actions.onOpen!(selected) : undefined}
            onTrade={actions.onTrade ? () => actions.onTrade!(selected) : undefined}
          />
        </div>
      </div>
    </div>
  );
}

/** The selected-account workspace: a professional summary (not a repeated card). */
function AccountWorkspace({ a, extra, onOpen, onTrade }: {
  a: AccountSummary;
  extra?: AccountViewExtra;
  onOpen?: () => void;
  onTrade?: () => void;
}): JSX.Element {
  const v = toAccountView(a, extra);
  return (
    <article className="htv2-ws" data-testid="htv2-account-workspace">
      <header className="htv2-ws-head">
        <div className="htv2-ws-id">
          <div className="htv2-ws-product ht-t-section">{v.productLabel}</div>
          <div className="htv2-ws-sub ht-t-meta ht-num">{v.accountKind} · {v.maskedId}</div>
        </div>
        <V2Status kind={v.statusKind}>{v.statusLabel}</V2Status>
      </header>

      <div className="htv2-ws-balance">
        <span className="htv2-ws-balance-value ht-t-display ht-num">{v.balanceText}</span>
        <span className="ht-t-label">Balance</span>
      </div>

      {v.progressPct != null && (
        <div className="htv2-ws-progress">
          <div className="htv2-ws-progress-head">
            <span className="ht-t-label">{v.progressLabel}</span>
            <span className="ht-t-meta ht-num">{v.progressDetail}</span>
          </div>
          <div className="htv2-acct-bar" role="progressbar" aria-valuenow={Math.round(v.progressPct)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${Math.max(0, Math.min(100, v.progressPct))}%` }} />
          </div>
        </div>
      )}

      <dl className="htv2-ws-metrics">
        {v.metrics.map((m) => (
          <div className="htv2-ws-metric" key={m.label}>
            <dt className="ht-t-label">{m.label}</dt>
            <dd className={`ht-t-fin-sm ht-num htv2-tone-${m.tone ?? 'default'}`}>{m.value}</dd>
          </div>
        ))}
      </dl>

      <div className="htv2-ws-life">
        <V2Lifecycle portalState={v.portalState} />
      </div>

      <footer className="htv2-ws-actions">
        <button className="htv2-link ht-t-nav" onClick={onOpen} data-testid="htv2-open-full-account">Open full account →</button>
        {v.tradable && <V2Button variant="primary" size="sm" onClick={onTrade}>Trade ↗</V2Button>}
      </footer>
    </article>
  );
}

// Re-export the panel for the dashboard's "Your accounts" grid (unchanged use there).
export { V2AccountPanel };
