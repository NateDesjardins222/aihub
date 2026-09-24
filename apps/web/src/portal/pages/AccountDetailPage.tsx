import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../../api/client';
import {
  type AccountDetailFull, type Analytics, type PayoutEligibility,
  AccountPath, Card, familyOf, Metric, money, Money, msg, pct, Pill, Skeleton,
} from '../lib';
import { Performance } from './Performance';
import { ControlsView } from './ControlsView';

const TABS = [
  ['overview', 'Overview'], ['performance', 'Performance'], ['controls', 'Controls'], ['rules', 'Rules'], ['activity', 'Activity'],
] as const;

export function AccountDetailPage({
  accountId, tab, onTab, onBack, onToast,
}: {
  accountId: string; tab: string; onTab: (t: string) => void; onBack: () => void; onToast: (m: string) => void;
}): JSX.Element {
  const [detail, setDetail] = useState<AccountDetailFull | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void api.get<AccountDetailFull>(`/api/v1/portal/accounts/${accountId}`).then(setDetail).catch((e: unknown) => setErr(msg(e)));
  }, [accountId]);

  if (err) return (<><button className="pt-back" onClick={onBack}>← Accounts</button><p className="pt-error">{err}</p></>);
  if (!detail) return (<><button className="pt-back" onClick={onBack}>← Accounts</button><Skeleton h={120} /></>);

  const tradable = detail.status === 'ACTIVE' && (detail.accountType === 'EVALUATION' || detail.accountType === 'FUNDED_SIM');

  return (
    <>
      <button className="pt-back" onClick={onBack}>← Accounts</button>
      <div className="pt-row">
        <div>
          <div className={`pt-acct-fam${familyOf(detail.product?.key) === 'GOLD' ? ' gold' : ''}`}>{familyOf(detail.product?.key)} · {detail.product?.name ?? detail.name}</div>
          <h1 className="pt-h1" style={{ marginTop: 2 }}>{detail.nickname || detail.name}</h1>
        </div>
        <Pill state={detail.portalState} />
      </div>
      <p className="pt-sub" style={{ marginTop: 6 }}>Account •••• {detail.publicId.slice(-4)}</p>

      <div className="pt-tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={`pt-tab${tab === key ? ' on' : ''}`} data-testid={`pt-tab-${key}`} onClick={() => onTab(key)}>{label}</button>
        ))}
      </div>

      {tab === 'overview' && <Overview detail={detail} accountId={accountId} tradable={tradable} onTab={onTab} />}
      {tab === 'performance' && <Performance accountId={accountId} />}
      {tab === 'controls' && <ControlsView accountId={accountId} onToast={onToast} />}
      {tab === 'rules' && <RulesView accountId={accountId} detail={detail} />}
      {tab === 'activity' && <ActivityView detail={detail} />}
    </>
  );
}

function Overview({ detail, accountId, tradable, onTab }: { detail: AccountDetailFull; accountId: string; tradable: boolean; onTab: (t: string) => void }): JSX.Element {
  const [an, setAn] = useState<Analytics | null>(null);
  useEffect(() => { void api.get<Analytics>(`/api/v1/portal/accounts/${accountId}/analytics`).then(setAn).catch(() => setAn(null)); }, [accountId]);
  const net = detail.balanceMicros - detail.startingBalanceMicros;
  const mll = Math.max(0, detail.balanceMicros - detail.drawdownFloorMicros);
  return (
    <>
      <div className="pt-row" style={{ marginBottom: 16 }}>
        <AccountPath portalState={detail.portalState} />
        {tradable && <button className="pt-btn primary" data-testid="pt-trade-atlas" onClick={() => { window.location.href = `/?account=${detail.publicId}`; }}>Trade in Atlas →</button>}
      </div>
      <div className="pt-metrics">
        <Metric label="Balance" value={money(detail.balanceMicros)} />
        <Metric label="Start balance" value={money(detail.startingBalanceMicros)} />
        <Metric label="Net P&L" value={<Money micros={net} sign />} />
        <Metric label="MLL room" value={<Money micros={mll} />} cls={mll <= 0 ? 'neg' : ''} />
        <Metric label="Realized P&L" value={<Money micros={detail.realizedPnlMicros ?? null} />} />
        <Metric label="Fees" value={money(-(detail.feesMicros ?? 0))} />
      </div>
      {an && (
        <>
          <div className="pt-section-title">Recent performance</div>
          <div className="pt-metrics">
            <Metric label="Trades" value={String(an.trades.totalTrades)} />
            <Metric label="Win rate" value={pct(an.trades.winRate)} />
            <Metric label="Profit factor" value={an.trades.profitFactor == null ? '—' : an.trades.profitFactor.toFixed(2)} />
            <Metric label="Max drawdown" value={<Money micros={-an.equity.maxDrawdownMicros} />} />
          </div>
          <div className="pt-actions"><button className="pt-link" onClick={() => onTab('performance')}>Open full performance →</button></div>
        </>
      )}
    </>
  );
}

