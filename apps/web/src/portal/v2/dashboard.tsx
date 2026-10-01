/**
 * V2 Dashboard presentation — the approved customer dashboard, extracted from the
 * dev review harness (Review.tsx) into a shared, purely-presentational module so
 * BOTH the dev review (fixtures) and the canonical production portal (authoritative
 * data) mount the SAME presentation. No fixtures, no fetching here — data in, UI out.
 *
 * Portal Convergence Phase 1.
 */
import { useMemo, useState, type JSX } from 'react';
import {
  V2Section, V2Button, V2StatStrip, V2Attention, V2ActivityList, V2Divider, V2EmptyState,
} from './primitives';
import { V2AccountPanel } from './AccountPanel';
import { V2PerfChart } from './perf-chart';
import { toAccountView, type AccountViewExtra } from './account-view';
import { formatMoney } from './format';
import type { SeriesPoint, ActivityItem } from './primitives';
import type { AccountsView, AccountSummary } from '../lib';

/** The data the dashboard presentation renders. The caller (dev review OR the
 *  canonical container) assembles it from fixtures or authoritative APIs. */
export interface V2DashboardData {
  accountsView: AccountsView;
  /** Payout roll-up (authoritative micro-dollars). */
  payouts: { availableMicros: number; totalPaidMicros: number };
  /** The Progress hero (authoritative). */
  progress: {
    lifetimePaidTraderShareMicros: number;
    achievementsEarned: number;
    currentClub: 'TENK_CLUB' | 'FIFTYK_CLUB' | 'HUNDREDK_CLUB' | null;
    nextClub: { remainingMicros: number } | null;
  };
  /** Cumulative realized-P&L series (authoritative points), or [] when none. */
  series: SeriesPoint[];
  /** Recent activity rows, or [] when none. */
  activity: ActivityItem[];
  /** Funded-account payout extras (winning days / available), per account id. */
  extraFor: (a: AccountSummary) => AccountViewExtra | undefined;
}

