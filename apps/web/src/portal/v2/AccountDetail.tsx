/**
 * V2 Account Detail — the isolated, production-capable detail surface (Product
 * Rebuild Phase 2, Parts III–X). Presentational: it takes a discriminated detail
 * load state and renders it, plus tab sub-components that read the SAME
 * authoritative endpoints V1 uses. It decides no business truth (the adapter maps
 * authoritative data; risk controls reuse the real enforcement system). Renders
 * inside a `.htv2` root supplied by the shell.
 *
 * Tabs are backed by real data or a truthful intentional state — never fabricated:
 *   Overview     detail + evaluation target progress + lifecycle + recent perf
 *   Performance  real analytics + trades (equity curve only with ≥2 closed trades)
 *   Controls     the existing personal-risk system (V2AccountControls)
 *   Rules        authoritative rule config + payout eligibility (winning days/split)
 *   Activity     lifecycle-derived business timeline (no market noise, no fabrication)
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { api } from '../../api/client';
import type { AccountDetailFull, Analytics, PayoutEligibility } from '../lib';
import { V2Lifecycle } from './Lifecycle';
import { V2Button, V2Status, V2Section, V2EmptyState } from './primitives';
import { V2AccountControls } from './AccountControls';
import { toAccountDetailView } from './account-detail-view';
import { formatMoney, formatPercent } from './format';
import './AccountDetail.css';

export const DETAIL_TABS = ['overview', 'performance', 'controls', 'rules', 'activity'] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

/** Discriminated detail load state — the container maps fetch outcomes onto this. */
export type V2DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string; onRetry?: () => void }
  | { status: 'not-found' }
  | { status: 'ready'; detail: AccountDetailFull };

export interface DetailActions {
  onBack?: () => void;
  onTrade?: (d: AccountDetailFull) => void;
}

export function V2AccountDetail({
  state, tab, onTab, actions = {},
}: {
  state: V2DetailState; tab: DetailTab; onTab: (t: DetailTab) => void; actions?: DetailActions;
}): JSX.Element {
  const back = (
    <button className="htv2-detail-back ht-t-nav" onClick={actions.onBack} data-testid="htv2-detail-back">← Accounts</button>
  );

  if (state.status === 'loading') {
    return (
      <div className="htv2" data-testid="htv2-detail-loading" aria-busy="true">
        {back}
        <div className="htv2-detail-skeleton"><span /><span /><span /><span /></div>
      </div>
    );
  }
  if (state.status === 'not-found') {
    return (
      <div className="htv2" data-testid="htv2-detail-notfound">
        {back}
        <V2EmptyState title="Account not found" hint="This account doesn’t exist, or it isn’t yours. Return to your accounts." action={<V2Button variant="secondary" size="sm" onClick={actions.onBack}>Back to accounts</V2Button>} />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="htv2" data-testid="htv2-detail-error">
        {back}
        <div className="htv2-detail-error" role="alert">
          <div className="ht-t-section">We couldn’t load this account</div>
          <p className="ht-t-body-sm">{state.message}</p>
          {state.onRetry && <V2Button variant="secondary" size="sm" onClick={state.onRetry}>Try again</V2Button>}
        </div>
      </div>
    );
  }

  const d = state.detail;
  const v = toAccountDetailView(d);

  return (
    <div className="htv2 htv2-detail" data-testid="htv2-detail">
      {back}

      {/* ---- Compact professional header ---- */}
      <header className="htv2-detail-head">
        <div className="htv2-detail-id">
          <div className="htv2-detail-product ht-t-section">{v.productLabel}</div>
          <div className="htv2-detail-masked ht-t-meta ht-num">Account {v.maskedId}{v.nickname ? ` · ${v.nickname}` : ''}</div>
        </div>
        <div className="htv2-detail-head-right">
          <V2Status kind={v.statusKind}>{v.statusLabel}</V2Status>
          {v.tradable && (
            <V2Button variant="primary" size="sm" testId="htv2-detail-trade" onClick={() => actions.onTrade?.(d)}>Trade →</V2Button>
          )}
        </div>
      </header>
      <div className="htv2-detail-headline">
        <div className="htv2-detail-balance">
          <div className="htv2-detail-balance-value ht-t-display ht-num">{v.balanceText}</div>
          <div className="ht-t-label">Balance</div>
        </div>
        <div className="htv2-detail-headmetrics">
          <HeadMetric label="Net P&L" value={v.netPnl.text} tone={v.netPnl.tone} />
          <HeadMetric label="MLL room" value={v.mllRoomText} tone={v.mllBreached ? 'negative' : 'default'} />
        </div>
      </div>

      {/* ---- Tabs ---- */}
      <div className="htv2-detail-tabs" role="tablist">
        {DETAIL_TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`htv2-detail-tab ht-t-nav${tab === t ? ' on' : ''}`}
            data-testid={`htv2-detail-tab-${t}`}
            onClick={() => onTab(t)}
          >
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="htv2-detail-body">
        {tab === 'overview' && <OverviewTab v={v} d={d} onTab={onTab} />}
        {tab === 'performance' && <PerformanceTab accountId={d.id} />}
        {tab === 'controls' && <V2AccountControls accountId={d.id} />}
        {tab === 'rules' && <RulesTab v={v} accountId={d.id} />}
        {tab === 'activity' && <ActivityTab d={d} />}
      </div>
    </div>
  );
}

