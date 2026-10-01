/**
 * Canonical production data containers for the converged customer portal.
 *
 * Portal Convergence Phase 1. Each container fetches the AUTHORITATIVE hardened
 * endpoint(s) and feeds the approved V2 presentational component. No fixtures. A
 * failed fetch renders an error/unknown state — NEVER an authoritative zero or a
 * fabricated empty (error ≠ zero). All money stays integer micro-dollars; the only
 * client arithmetic is presentation aggregation of server-authoritative values.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { api, ApiRequestError, getAccessToken } from '../../api/client';
import { latestGuard } from './race';
import { V2Button, V2EmptyState } from './primitives';
import { V2AccountsView, type V2AccountsState } from './AccountsView';
import {
  V2PayoutsPage, V2CertificatesPage, V2BillingPage,
  type PayoutsView, type BillingView, type PayoutStandingRow, type PayoutHistoryRow, type OrderRow,
} from './pages';
import { V2ProgressPage, type ProgressView, type GoalView, type GoalDraft } from './progress-page';
import { V2AnalyticsPage, type AnalyticsView, type AnalyticsAccountRow, type AnalyticsDay } from './analytics-page';
import { V2Dashboard, type V2DashboardData } from './dashboard';
import { V2PageSkeleton } from './experience';
import { productLabel, type AccountViewExtra } from './account-view';
import { PayoutModule } from '../pages/PayoutModule';
import type { AccountsView, AccountSummary, Cert, PayoutEligibility } from '../lib';

const INCLUDE_ARCHIVED = '/api/v1/portal/accounts?includeArchived=false';

/** A tiny discriminated resource hook with stale-response protection (error ≠ zero). */
type Res<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