export function V2Dashboard({ data, onOpenAccount, onTrade, onAddAccount, onOpenPayouts, onOpenProgress }: {
  data: V2DashboardData;
  onOpenAccount: (id: string) => void;
  onTrade: (publicId: string) => void;
  onAddAccount: () => void;
  onOpenPayouts: () => void;
  onOpenProgress: () => void;
}): JSX.Element {
  const accts = data.accountsView.accounts;
  const isEval = (a: AccountSummary): boolean => a.portalState.startsWith('EVALUATION');
  const isFunded = (a: AccountSummary): boolean => a.accountType === 'FUNDED_SIM' && !a.portalState.startsWith('COMPLETED');
  const activeCount = accts.filter((a) => ['PENDING', 'ACTIVE', 'GOAL_REACHED', 'LOCKED'].includes(a.status)).length;
  const totalBalance = accts.reduce((s, a) => s + a.balanceMicros, 0);
  const netPnl = accts.reduce((s, a) => s + (a.balanceMicros - a.startingBalanceMicros), 0);
  const breached = accts.filter((a) => a.portalState === 'FAILED');
  const topAccounts = accts.filter((a) => a.portalState !== 'ARCHIVED' && a.portalState !== 'INACTIVE_CLOSED').slice(0, 4);
  const payoutAvailable = data.payouts.availableMicros;

  return (
    <div className="htv2-page">
      <header className="htv2-page-head htv2-page-head-row">
        <div>
          <h1 className="ht-t-page-title">Dashboard</h1>
          <p className="ht-t-meta">Your accounts, standing, and what needs attention.</p>
        </div>
        <V2Button variant="secondary" size="sm" onClick={onAddAccount}>Add account</V2Button>
      </header>

      <V2StatStrip
        items={[
          { label: 'Total balance', value: formatMoney(totalBalance, { maxFractionDigits: 0 }) },
          { label: 'Net P&L', value: formatMoney(netPnl, { sign: true, maxFractionDigits: 0 }), tone: netPnl > 0 ? 'positive' : netPnl < 0 ? 'negative' : 'muted' },
          { label: 'Active accounts', value: String(activeCount) },
          { label: 'Evaluations', value: String(accts.filter(isEval).length) },
          { label: 'Funded', value: String(accts.filter(isFunded).length) },
          { label: 'Total paid', value: formatMoney(data.payouts.totalPaidMicros, { maxFractionDigits: 0 }) },
        ]}
      />

      {accts.length === 0 && (
        <V2EmptyState
          title="Welcome to Happy Trader"
          hint="You don't have any accounts yet. Buy an evaluation to get started — your accounts, performance and payouts will appear here."
          action={<V2Button variant="primary" size="sm" onClick={onAddAccount}>Add account</V2Button>}
        />
      )}

      {breached.length > 0 ? (
        <V2Attention
          tone="negative"
          title={`${breached.length} account${breached.length > 1 ? 's' : ''} breached`}
          detail="A breached account can no longer trade. Open it to see the breach detail."
          action={<V2Button variant="secondary" size="sm" onClick={() => onOpenAccount(breached[0]!.id)}>Review</V2Button>}
        />
      ) : payoutAvailable > 0 ? (
        <V2Attention
          tone="positive"
          title={`${formatMoney(payoutAvailable)} available to withdraw`}
          detail="One of your funded accounts is eligible for a payout."
          action={<V2Button variant="secondary" size="sm" onClick={onOpenPayouts}>Payouts</V2Button>}
        />
      ) : null}

      {topAccounts.length > 0 && (
        <V2Section
          title="Your accounts"
          actions={<button className="htv2-link ht-t-nav" onClick={() => onOpenAccount(topAccounts[0]!.id)}>All accounts →</button>}
        >
          <div className="htv2-acct-grid">
            {topAccounts.map((a) => (
              <V2AccountPanel
                key={a.id}
                a={toAccountView(a, data.extraFor(a))}
                onDetails={() => onOpenAccount(a.id)}
                onTrade={() => onTrade(a.publicId)}
              />
            ))}
          </div>
        </V2Section>
      )}

      {accts.length > 0 && <NextUp accounts={accts} extraFor={data.extraFor} onOpenAccount={onOpenAccount} onOpenPayouts={onOpenPayouts} />}

      {(data.progress.lifetimePaidTraderShareMicros > 0 || data.progress.achievementsEarned > 0) && (
        <V2Section title="Your journey" actions={<button className="htv2-link ht-t-nav" onClick={onOpenProgress} data-testid="htv2-dash-journey">Open journey →</button>}>
          <div className="htv2-dash-journey" data-testid="htv2-dash-journey-strip">
            <div className="htv2-dash-journey-lead htv2-aura htv2-aura-on">
              <span className="ht-t-label">Paid to you, lifetime</span>
              <span className="ht-t-fin-lg ht-num htv2-metal-champagne">{formatMoney(data.progress.lifetimePaidTraderShareMicros, { maxFractionDigits: 0 })}</span>
            </div>
            <div className="htv2-dash-journey-meta">
              {data.progress.currentClub && <span className="ht-t-body-sm">Member of the <strong>{data.progress.currentClub === 'HUNDREDK_CLUB' ? '$100K' : data.progress.currentClub === 'FIFTYK_CLUB' ? '$50K' : '$10K'} Club</strong></span>}
              {data.progress.nextClub && (
                <span className="ht-t-meta htv2-tone-muted">
                  {formatMoney(data.progress.nextClub.remainingMicros, { maxFractionDigits: 0 })} to the next club
                </span>
              )}
              <span className="ht-t-meta htv2-tone-muted">{data.progress.achievementsEarned} milestone{data.progress.achievementsEarned === 1 ? '' : 's'} earned</span>
            </div>
          </div>
        </V2Section>
      )}

      {data.series.length >= 2 && <PortfolioPerformance series={data.series} />}

      {data.activity.length > 0 && (
        <V2Section title="Recent activity" actions={<button className="htv2-link ht-t-nav" onClick={onOpenPayouts}>Payout history →</button>}>
          <V2ActivityList items={data.activity} />
        </V2Section>
      )}

      <V2Divider />
    </div>
  );
}

/** Portfolio-level cumulative realized P&L — a REAL interactive chart. The caller
 *  supplies ONE authoritative cumulative series (micro-dollars); ranges slice it
 *  (never fabricate points) and companion metrics derive from the same data. */