function HeadMetric({ label, value, tone }: { label: string; value: string; tone: 'default' | 'positive' | 'negative' | 'muted' }): JSX.Element {
  return (
    <div className="htv2-detail-headmetric">
      <span className="ht-t-label">{label}</span>
      <span className={`ht-t-fin-md ht-num htv2-tone-${tone}`}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------- Overview ----
function OverviewTab({ v, d, onTab }: { v: ReturnType<typeof toAccountDetailView>; d: AccountDetailFull; onTab: (t: DetailTab) => void }): JSX.Element {
  return (
    <>
      {v.evaluation && (
        <V2Section title="Evaluation progress">
          <div className="htv2-progress-block" data-testid="htv2-eval-progress">
            <div className="htv2-progress-figs">
              <span className="ht-t-fin-lg ht-num">{v.evaluation.achievedText}</span>
              <span className="ht-t-body-sm htv2-progress-of"> / {v.evaluation.targetText}</span>
              <span className="ht-t-fin-md ht-num htv2-progress-pct">{v.evaluation.pct.toFixed(1)}%</span>
            </div>
            <div className="htv2-progress-bar" role="progressbar" aria-valuenow={Math.round(v.evaluation.pct)} aria-valuemin={0} aria-valuemax={100}>
              <span className="htv2-progress-fill" style={{ width: `${v.evaluation.pct}%` }} />
            </div>
            <div className="ht-t-meta">
              {v.evaluation.reached ? 'Profit target reached — the server confirms the pass.' : `${v.evaluation.remainingText} remaining to the profit target.`}
            </div>
          </div>
        </V2Section>
      )}

      <V2Section title="Account">
        <div className="htv2-metric-rows" data-testid="htv2-overview-metrics">
          <MetricRow label="Balance" value={v.balanceText} />
          <MetricRow label="Starting balance" value={v.startingBalanceText} />
          <MetricRow label="Net P&L" value={v.netPnl.text} tone={v.netPnl.tone} />
          <MetricRow label="MLL room" value={v.mllRoomText} tone={v.mllBreached ? 'negative' : 'default'} />
          {v.realizedPnl && <MetricRow label="Realized P&L" value={v.realizedPnl.text} tone={v.realizedPnl.tone} />}
          {v.feesText && <MetricRow label="Fees" value={v.feesText} />}
        </div>
      </V2Section>

      <V2Section title="Lifecycle">
        <V2Lifecycle portalState={d.portalState} />
      </V2Section>

      <RecentPerformance accountId={d.id} onTab={onTab} />
    </>
  );
}

function MetricRow({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'positive' | 'negative' | 'muted' }): JSX.Element {
  return (
    <div className="htv2-metric-row">
      <span className="ht-t-label">{label}</span>
      <span className={`ht-t-fin-sm ht-num htv2-tone-${tone}`}>{value}</span>
    </div>
  );
}

/** A small authoritative recent-performance strip; degrades quietly if unavailable. */
function RecentPerformance({ accountId, onTab }: { accountId: string; onTab: (t: DetailTab) => void }): JSX.Element | null {
  const an = useAnalytics(accountId);
  if (an.status !== 'ready') return null; // secondary data — silent if it fails
  const t = an.data.trades;
  if (t.totalTrades === 0) return null;
  return (
    <V2Section title="Recent performance" actions={<button className="htv2-link ht-t-nav" onClick={() => onTab('performance')}>Full performance →</button>}>
      <div className="htv2-metric-rows">
        <MetricRow label="Trades" value={String(t.totalTrades)} />
        <MetricRow label="Win rate" value={t.winRate == null ? '—' : formatPercent(t.winRate)} />
        <MetricRow label="Profit factor" value={t.profitFactor == null ? '—' : t.profitFactor.toFixed(2)} />
        <MetricRow label="Max drawdown" value={formatMoney(-an.data.equity.maxDrawdownMicros)} />
      </div>
    </V2Section>
  );
}

// ------------------------------------------------------------- Performance ----
function PerformanceTab({ accountId }: { accountId: string }): JSX.Element {
  const an = useAnalytics(accountId);
  if (an.status === 'loading') return <div className="htv2-detail-skeleton" data-testid="htv2-perf-loading" aria-busy="true"><span /><span /><span /></div>;
  if (an.status === 'error') {
    return (
      <div className="htv2-detail-error" role="alert" data-testid="htv2-perf-error">
        <div className="ht-t-section">Performance is unavailable</div>
        <p className="ht-t-body-sm">{an.message}</p>
        <V2Button variant="secondary" size="sm" onClick={an.retry}>Try again</V2Button>
      </div>
    );
  }
  const a = an.data;
  if (a.trades.totalTrades === 0) {
    return <div data-testid="htv2-perf-empty"><V2EmptyState title="No closed trades yet" hint="Performance analytics appear once this account has closed trades." /></div>;
  }
  return (
    <div data-testid="htv2-perf">
      <V2Section title="Equity curve">
        {a.equity.points.length < 2 ? (
          <p className="ht-t-meta" data-testid="htv2-perf-nocurve">Not enough closed trades to draw a curve yet.</p>
        ) : (
          <EquityCurve points={a.equity.points} />
        )}
        <p className="ht-t-meta">Cumulative net P&amp;L over closed trades (fees included). Payouts and resets are not trades and never appear here.</p>
      </V2Section>
      <V2Section title="Performance">
        <div className="htv2-metric-rows htv2-metric-rows-2col">
          <MetricRow label="Net P&L" value={formatMoney(a.trades.netPnlMicros, { sign: true })} tone={a.trades.netPnlMicros > 0 ? 'positive' : a.trades.netPnlMicros < 0 ? 'negative' : 'muted'} />
          <MetricRow label="Win rate" value={a.trades.winRate == null ? '—' : formatPercent(a.trades.winRate)} />
          <MetricRow label="Profit factor" value={a.trades.profitFactor == null ? '—' : a.trades.profitFactor.toFixed(2)} />
          <MetricRow label="Expectancy" value={formatMoney(a.trades.expectancyMicros)} />
          <MetricRow label="Trades" value={String(a.trades.totalTrades)} />
          <MetricRow label="Avg win" value={formatMoney(a.trades.averageWinMicros)} />
          <MetricRow label="Avg loss" value={formatMoney(a.trades.averageLossMicros)} />
          <MetricRow label="Best day" value={formatMoney(a.days.bestDayMicros)} />
          <MetricRow label="Worst day" value={formatMoney(a.days.worstDayMicros)} />
          <MetricRow label="Max drawdown" value={formatMoney(-a.equity.maxDrawdownMicros)} />
        </div>
      </V2Section>
      {a.breakdowns.byInstrument.length > 0 && (
        <V2Section title="By instrument">
          <div className="htv2-table-wrap">
            <table className="htv2-table" data-testid="htv2-perf-byinstrument">
              <thead><tr><th>Instrument</th><th className="num">Trades</th><th className="num">Net P&L</th><th className="num">Win rate</th></tr></thead>
              <tbody>
                {a.breakdowns.byInstrument.map((b) => (
                  <tr key={b.key}><td>{b.key}</td><td className="num ht-num">{b.trades}</td><td className="num ht-num">{formatMoney(b.netPnlMicros, { sign: true })}</td><td className="num ht-num">{b.winRate == null ? '—' : formatPercent(b.winRate)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </V2Section>
      )}
    </div>
  );
}

function EquityCurve({ points }: { points: Array<{ tExitMs: number; equityMicros: number; drawdownMicros: number }> }): JSX.Element {
  const W = 900, H = 200, pad = 8;
  const ys = points.map((p) => p.equityMicros);
  const min = Math.min(...ys), max = Math.max(...ys);
  const range = max - min || 1;
  const x = (i: number): number => pad + (i / (points.length - 1)) * (W - pad * 2);
  const y = (val: number): number => H - pad - ((val - min) / range) * (H - pad * 2);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.equityMicros).toFixed(1)}`).join(' ');
  const zeroY = min <= 0 && max >= 0 ? y(0) : null;
  return (
    <svg className="htv2-equity" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Equity curve" data-testid="htv2-equity">
      {zeroY != null && <path className="htv2-equity-zero" d={`M0,${zeroY.toFixed(1)} L${W},${zeroY.toFixed(1)}`} />}
      <path className="htv2-equity-line" d={line} />
    </svg>
  );
}

// -------------------------------------------------------------------- Rules ----
function RulesTab({ v, accountId }: { v: ReturnType<typeof toAccountDetailView>; accountId: string }): JSX.Element {
  const [el, setEl] = useState<PayoutEligibility | null>(null);
  const tokenRef = useRef(0);
  useEffect(() => {
    const token = ++tokenRef.current;
    setEl(null);
    void api.get<PayoutEligibility>(`/api/v1/payouts/eligibility/${accountId}`)
      .then((e) => { if (token === tokenRef.current) setEl(e); })
      .catch(() => { /* eligibility is optional context for the rule set */ });
  }, [accountId]);

  if (v.rulesUnavailable && !el) {
    return <div data-testid="htv2-rules-empty"><V2EmptyState title="Rules unavailable" hint="This account has no pinned rule configuration to display." /></div>;
  }
  return (
    <div data-testid="htv2-rules">
      <p className="ht-t-body-sm htv2-controls-note">The authoritative terms for this account, from your pinned product version — the same rules the engine enforces. Full official terms are on the programme page.</p>
      <div className="htv2-metric-rows">
        {v.ruleRows.map((r) => (
          <div className="htv2-metric-row" key={r.key} data-testid={`htv2-rule-${r.key}`}>
            <span className="ht-t-label">{r.label}{r.sub ? <span className="htv2-rule-sub ht-t-meta"> · {r.sub}</span> : null}</span>
            <span className="ht-t-fin-sm ht-num">{r.value}</span>
          </div>
        ))}
        {el && <div className="htv2-metric-row"><span className="ht-t-label">Winning days</span><span className="ht-t-fin-sm ht-num">{el.qualifyingWinningDays} / {el.requiredWinningDays}</span></div>}
        {el && <div className="htv2-metric-row"><span className="ht-t-label">Profit split</span><span className="ht-t-fin-sm ht-num">{el.profitSplitPercent}%</span></div>}
        {el && <div className="htv2-metric-row"><span className="ht-t-label">Programme</span><span className="ht-t-fin-sm ht-num">{el.model}</span></div>}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- Activity ----
function ActivityTab({ d }: { d: AccountDetailFull }): JSX.Element {
  // A business timeline assembled from authoritative records only — never market noise.
  const events: Array<{ at: number; label: string }> = [];
  events.push({ at: d.createdAt, label: d.resetOfAccountId ? 'Account reset — new evaluation started' : 'Account purchased' });
  for (const l of d.lifecycles ?? []) {
    events.push({ at: l.startedAt, label: `Lifecycle ${l.seq} started` });
    if (l.endedAt) events.push({ at: l.endedAt, label: `Lifecycle ${l.seq} ended — ${l.finalStatus ?? l.endReason ?? 'closed'}` });
  }
  events.sort((a, b) => b.at - a.at);
  if (events.length === 0) return <div data-testid="htv2-activity-empty"><V2EmptyState title="No account activity yet" hint="Purchases, resets and lifecycle changes will appear here." /></div>;
  return (
    <div className="htv2-table-wrap">
      <table className="htv2-table" data-testid="htv2-activity">
        <thead><tr><th>When</th><th>Event</th></tr></thead>
        <tbody>
          {events.map((e, i) => (
            <tr key={i}><td className="ht-num">{new Date(e.at).toLocaleString()}</td><td>{e.label}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------ analytics hook ----
type AnalyticsState =
  | { status: 'loading' }
  | { status: 'error'; message: string; retry: () => void }
  | { status: 'ready'; data: Analytics };

/** Fetch account analytics with a monotonic stale-response guard. */
function useAnalytics(accountId: string): AnalyticsState {
  const [state, setState] = useState<AnalyticsState>({ status: 'loading' });
  const tokenRef = useRef(0);
  const load = useCallback(() => {
    const token = ++tokenRef.current;
    setState({ status: 'loading' });
    void api.get<Analytics>(`/api/v1/portal/accounts/${accountId}/analytics`)
      .then((data) => { if (token === tokenRef.current) setState({ status: 'ready', data }); })
      .catch((e: unknown) => { if (token === tokenRef.current) setState({ status: 'error', message: e instanceof Error ? e.message : 'Could not load analytics.', retry: load }); });
  }, [accountId]);
  useEffect(load, [load]);
  return state;
}