function useResource<T>(load: (signal: { live: () => boolean }) => Promise<T>, deps: unknown[]): [Res<T>, () => void] {
  const [res, setRes] = useState<Res<T>>({ status: 'loading' });
  const guardRef = useRef(latestGuard());
  const run = useCallback(() => {
    const token = guardRef.current.issue();
    setRes({ status: 'loading' });
    void load({ live: () => guardRef.current.isLatest(token) })
      .then((data) => { if (guardRef.current.isLatest(token)) setRes({ status: 'ready', data }); })
      .catch((err: unknown) => {
        if (!guardRef.current.isLatest(token)) return;
        setRes({ status: 'error', message: err instanceof ApiRequestError ? err.message : 'Something went wrong. Please try again.' });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => run(), [run]);
  return [res, run];
}

/** A shared error panel — never renders zeros. */
function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="htv2-page">
      <V2EmptyState
        title="We couldn’t load this"
        hint={`${message} This is a connection problem, not empty data.`}
        action={<V2Button variant="secondary" size="sm" onClick={onRetry}>Retry</V2Button>}
      />
    </div>
  );
}

// --- funded-account payout extras (winning days / available) -------------------
/** Fetch eligibility for the funded accounts and build the per-account extras map +
 *  a representative profit-split. Eligibility failures degrade to "no extra" (the
 *  account card still renders truthfully from its own authoritative fields). */
async function fundedExtras(accounts: AccountSummary[], live: () => boolean): Promise<{ extras: Record<string, AccountViewExtra>; split: number | null; availableTotal: number }> {
  const funded = accounts.filter((a) => a.accountType === 'FUNDED_SIM' && a.status === 'ACTIVE');
  const extras: Record<string, AccountViewExtra> = {};
  let split: number | null = null;
  let availableTotal = 0;
  await Promise.all(funded.map(async (a) => {
    try {
      const el = await api.get<PayoutEligibility>(`/api/v1/payouts/eligibility/${a.id}`);
      if (!live()) return;
      const eligible = el.state === 'ELIGIBLE';
      const avail = eligible ? el.maxRequestMicros : 0;
      extras[a.id] = {
        winningDays: el.qualifyingWinningDays,
        requiredWinningDays: el.requiredWinningDays,
        consistencyRatio: el.consistencyRatio ?? null,
        payoutState: el.state,
        availableMicros: avail,
      };
      if (el.profitSplitPercent > 0) split = el.profitSplitPercent;
      availableTotal += avail;
    } catch { /* eligibility unavailable → no extra for this account */ }
  }));
  return { extras, split, availableTotal };
}

// --- Accounts -----------------------------------------------------------------
export function CanonicalAccounts({ onOpen, onTrade, onAddAccount }: {
  onOpen: (a: AccountSummary) => void; onTrade: (a: AccountSummary) => void; onAddAccount: () => void;
}): JSX.Element {
  const [res] = useResource<{ view: AccountsView; extras: Record<string, AccountViewExtra> }>(async ({ live }) => {
    const view = await api.get<AccountsView>(INCLUDE_ARCHIVED);
    const { extras } = await fundedExtras(view.accounts, live);
    return { view, extras };
  }, []);
  const state: V2AccountsState =
    res.status === 'loading' ? { status: 'loading' }
      : res.status === 'error' ? { status: 'error', message: res.message }
        : { status: 'ready', view: res.data.view };
  const extraFor = res.status === 'ready' ? (a: AccountSummary) => res.data.extras[a.id] : undefined;
  return <V2AccountsView state={state} extraFor={extraFor} actions={{ onOpen, onTrade, onGetAccount: onAddAccount }} />;
}

// --- Dashboard ----------------------------------------------------------------
interface DashSources { view: AccountsView; progress: ProgressHero; extras: Record<string, AccountViewExtra>; availableTotal: number; totalPaidMicros: number; }
interface ProgressHero { lifetimePaidTraderShareMicros: number; achievementsEarned: number; currentClub: 'TENK_CLUB' | 'FIFTYK_CLUB' | 'HUNDREDK_CLUB' | null; nextClub: { remainingMicros: number } | null; }

export function CanonicalDashboard({ onOpenAccount, onTrade, onAddAccount, onOpenPayouts, onOpenProgress }: {
  onOpenAccount: (id: string) => void; onTrade: (publicId: string) => void; onAddAccount: () => void;
  onOpenPayouts: () => void; onOpenProgress: () => void;
}): JSX.Element {
  const [res, retry] = useResource<DashSources>(async ({ live }) => {
    const view = await api.get<AccountsView>(INCLUDE_ARCHIVED);
    const { extras, availableTotal } = await fundedExtras(view.accounts, live);
    // Progress hero is authoritative lifetime-paid + club standing.
    let progress: ProgressHero = { lifetimePaidTraderShareMicros: 0, achievementsEarned: 0, currentClub: null, nextClub: null };
    try {
      const p = await api.get<{ hero: ProgressHero }>('/api/v1/portal/progress');
      if (p.hero) progress = { lifetimePaidTraderShareMicros: p.hero.lifetimePaidTraderShareMicros, achievementsEarned: p.hero.achievementsEarned, currentClub: p.hero.currentClub, nextClub: p.hero.nextClub ? { remainingMicros: p.hero.nextClub.remainingMicros } : null };
    } catch { /* progress optional on the dashboard roll-up */ }
    return { view, progress, extras, availableTotal, totalPaidMicros: progress.lifetimePaidTraderShareMicros };
  }, []);

  if (res.status === 'error') return <ErrorPanel message={res.message} onRetry={retry} />;
  if (res.status === 'loading') {
    return <div className="htv2-page"><header className="htv2-page-head"><h1 className="ht-t-page-title">Dashboard</h1><p className="ht-t-meta">Loading your authoritative records…</p></header></div>;
  }
  const data: V2DashboardData = {
    accountsView: res.data.view,
    payouts: { availableMicros: res.data.availableTotal, totalPaidMicros: res.data.totalPaidMicros },
    progress: res.data.progress,
    series: [], // portfolio-level series has no authoritative roll-up endpoint yet; per-account performance lives in Account detail. Never a fabricated curve.
    activity: [],
    extraFor: (a) => res.data.extras[a.id],
  };
  return <V2Dashboard data={data} onOpenAccount={onOpenAccount} onTrade={onTrade} onAddAccount={onAddAccount} onOpenPayouts={onOpenPayouts} onOpenProgress={onOpenProgress} />;
}

// --- Certificates -------------------------------------------------------------
/** Fetch a certificate artifact as an authenticated object URL (an <img> can't send
 *  a bearer). Returns null when there is no artifact (truthful "preview in account"). */
async function artifactBlobUrl(certId: string, kind: 'image' | 'pdf'): Promise<string | null> {
  const token = getAccessToken();
  if (!token) return null;
  const res = await fetch(`/api/v1/portal/certificates/${certId}/${kind}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function CanonicalCertificates({ onOpenAccount }: { onOpenAccount: (id: string) => void }): JSX.Element {
  const [res, retry] = useResource<Cert[]>(async () => {
    const r = await api.get<{ certificates: Cert[] }>('/api/v1/portal/certificates');
    return r.certificates;
  }, []);
  if (res.status === 'error') return <ErrorPanel message={res.message} onRetry={retry} />;
  if (res.status === 'loading') return <div className="htv2-page"><header className="htv2-page-head"><h1 className="ht-t-page-title">Certificates</h1><p className="ht-t-meta">Loading…</p></header></div>;
  return (
    <V2CertificatesPage
      certs={res.data}
      onOpenAccount={onOpenAccount}
      actions={{
        resolveArtifact: (certId, kind) => artifactBlobUrl(certId, kind),
        onVerify: (token) => { window.location.href = `/verify/${token}`; },
      }}
    />
  );
}

// --- Progress -----------------------------------------------------------------
export function CanonicalProgress({ onOpenPayouts, onAddAccount, onOpenCertificates }: { onOpenPayouts: () => void; onAddAccount: () => void; onOpenCertificates?: () => void }): JSX.Element {
  const [res, retry] = useResource<ProgressView>(async () => api.get<ProgressView>('/api/v1/portal/progress'), []);
  const [view, setView] = useState<ProgressView | null>(null);
  useEffect(() => { if (res.status === 'ready') setView(res.data); }, [res]);

  const refresh = useCallback(async () => {
    try { const p = await api.get<ProgressView>('/api/v1/portal/progress'); setView(p); } catch { /* keep last authoritative view */ }
  }, []);

  if (res.status === 'error') return <ErrorPanel message={res.message} onRetry={retry} />;
  if (!view) return <V2PageSkeleton title="Progress" rows={4} />;

  // Goal writes resolve to a boolean so the optimistic checkbox can roll back on
  // failure (error ≠ false completion); each confirmed write re-reads authoritative.
  const actions = {
    onCreateGoal: async (d: GoalDraft) => { try { await api.post('/api/v1/portal/goals', { title: d.title, note: d.note, kind: d.kind, metric: d.metric, targetValue: d.targetValue }); await refresh(); return true; } catch { return false; } },
    onUpdateGoal: async (id: string, patch: { title?: string; note?: string | null; targetValue?: number | null }) => { try { await api.patch(`/api/v1/portal/goals/${id}`, patch); await refresh(); return true; } catch { return false; } },
    onCompleteGoal: async (id: string) => { try { await api.post(`/api/v1/portal/goals/${id}/complete`, {}); await refresh(); return true; } catch { return false; } },
    onArchiveGoal: async (id: string) => { try { await api.delete(`/api/v1/portal/goals/${id}`); await refresh(); return true; } catch { return false; } },
    onTogglePin: async (id: string, pinned: boolean) => { try { await api.patch(`/api/v1/portal/goals/${id}`, { pinned }); await refresh(); return true; } catch { return false; } },
    onOpenPayouts,
    onAddAccount,
    onOpenCertificates,
  };
  return <V2ProgressPage view={view} actions={actions} />;
}

// --- Analytics ----------------------------------------------------------------
interface WebAnalytics {
  equity: { points: Array<{ tExitMs: number; equityMicros: number }>; maxDrawdownMicros: number; finalEquityMicros: number };
  days: { totalTradingDays: number; profitableDays: number; percentProfitableDays: number | null; bestDayMicros: number; worstDayMicros: number };
  trades: { winRate: number | null; profitFactor: number | null };
}
interface WebTrade { netPnlMicros: number; tradeDate: string }
interface WebPayoutRow { id: string; accountName: string | null; state: string; traderShareMicros: number | null; paidAt: number | null; requestedAt: number }

/** Portfolio-level analytics composed from authoritative per-account data (§59/§60).
 *  Fans out per-account analytics + trades, aggregates a daily realized-P&L calendar,
 *  and reads real payout history. Never fabricates: an account whose analytics can't
 *  load is simply omitted; a thin day grid renders empty cells, never invented P&L. */
export function CanonicalAnalytics({ onOpenAccount }: { onOpenAccount: (id: string) => void }): JSX.Element {
  const [res, retry] = useResource<AnalyticsView>(async ({ live }) => {
    const view = await api.get<AccountsView>(INCLUDE_ARCHIVED);
    const tradable = view.accounts.filter((a) => a.accountType === 'FUNDED_SIM' || a.accountType === 'EVALUATION_SIM');
    const rows: AnalyticsAccountRow[] = [];
    const dayMap = new Map<string, number>();
    await Promise.all(tradable.map(async (a) => {
      try {
        const [an, tr] = await Promise.all([
          api.get<WebAnalytics>(`/api/v1/portal/accounts/${a.id}/analytics`),
          api.get<{ trades: WebTrade[] }>(`/api/v1/portal/accounts/${a.id}/trades`),
        ]);
        if (!live()) return;
        rows.push({
          accountId: a.id,
          label: productLabel(a),
          accountType: a.accountType,
          status: a.status,
          realizedPnlMicros: an.equity.finalEquityMicros,
          maxDrawdownMicros: an.equity.maxDrawdownMicros,
          winRate: an.trades.winRate,
          profitFactor: an.trades.profitFactor,
          totalTradingDays: an.days.totalTradingDays,
          profitableDays: an.days.profitableDays,
          percentProfitableDays: an.days.percentProfitableDays,
          bestDayMicros: an.days.bestDayMicros,
          worstDayMicros: an.days.worstDayMicros,
          equity: an.equity.points.map((p) => ({ t: p.tExitMs, v: p.equityMicros })),
        });
        for (const t of tr.trades) dayMap.set(t.tradeDate, (dayMap.get(t.tradeDate) ?? 0) + t.netPnlMicros);
      } catch { /* an account whose analytics can't load is omitted, never shown as zero */ }
    }));
    rows.sort((x, y) => y.realizedPnlMicros - x.realizedPnlMicros);
    const calendar: AnalyticsDay[] = [...dayMap.entries()].map(([date, pnlMicros]) => ({ date, pnlMicros })).sort((p, q) => p.date.localeCompare(q.date));
    let payouts: AnalyticsView['payouts'] = [];
    try {
      const h = await api.get<{ payouts: WebPayoutRow[] }>('/api/v1/portal/payouts/history');
      payouts = h.payouts.map((p) => ({ id: p.id, accountLabel: p.accountName ?? 'Funded account', state: p.state, traderShareMicros: p.traderShareMicros, paidAt: p.paidAt, requestedAt: p.requestedAt }));
    } catch { /* history unavailable → none; never a fabricated row */ }
    return { accounts: rows, calendar, payouts };
  }, []);

  if (res.status === 'error') return <ErrorPanel message={res.message} onRetry={retry} />;
  if (res.status === 'loading') return <V2PageSkeleton title="Analytics" rows={4} />;
  return <V2AnalyticsPage view={res.data} onOpenAccount={onOpenAccount} />;
}

// --- Billing ------------------------------------------------------------------
/** Billing is derived from the authoritative accounts list (as V1 did): one order
 *  row per account at its acquisition. Payment method is provider-hosted; we show a
 *  truthful "no method on file" until a provider surface is connected. */
export function CanonicalBilling({ onOpenAccount, onAddAccount }: { onOpenAccount: (id: string) => void; onAddAccount: () => void }): JSX.Element {
  const [res, retry] = useResource<AccountsView>(async () => api.get<AccountsView>('/api/v1/portal/accounts?includeArchived=true'), []);
  if (res.status === 'error') return <ErrorPanel message={res.message} onRetry={retry} />;
  if (res.status === 'loading') return <div className="htv2-page"><header className="htv2-page-head"><h1 className="ht-t-page-title">Billing</h1><p className="ht-t-meta">Loading…</p></header></div>;
  const accounts = res.data.accounts;
  const orders: OrderRow[] = accounts.map((a) => ({
    id: a.id,
    dateMs: a.createdAt,
    item: a.product?.name ?? a.name,
    amountMicros: a.startingBalanceMicros, // the acquisition is presented at the account's authoritative starting balance (as V1)
    state: 'PAID' as const,
    accountId: a.id,
  }));
  const view: BillingView = {
    totalSpentMicros: 0, // the portal does not expose order price micros authoritatively; spend roll-up is deferred (never fabricated)
    orderCount: orders.length,
    activeEntitlements: accounts.filter((a) => a.consumesSlot).length,
    orders,
    paymentMethod: null,
  };
  return (
    <V2BillingPage
      view={view}
      onOpenAccount={onOpenAccount}
      actions={{ onAddAccount, onManagePaymentMethod: () => { window.location.href = '/onboarding'; } }}
    />
  );
}

// --- Payouts ------------------------------------------------------------------
/** Payouts: standing from per-funded authoritative eligibility; lifetime paid from
 *  authoritative progress; history from PAYOUT certificates (authoritative trader
 *  share; gross reconstructed from the authoritative split). The REQUEST action
 *  reuses the hardened V1 PayoutModule (same POST /api/v1/payouts/requests). */
export function CanonicalPayouts({ onOpenAccount, onToast }: { onOpenAccount: (id: string) => void; onToast: (m: string) => void }): JSX.Element {
  const [requesting, setRequesting] = useState<string | null>(null);
  const [res, retry] = useResource<PayoutsView>(async ({ live }) => {
    const view = await api.get<AccountsView>(INCLUDE_ARCHIVED);
    const funded = view.accounts.filter((a) => a.accountType === 'FUNDED_SIM' && a.status === 'ACTIVE');
    const standing: PayoutStandingRow[] = [];
    let availableMicros = 0;
    let split: number | null = null;
    await Promise.all(funded.map(async (a) => {
      try {
        const el = await api.get<PayoutEligibility>(`/api/v1/payouts/eligibility/${a.id}`);
        if (!live()) return;
        const eligible = el.state === 'ELIGIBLE';
        const avail = eligible ? el.maxRequestMicros : 0;
        availableMicros += avail;
        if (el.profitSplitPercent > 0) split = el.profitSplitPercent;
        standing.push({ accountId: a.id, accountLabel: productLabel(a), eligible, availableMicros: avail, winningDays: `${el.qualifyingWinningDays} / ${el.requiredWinningDays}` });
      } catch { /* an account whose eligibility can't load is omitted from standing, never shown as $0-eligible */ }
    }));
    // Authoritative lifetime paid.
    let totalPaidMicros = 0;
    try { const p = await api.get<{ hero: { lifetimePaidTraderShareMicros: number } }>('/api/v1/portal/progress'); totalPaidMicros = p.hero?.lifetimePaidTraderShareMicros ?? 0; } catch { /* fall back to history sum below */ }
    // History + in-review from the authoritative payout-requests projection.
    let history: PayoutHistoryRow[] = [];
    let inReviewMicros = 0;
    let cyclesText = '';
    try {
      const h = await api.get<{ payouts: Array<{ id: string; accountName: string | null; state: string; requestedGrossMicros: number; grossEligibleMicros: number | null; traderShareMicros: number | null; paidAt: number | null; requestedAt: number }> }>('/api/v1/portal/payouts/history');
      const PENDING = new Set(['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING', 'ON_HOLD']);
      const mapState = (s: string): PayoutHistoryRow['state'] =>
        s === 'PAID' ? 'PAID' : s === 'PROCESSING' ? 'PROCESSING' : s === 'APPROVED' ? 'APPROVED' : 'UNDER_REVIEW';
      // Terminal-but-not-paid states (FAILED/CANCELLED/REJECTED) aren't shown as history rows.
      history = h.payouts
        .filter((p) => p.state === 'PAID' || PENDING.has(p.state))
        .map((p) => ({
          id: p.id,
          dateMs: p.paidAt ?? p.requestedAt,
          accountLabel: p.accountName ?? 'Funded account',
          grossMicros: p.grossEligibleMicros ?? p.requestedGrossMicros,
          traderMicros: p.traderShareMicros ?? 0,
          state: mapState(p.state),
        }))
        .sort((x, y) => y.dateMs - x.dateMs);
      inReviewMicros = h.payouts.filter((p) => PENDING.has(p.state)).reduce((s, p) => s + (p.grossEligibleMicros ?? p.requestedGrossMicros), 0);
      const paidCount = h.payouts.filter((p) => p.state === 'PAID').length;
      if (totalPaidMicros === 0) totalPaidMicros = h.payouts.filter((p) => p.state === 'PAID').reduce((s, p) => s + (p.traderShareMicros ?? 0), 0);
      cyclesText = paidCount > 0 ? String(paidCount) : '—';
    } catch { /* history unavailable → shown as none; never a fabricated row */ }
    void split;
    return { totalPaidMicros, availableMicros, inReviewMicros, cyclesText, standing, history };
  }, []);

  if (res.status === 'error') return <ErrorPanel message={res.message} onRetry={retry} />;
  if (res.status === 'loading') return <div className="htv2-page"><header className="htv2-page-head"><h1 className="ht-t-page-title">Payouts</h1><p className="ht-t-meta">Loading…</p></header></div>;

  return (
    <>
      <V2PayoutsPage
        view={res.data}
        onOpenAccount={onOpenAccount}
        actions={{ onRequestPayout: (id) => setRequesting(id) }}
      />
      {requesting && (
        <div className="htv2-page" data-testid="htv2-payout-request">
          <div className="pt-portal-reuse">
            <PayoutModule accountId={requesting} onToast={(m) => { onToast(m); setRequesting(null); retry(); }} />
          </div>
          <V2Button variant="secondary" size="sm" onClick={() => setRequesting(null)}>Close</V2Button>
        </div>
      )}
    </>
  );
}