export function PortfolioPerformance({ series: full }: { series: SeriesPoint[] }): JSX.Element {
  const hasSeries = full.length >= 2;
  const spanDays = hasSeries ? (full[full.length - 1]!.t - full[0]!.t) / 86_400_000 : 0;
  const ranges = useMemo(() => {
    const all: Array<{ key: string; days: number | null }> = [
      { key: '7D', days: 7 }, { key: '30D', days: 30 }, { key: '90D', days: 90 },
      { key: 'YTD', days: null }, { key: 'All', days: null },
    ];
    return all.filter((r) => r.key === 'All' || r.key === 'YTD' || (r.days != null && spanDays >= r.days * 0.5));
  }, [spanDays]);
  const [range, setRange] = useState('90D');
  const activeKey = ranges.some((r) => r.key === range) ? range : 'All';

  const series = useMemo(() => {
    if (activeKey === 'All') return full;
    if (activeKey === 'YTD') {
      const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime();
      const ytd = full.filter((p) => p.t >= jan1);
      return ytd.length >= 2 ? ytd : full;
    }
    const days = ranges.find((r) => r.key === activeKey)!.days!;
    const cutoff = full[full.length - 1]!.t - days * 86_400_000;
    const win = full.filter((p) => p.t >= cutoff);
    return win.length >= 2 ? win : full;
  }, [full, ranges, activeKey]);

  const m = useMemo(() => periodMetrics(full, series), [full, series]);

  return (
    <V2Section
      title="Portfolio performance"
      actions={hasSeries ? (
        <span className="htv2-chart-ranges" role="tablist" aria-label="Performance range">
          {ranges.map((r) => (
            <button key={r.key} role="tab" aria-selected={activeKey === r.key}
              className={`htv2-chart-range${activeKey === r.key ? ' on' : ''}`}
              onClick={() => setRange(r.key)} data-testid={`htv2-perf-range-${r.key}`}>{r.key}</button>
          ))}
        </span>
      ) : undefined}
    >
      <div className="htv2-chart-frame">
        {hasSeries ? (
          <>
            <div className="htv2-chart-caption">
              <span className="ht-t-label">Cumulative realized P&amp;L</span>
              <span className={`ht-t-fin-md ht-num htv2-tone-${m.periodPnl > 0 ? 'positive' : m.periodPnl < 0 ? 'negative' : 'muted'}`}>
                {formatMoney(m.periodPnl, { sign: true, maxFractionDigits: 0 })} <span className="ht-t-meta">this period</span>
              </span>
            </div>
            <V2PerfChart series={series} height={240} ariaLabel="Portfolio cumulative realized P&L" />
            <dl className="htv2-perf-metrics" data-testid="htv2-perf-metrics">
              <PerfMetric k="Period P&L" v={formatMoney(m.periodPnl, { sign: true, maxFractionDigits: 0 })} tone={m.periodPnl > 0 ? 'positive' : m.periodPnl < 0 ? 'negative' : 'default'} />
              <PerfMetric k="Best day" v={formatMoney(m.best, { sign: true, maxFractionDigits: 0 })} tone="positive" />
              <PerfMetric k="Worst day" v={formatMoney(m.worst, { sign: true, maxFractionDigits: 0 })} tone={m.worst < 0 ? 'negative' : 'default'} />
              <PerfMetric k="Trading days" v={String(m.days)} />
              <PerfMetric k="Avg / day" v={formatMoney(m.avg, { sign: true, maxFractionDigits: 0 })} tone={m.avg > 0 ? 'positive' : m.avg < 0 ? 'negative' : 'default'} />
            </dl>
          </>
        ) : (
          <p className="htv2-chart-empty ht-t-body-sm">No trading history yet. Your performance appears here once you place your first trades.</p>
        )}
      </div>
    </V2Section>
  );
}

