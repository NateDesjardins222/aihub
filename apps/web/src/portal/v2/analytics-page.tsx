/**
 * Portal V2 — Analytics (Experience Layer Phase 2).
 *
 * PORTFOLIO-LEVEL, cross-account understanding — deliberately distinct from Account
 * Detail, which is deep single-account analysis (§60). Every figure is authoritative:
 * per-account analytics (`/accounts/:id/analytics`), per-account trades aggregated to
 * a daily realized-P&L heatmap, and real payout history (`/payouts/history`). Nothing
 * is fabricated; when a dataset is thin the surface says so and shows no chart.
 *
 * Presentation only — it takes an already-composed AnalyticsView.
 */
import { useMemo, useState, type JSX } from 'react';
import { V2Section, V2EmptyState, V2StatStrip, V2AreaChart, type SeriesPoint } from './primitives';
import { V2ProgressRing } from './experience';
import { formatMoney } from './format';
import './analytics-page.css';

export interface AnalyticsAccountRow {
  accountId: string;
  label: string;
  accountType: string;
  status: string;
  realizedPnlMicros: number;      // equity.finalEquityMicros (cumulative net P&L)
  maxDrawdownMicros: number;      // equity.maxDrawdownMicros
  winRate: number | null;         // 0..1
  profitFactor: number | null;
  totalTradingDays: number;
  profitableDays: number;
  percentProfitableDays: number | null;
  bestDayMicros: number;
  worstDayMicros: number;
  equity: SeriesPoint[];          // sparkline (authoritative)
}

export interface AnalyticsPayoutRow {
  id: string; accountLabel: string; state: string; traderShareMicros: number | null; paidAt: number | null; requestedAt: number;
}

export interface AnalyticsDay { date: string; pnlMicros: number } // yyyy-mm-dd, aggregated realized

export interface AnalyticsView {
  accounts: AnalyticsAccountRow[];
  payouts: AnalyticsPayoutRow[];
  calendar: AnalyticsDay[];
}

function pct(n: number | null): string { return n == null ? '—' : `${Math.round(n * 100)}%`; }
function money0(m: number): string { return formatMoney(m, { maxFractionDigits: 0 }); }
function tone(m: number): 'positive' | 'negative' | 'default' { return m > 0 ? 'positive' : m < 0 ? 'negative' : 'default'; }
function fmtDay(d: string): string { return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }

export function V2AnalyticsPage({ view, onOpenAccount }: { view: AnalyticsView; onOpenAccount: (id: string) => void }): JSX.Element {
  const hasAccounts = view.accounts.length > 0;
  const totals = useMemo(() => {
    const realized = view.accounts.reduce((s, a) => s + a.realizedPnlMicros, 0);
    const tradingDays = view.accounts.reduce((s, a) => s + a.totalTradingDays, 0);
    const profitableDays = view.accounts.reduce((s, a) => s + a.profitableDays, 0);
    const best = view.accounts.reduce((m, a) => Math.max(m, a.bestDayMicros), 0);
    const worst = view.accounts.reduce((m, a) => Math.min(m, a.worstDayMicros), 0);
    const paid = view.payouts.filter((p) => p.state === 'PAID').reduce((s, p) => s + (p.traderShareMicros ?? 0), 0);
    return { realized, tradingDays, profitableDays, best, worst, paid, pctDays: tradingDays > 0 ? profitableDays / tradingDays : null };
  }, [view]);

  return (
    <div className="htv2-page htv2-analytics">
      <header className="htv2-page-head">
        <h1 className="ht-t-page-title">Analytics</h1>
        <p className="ht-t-meta">Your whole portfolio at a glance — performance, consistency and payouts across every account. For a single account in depth, open its detail.</p>
      </header>

      {!hasAccounts ? (
        <V2EmptyState
          title="No analytics yet"
          hint="Once you’re trading a funded or evaluation account, your portfolio performance, winning days and payout history appear here — all from your real account data."
        />
      ) : (
        <>
          {/* Portfolio summary — authoritative aggregates. */}
          <V2Section title="Where your portfolio stands">
            <V2StatStrip items={[
              { label: 'Realized P&L (all accounts)', value: money0(totals.realized), tone: tone(totals.realized) },
              { label: 'Paid to you', value: money0(totals.paid), tone: totals.paid > 0 ? 'positive' : 'default' },
              { label: 'Trading days', value: String(totals.tradingDays) },
              { label: 'Profitable days', value: totals.pctDays == null ? '—' : `${pct(totals.pctDays)}` },
              { label: 'Best day', value: money0(totals.best), tone: 'positive' },
              { label: 'Worst day', value: money0(totals.worst), tone: totals.worst < 0 ? 'negative' : 'default' },
            ]} />
          </V2Section>

          {/* Daily realized P&L heatmap — aggregated from authoritative trades. */}
          {view.calendar.length > 0 && (
            <V2Section title="Daily realized P&L">
              <PerformanceCalendar days={view.calendar} />
            </V2Section>
          )}

          {/* Account comparison. */}
          <V2Section title="Account comparison">
            <div className="htv2-cmp" data-testid="htv2-analytics-comparison">
              {view.accounts.map((a) => (
                <button key={a.accountId} className="htv2-cmp-row htv2-icard htv2-card" onClick={() => onOpenAccount(a.accountId)} data-testid="htv2-cmp-row">
                  <span className="htv2-icard-sheen" aria-hidden />
                  <div className="htv2-cmp-id">
                    <span className="htv2-cmp-name ht-t-fin-sm">{a.label}</span>
                    <span className="ht-t-meta htv2-tone-muted">{a.accountType === 'FUNDED_SIM' ? 'Funded' : 'Evaluation'} · {a.status}</span>
                  </div>
                  <div className="htv2-cmp-spark">{a.equity.length >= 2 ? <V2AreaChart points={a.equity} height={40} ariaLabel={`${a.label} equity`} /> : <span className="ht-t-meta htv2-tone-faint">No trades yet</span>}</div>
                  <div className="htv2-cmp-metrics">
                    <Metric label="Realized" value={money0(a.realizedPnlMicros)} tone={tone(a.realizedPnlMicros)} />
                    <Metric label="Win rate" value={pct(a.winRate)} />
                    <Metric label="Profit factor" value={a.profitFactor == null ? '—' : a.profitFactor.toFixed(2)} />
                    <Metric label="Max drawdown" value={money0(a.maxDrawdownMicros)} tone={a.maxDrawdownMicros > 0 ? 'negative' : 'default'} />
                    <Metric label="Profitable days" value={pct(a.percentProfitableDays)} />
                  </div>
                </button>
              ))}
            </div>
          </V2Section>

          {/* Payout history — authoritative payout_requests. */}
          <V2Section title="Payout history">
            {view.payouts.length === 0 ? (
              <p className="ht-t-meta htv2-tone-muted">No payouts requested yet. When you request and receive a payout, it appears here.</p>
            ) : (
              <table className="htv2-ptable" data-testid="htv2-analytics-payouts">
                <thead><tr><th>Date</th><th>Account</th><th>Status</th><th className="num">Paid to you</th></tr></thead>
                <tbody>
                  {view.payouts.map((p) => (
                    <tr key={p.id}>
                      <td className="ht-num">{new Date(p.paidAt ?? p.requestedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' })}</td>
                      <td>{p.accountLabel}</td>
                      <td><span className={`htv2-pstate htv2-pstate-${p.state === 'PAID' ? 'paid' : 'pending'}`}>{p.state}</span></td>
                      <td className="num ht-num">{p.traderShareMicros != null ? money0(p.traderShareMicros) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </V2Section>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'positive' | 'negative' }): JSX.Element {
  return (
    <div className="htv2-cmp-metric">
      <span className="ht-t-label">{label}</span>
      <span className={`ht-t-fin-sm ht-num htv2-tone-${tone}`}>{value}</span>
    </div>
  );
}

/** A compact weeks×days heatmap of daily realized P&L. Interactive: hover/click a day. */
function PerformanceCalendar({ days }: { days: AnalyticsDay[] }): JSX.Element {
  const [sel, setSel] = useState<AnalyticsDay | null>(null);
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  // Build the trailing ~17 weeks ending today, aligned to weeks (Sun start).
  const cells = useMemo(() => {
    const out: Array<{ date: string; day: AnalyticsDay | null }> = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = new Date(today); end.setDate(end.getDate() + (6 - end.getDay())); // end of this week
    const start = new Date(end); start.setDate(start.getDate() - 7 * 17 + 1);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      out.push({ date: key, day: byDate.get(key) ?? null });
    }
    return out;
  }, [byDate]);
  const maxAbs = useMemo(() => Math.max(1, ...days.map((d) => Math.abs(d.pnlMicros))), [days]);

  const weeks: Array<Array<{ date: string; day: AnalyticsDay | null }>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return (
    <div className="htv2-cal" data-testid="htv2-analytics-calendar">
      <div className="htv2-cal-grid">
        {weeks.map((w, wi) => (
          <div className="htv2-cal-week" key={wi}>
            {w.map((c) => {
              const v = c.day?.pnlMicros ?? null;
              const intensity = v == null ? 0 : Math.min(1, Math.abs(v) / maxAbs);
              const cls = v == null ? 'none' : v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat';
              return (
                <button key={c.date} type="button"
                  className={`htv2-cal-cell is-${cls}${sel?.date === c.date ? ' is-sel' : ''}`}
                  style={v != null ? ({ ['--i' as string]: intensity.toFixed(2) }) : undefined}
                  title={c.day ? `${fmtDay(c.date)}: ${money0(v!)}` : fmtDay(c.date)}
                  onClick={() => setSel(c.day ?? { date: c.date, pnlMicros: 0 })}
                  aria-label={c.day ? `${fmtDay(c.date)} ${money0(v!)}` : fmtDay(c.date)} />
              );
            })}
          </div>
        ))}
      </div>
      <div className="htv2-cal-foot ht-t-meta">
        {sel ? <span><strong>{fmtDay(sel.date)}</strong> · <span className={`ht-num htv2-tone-${tone(sel.pnlMicros)}`}>{money0(sel.pnlMicros)}</span> realized</span>
          : <span className="htv2-tone-muted">Trailing 17 weeks of realized P&L across your accounts. Click a day for detail.</span>}
      </div>
    </div>
  );
}

export { V2ProgressRing };