function RulesView({ accountId, detail }: { accountId: string; detail: AccountDetailFull }): JSX.Element {
  const [el, setEl] = useState<PayoutEligibility | null>(null);
  const [an, setAn] = useState<Analytics | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    Promise.allSettled([
      api.get<PayoutEligibility>(`/api/v1/payouts/eligibility/${accountId}`),
      api.get<Analytics>(`/api/v1/portal/accounts/${accountId}/analytics`),
    ]).then(([e, a]) => {
      if (e.status === 'fulfilled') setEl(e.value);
      if (a.status === 'fulfilled') setAn(a.value);
      setLoaded(true);
    });
  }, [accountId]);
  if (!loaded) return <Skeleton h={120} />;
  const mll = Math.max(0, detail.balanceMicros - detail.drawdownFloorMicros);
  return (
    <>
      <p className="pt-sub" style={{ marginTop: 0 }}>The rules that decide this account, from your authoritative record. Full official terms are on the programme page.</p>
      <div className="pt-metrics">
        <Metric label="MLL headroom" value={<Money micros={mll} />} cls={mll <= 0 ? 'neg' : ''} />
        {an && <Metric label="Current drawdown" value={<Money micros={-an.currentDrawdownMicros} />} />}
        {an && <Metric label="Max drawdown" value={<Money micros={-an.equity.maxDrawdownMicros} />} />}
        {el && <Metric label="Winning days" value={`${el.qualifyingWinningDays} / ${el.requiredWinningDays}`} />}
        {el && <Metric label="Consistency" value={el.consistencyRatio == null ? 'n/a' : pct(el.consistencyRatio)} sub={el.payoutConsistencyThreshold != null ? `≤ ${pct(el.payoutConsistencyThreshold)}` : 'no cap'} />}
        {el && <Metric label="Programme" value={el.model} />}
      </div>
      <div className="pt-actions" style={{ marginTop: 16 }}>
        <button className="pt-link" onClick={() => { window.location.href = '/onboarding'; }}>Read full official rules →</button>
      </div>
    </>
  );
}

function ActivityView({ detail }: { detail: AccountDetailFull }): JSX.Element {
  // A meaningful business timeline assembled from authoritative records: the
  // account's lifecycles (purchase/reset/pass/fail/complete) — not market noise.
  const events: Array<{ at: number; label: string }> = [];
  events.push({ at: detail.createdAt, label: detail.resetOfAccountId ? 'Account reset — new evaluation started' : 'Account purchased' });
  for (const l of detail.lifecycles ?? []) {
    events.push({ at: l.startedAt, label: `Lifecycle ${l.seq} started` });
    if (l.endedAt) events.push({ at: l.endedAt, label: `Lifecycle ${l.seq} ended — ${l.finalStatus ?? l.endReason ?? 'closed'}` });
  }
  events.sort((a, b) => b.at - a.at);
  if (events.length === 0) return <div className="pt-empty">No account activity yet.</div>;
  return (
    <Card pad={false}>
      <table className="pt-table" data-testid="pt-activity">
        <thead><tr><th>When</th><th>Event</th></tr></thead>
        <tbody>
          {events.map((e, i) => (
            <tr key={i}><td>{new Date(e.at).toLocaleString()}</td><td>{e.label}</td></tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