function NextUp({ accounts, extraFor, onOpenAccount, onOpenPayouts }: {
  accounts: AccountSummary[];
  extraFor: (a: AccountSummary) => AccountViewExtra | undefined;
  onOpenAccount: (id: string) => void;
  onOpenPayouts: () => void;
}): JSX.Element | null {
  const evals = accounts.filter((a) => a.portalState === 'EVALUATION_ACTIVE');
  const funded = accounts.filter((a) => a.accountType === 'FUNDED_SIM' && a.portalState === 'FUNDED_ACTIVE');
  if (evals.length === 0 && funded.length === 0) return null;
  return (
    <V2Section title="Progress & payout readiness" actions={<button className="htv2-link ht-t-nav" onClick={onOpenPayouts}>Payouts →</button>}>
      <div className="htv2-nextup">
        {evals.map((a) => {
          const v = toAccountView(a, extraFor(a));
          const achieved = a.balanceMicros - a.startingBalanceMicros;
          const remaining = Math.max(0, (a.profitTargetMicros ?? 0) - achieved);
          const mll = v.metrics.find((mm) => mm.label === 'MLL room');
          return (
            <button key={a.id} className="htv2-nextup-row" onClick={() => onOpenAccount(a.id)} data-testid="htv2-nextup-eval">
              <span className="htv2-nextup-id">
                <span className="ht-t-fin-sm">{v.productLabel}</span>
                <span className="ht-t-meta ht-num">{v.maskedId} · Evaluation</span>
              </span>
              <span className="htv2-nextup-prog">
                <span className="htv2-nextup-bar"><span style={{ width: `${Math.max(0, Math.min(100, v.progressPct ?? 0))}%` }} /></span>
                <span className="ht-t-meta ht-num">{Math.round(v.progressPct ?? 0)}% to target</span>
              </span>
              <span className="htv2-nextup-fig">
                <span className="ht-t-fin-sm ht-num">{formatMoney(remaining, { maxFractionDigits: 0 })}</span>
                <span className="ht-t-meta">to pass{mll ? ` · ${mll.value} MLL room` : ''}</span>
              </span>
            </button>
          );
        })}
        {funded.map((a) => {
          const x = extraFor(a);
          const avail = x?.availableMicros ?? 0;
          const wd = x?.winningDays ?? 0; const req = x?.requiredWinningDays;
          const v = toAccountView(a, x);
          return (
            <button key={a.id} className="htv2-nextup-row" onClick={() => onOpenAccount(a.id)} data-testid="htv2-nextup-funded">
              <span className="htv2-nextup-id">
                <span className="ht-t-fin-sm">{v.productLabel}</span>
                <span className="ht-t-meta ht-num">{v.maskedId} · Funded</span>
              </span>
              <span className="htv2-nextup-prog">
                <span className="htv2-nextup-bar"><span style={{ width: `${req ? Math.max(0, Math.min(100, (wd / req) * 100)) : 0}%` }} /></span>
                <span className="ht-t-meta ht-num">{req ? `${wd} / ${req} winning days` : `${wd} winning days`}</span>
              </span>
              <span className="htv2-nextup-fig">
                <span className={`ht-t-fin-sm ht-num htv2-tone-${avail > 0 ? 'positive' : 'muted'}`}>{formatMoney(avail, { maxFractionDigits: 0 })}</span>
                <span className="ht-t-meta">{avail > 0 ? 'available now' : 'requestable'}</span>
              </span>
            </button>
          );
        })}
      </div>
    </V2Section>
  );
}

function PerfMetric({ k, v, tone = 'default' }: { k: string; v: string; tone?: 'default' | 'positive' | 'negative' }): JSX.Element {
  return (
    <div className="htv2-perf-metric">
      <dt className="htv2-perf-metric-k">{k}</dt>
      <dd className={`htv2-perf-metric-v htv2-tone-${tone}`}>{v}</dd>
    </div>
  );
}

function periodMetrics(full: SeriesPoint[], window: SeriesPoint[]): { periodPnl: number; best: number; worst: number; days: number; avg: number } {
  if (window.length < 1) return { periodPnl: 0, best: 0, worst: 0, days: 0, avg: 0 };
  const idx = new Map(full.map((p, i) => [p.t, i]));
  const deltas: number[] = [];
  for (const p of window) {
    const i = idx.get(p.t);
    if (i == null) continue;
    deltas.push(i === 0 ? full[0]!.v : full[i]!.v - full[i - 1]!.v);
  }
  const periodPnl = deltas.reduce((s, d) => s + d, 0);
  const best = deltas.length ? Math.max(...deltas) : 0;
  const worst = deltas.length ? Math.min(...deltas) : 0;
  const days = deltas.length;
  const avg = days ? Math.round(periodPnl / days) : 0;
  return { periodPnl, best, worst, days, avg };
}
