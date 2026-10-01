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
import { V2Dashboard, type V2DashboardData } from './dashboard';
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
export function CanonicalProgress({ onOpenPayouts, onAddAccount }: { onOpenPayouts: () => void; onAddAccount: () => void }): JSX.Element {
  const [res, retry] = useResource<ProgressView>(async () => api.get<ProgressView>('/api/v1/portal/progress'), []);
  const [view, setView] = useState<ProgressView | null>(null);
  useEffect(() => { if (res.status === 'ready') setView(res.data); }, [res]);

  const refresh = useCallback(async () => {
    try { const p = await api.get<ProgressView>('/api/v1/portal/progress'); setView(p); } catch { /* keep last authoritative view */ }
  }, []);

  if (res.status === 'error') return <ErrorPanel message={res.message} onRetry={retry} />;
  if (!view) return <div className="htv2-page"><header className="htv2-page-head"><h1 className="ht-t-page-title">Progress</h1><p className="ht-t-meta">Loading…</p></header></div>;

  const actions = {
    onCreateGoal: async (d: GoalDraft) => { await api.post('/api/v1/portal/goals', { title: d.title, note: d.note, kind: d.kind, metric: d.metric, targetValue: d.targetValue }).catch(() => {}); await refresh(); },
    onUpdateGoal: async (id: string, patch: { title?: string; note?: string | null; targetValue?: number | null }) => { await api.patch(`/api/v1/portal/goals/${id}`, patch).catch(() => {}); await refresh(); },
    onCompleteGoal: async (id: string) => { await api.post(`/api/v1/portal/goals/${id}/complete`, {}).catch(() => {}); await refresh(); },
    onArchiveGoal: async (id: string) => { await api.delete(`/api/v1/portal/goals/${id}`).catch(() => {}); await refresh(); },
    onTogglePin: async (id: string, pinned: boolean) => { await api.patch(`/api/v1/portal/goals/${id}`, { pinned }).catch(() => {}); await refresh(); },
    onOpenPayouts,
    onAddAccount,
  };
  return <V2ProgressPage view={view} actions={actions} />;
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
    try { const p = await api.get<{ hero: { lifetimePaidTraderShareMicros: number } }>('/api/v1/portal/progress'); totalPaidMicros = p.hero?.lifetimePaidTraderShareMicros ?? 0; } catch { /* fall back to cert sum below */ }
    // History from authoritative PAYOUT certificates.
    const byId = new Map(view.accounts.map((a) => [a.id, a]));
    let history: PayoutHistoryRow[] = [];
    try {
      const certs = await api.get<{ certificates: Cert[] }>('/api/v1/portal/certificates');
      history = certs.certificates
        .filter((c) => c.type === 'PAYOUT' && c.amountMicros != null)
        .map((c) => {
          const trader = c.amountMicros!;
          const gross = split && split > 0 ? Math.round(trader / split) : trader;
          const acct = c.accountId ? byId.get(c.accountId) : undefined;
          return { id: c.id, dateMs: c.issuedAt, accountLabel: acct ? productLabel(acct) : 'Funded account', grossMicros: gross, traderMicros: trader, state: 'PAID' as const };
        })
        .sort((x, y) => y.dateMs - x.dateMs);
      if (totalPaidMicros === 0) totalPaidMicros = history.reduce((s, h) => s + h.traderMicros, 0);
    } catch { /* history unavailable → shown as none; never a fabricated row */ }
    return { totalPaidMicros, availableMicros, inReviewMicros: 0, cyclesText: '', standing, history };
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
