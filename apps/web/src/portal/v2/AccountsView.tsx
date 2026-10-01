/**
 * V2AccountsView — the Accounts experience, RE-COMPOSED at human-review #3.
 *
 * Rejected twice as "AI dashboard UI". This is not a restyle of the card index — it is a
 * different composition: a dense, brokerage-style ACCOUNT LEDGER (one row per account,
 * tabular, right-aligned money, a thin state dot) as the hero, with a flat
 * FINANCIAL-STATEMENT workspace for the selected account below it (typography + hairline
 * rules + columns, not nested cards). State navigation is a sharp line/text nav, not pills.
 *
 * PRESENTATIONAL and pure: it takes a discriminated load state and renders it; it never
 * fetches and never decides business truth (the adapter maps authoritative state).
 */
import { useMemo, useState, type JSX } from 'react';
import type { AccountsView, AccountSummary } from '../lib';
import { V2AccountPanel, type V2AccountView } from './AccountPanel';
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

const ACTIVE_STATES = ['PENDING', 'EVALUATION_ACTIVE', 'EVALUATION_PASSED', 'FUNDED_ACTIVE'];
const metricOf = (v: V2AccountView, label: string): { value: string; tone?: string } | undefined => v.metrics.find((m) => m.label === label);

export function V2AccountsView({ state, actions = {}, extraFor }: {
  state: V2AccountsState;
  actions?: AccountsActions;
  extraFor?: (a: AccountSummary) => AccountViewExtra | undefined;
}): JSX.Element {
  if (state.status === 'loading') {
    return (
      <div className="htv2-page">
        <AccountsHead />
        <div className="htv2-acctmgr2" aria-busy="true" data-testid="htv2-accounts-loading">
          <div className="htv2-ledger-skel" /><div className="htv2-ledger-skel" /><div className="htv2-ledger-skel" />
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

function AccountsHead({ accounts, actions }: { accounts?: AccountSummary[]; actions?: AccountsActions }): JSX.Element {
  const active = accounts ? accounts.filter((a) => ACTIVE_STATES.includes(a.portalState)).length : null;
  const historical = accounts ? accounts.length - (active ?? 0) : null;
  return (
    <header className="htv2-page-head htv2-page-head-row">
      <div>
        <h1 className="ht-t-page-title">Accounts</h1>
        <p className="ht-t-meta">
          {active != null ? `${active} active · ${historical} historical` : 'Your evaluation and funded accounts.'}
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
      <AccountsHead accounts={accounts} actions={actions} />

      <nav className="htv2-statenav" role="tablist" aria-label="Filter accounts">
        {FILTERS.filter((f) => f.key === 'all' || counts[f.key] > 0).map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={filter === f.key}
            className={`htv2-statenav-tab ht-t-nav${filter === f.key ? ' on' : ''}`}
            onClick={() => setFilter(f.key)}
            data-testid={`htv2-accounts-filter-${f.key}`}
          >
            {f.label}<span className="htv2-statenav-n ht-num">{counts[f.key]}</span>
          </button>
        ))}
      </nav>

      {degraded && <div className="htv2-accounts-degraded" role="status" data-testid="htv2-accounts-degraded">{degraded}</div>}

      {/* Account ledger — the brokerage account manager overview. */}
      <div className="htv2-acctledger-wrap">
        <table className="htv2-acctledger" data-testid="htv2-accounts-ledger">
          <thead>
            <tr>
              <th>Account</th><th>Program</th><th>State</th>
              <th className="num">Balance</th><th className="num">Net P&amp;L</th><th className="num">MLL room</th>
              <th className="prog">Progress</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a) => {
              const v = toAccountView(a, extraFor?.(a));
              const net = metricOf(v, 'Net P&L');
              const mll = metricOf(v, 'MLL room');
              const on = selected.id === a.id;
              return (
                <tr
                  key={a.id}
                  className={on ? 'on' : ''}
                  aria-selected={on}
                  tabIndex={0}
                  data-testid="htv2-accounts-row"
                  onClick={() => setSelectedId(a.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(a.id); } }}
                >
                  <td className="ht-num htv2-acctledger-id">{v.maskedId}</td>
                  <td>{v.productLabel}</td>
                  <td><V2Status kind={v.statusKind}>{v.statusLabel}</V2Status></td>
                  <td className="num ht-num">{v.balanceText}</td>
                  <td className={`num ht-num htv2-tone-${net?.tone ?? 'default'}`}>{net?.value ?? '—'}</td>
                  <td className="num ht-num">{mll?.value ?? '—'}</td>
                  <td className="prog">
                    {v.progressPct != null ? (
                      <span className="htv2-acctledger-prog">
                        <span className="htv2-acctledger-bar"><span style={{ width: `${Math.max(0, Math.min(100, v.progressPct))}%` }} /></span>
                        <span className="ht-num">{Math.round(v.progressPct)}%</span>
                      </span>
                    ) : <span className="htv2-tone-muted">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <AccountWorkspace
        a={selected}
        extra={extraFor?.(selected)}
        onOpen={actions.onOpen ? () => actions.onOpen!(selected) : undefined}
        onTrade={actions.onTrade ? () => actions.onTrade!(selected) : undefined}
      />
    </div>
  );
}

/** The selected-account workspace: a flat financial statement, not a stack of cards. */
function AccountWorkspace({ a, extra, onOpen, onTrade }: {
  a: AccountSummary;
  extra?: AccountViewExtra;
  onOpen?: () => void;
  onTrade?: () => void;
}): JSX.Element {
  const v = toAccountView(a, extra);
  const net = metricOf(v, 'Net P&L');
  return (
    <section className="htv2-acctws" data-testid="htv2-account-workspace">
      <header className="htv2-acctws-head">
        <div className="htv2-acctws-id">
          <span className="htv2-acctws-product ht-t-section">{v.productLabel}</span>
          <span className="htv2-acctws-sub ht-t-meta ht-num">{v.accountKind} · {v.maskedId}</span>
        </div>
        <V2Status kind={v.statusKind}>{v.statusLabel}</V2Status>
      </header>

      <div className="htv2-acctws-figures">
        <div className="htv2-acctws-fig">
          <span className="htv2-acctws-fig-v ht-t-display ht-num">{v.balanceText}</span>
          <span className="ht-t-label">Balance</span>
        </div>
        {net && (
          <div className="htv2-acctws-fig">
            <span className={`htv2-acctws-fig-v ht-t-fin-lg ht-num htv2-tone-${net.tone ?? 'default'}`}>{net.value}</span>
            <span className="ht-t-label">Net P&amp;L</span>
          </div>
        )}
      </div>

      {v.progressPct != null && (
        <div className="htv2-acctws-progress">
          <div className="htv2-acctws-progress-head">
            <span className="ht-t-label">{v.progressLabel}</span>
            <span className="ht-t-meta ht-num">{v.progressDetail}</span>
          </div>
          <div className="htv2-acct-bar" role="progressbar" aria-valuenow={Math.round(v.progressPct)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${Math.max(0, Math.min(100, v.progressPct))}%` }} />
          </div>
        </div>
      )}

      {/* Financial detail as a labelled statement grid (hairline-separated), not cards. */}
      <dl className="htv2-acctws-statement">
        {v.metrics.map((m) => (
          <div className="htv2-acctws-line" key={m.label}>
            <dt className="ht-t-label">{m.label}</dt>
            <dd className={`ht-t-fin-sm ht-num htv2-tone-${m.tone ?? 'default'}`}>{m.value}</dd>
          </div>
        ))}
      </dl>

      <div className="htv2-acctws-life">
        <span className="ht-t-label htv2-acctws-life-label">Lifecycle</span>
        <V2Lifecycle portalState={v.portalState} />
      </div>

      <footer className="htv2-acctws-actions">
        <button className="htv2-link ht-t-nav" onClick={onOpen} data-testid="htv2-open-full-account">Open full account →</button>
        {v.tradable && <V2Button variant="primary" size="sm" onClick={onTrade}>Trade ↗</V2Button>}
      </footer>
    </section>
  );
}

// Re-export the panel for the dashboard's "Your accounts" grid (unchanged use there).
export { V2AccountPanel };
