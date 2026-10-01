/**
 * Portal V2 — dev REVIEW shell (rebuilt at human-rejection #1).
 *
 * The coherent review entry Nathan opens at `/portal-v2` in a DEVELOPMENT build
 * (gated by designLabEnabled() in App.tsx; a production build 404s). It is a REAL,
 * sharp, institutional customer portal with WORKING client-side navigation across
 * every destination the sidebar shows — Dashboard, Accounts, Account Detail,
 * Payouts, Certificates, Billing, Support — driven by the same presentational
 * components production mounts, using clearly dev-only fixtures (there is no session
 * here).
 *
 * HARD invariants from the human rejection:
 *  - the brand is the supplied Happy Trader Funding wordmark (no fake square);
 *  - the customer never sees a Design system / DEV entry, a component/status/lifecycle
 *    showcase, or any engineering language — all of that was removed;
 *  - every visible sidebar destination and control actually works (no dead links);
 *  - Owner Console is NEVER in customer navigation — it lives only in the account
 *    menu, owner-only, behind the dev `?role=owner` override; server stays authoritative.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { V2AppShell, V2AccountMenu, type NavItem, type AccountMenuAction } from './Shell';
import {
  V2Section, V2Button, V2StatStrip, V2Attention, V2ActivityList, V2Divider, V2EmptyState,
} from './primitives';
import { V2AccountsView } from './AccountsView';
import { V2AccountPanel } from './AccountPanel';
import { V2AccountDetail, type DetailTab } from './AccountDetail';
import { V2PayoutsPage, V2CertificatesPage, V2BillingPage, V2OwnerNotice } from './pages';
import { V2ProfilePage } from './profile';
import {
  V2ProgressPage, type ProgressView, type GoalView, type GoalDraft,
} from './progress-page';
import { V2SupportCenter } from './support';
import { sampleArtifactFor } from './cert-samples';
import { toAccountView, productLabel, type AccountViewExtra } from './account-view';
import {
  FIXTURE_VIEW_LONG, fixtureDetailFor, FIXTURE_FUNDED_EXTRA,
  FIXTURE_PAYOUTS, FIXTURE_CERTS, FIXTURE_BILLING, FIXTURE_SUPPORT, FIXTURE_ACTIVITY,
  FIXTURE_PORTFOLIO_SERIES, FIXTURE_PROFILE,
  FIXTURE_VIEW_EMPTY_CUSTOMER, FIXTURE_PAYOUTS_EMPTY, FIXTURE_BILLING_EMPTY,
  FIXTURE_SUPPORT_EMPTY, FIXTURE_PROFILE_EMPTY,
  FIXTURE_PROGRESS, FIXTURE_PROGRESS_EMPTY,
} from './fixtures';
import { formatMoney } from './format';
import { V2PerfChart } from './perf-chart';
import type { SeriesPoint, ActivityItem } from './primitives';
import type { AccountsView, AccountDetailFull, AccountSummary, Cert } from '../lib';
import type { PayoutsView, BillingView, SupportView } from './pages';
import type { ProfileView } from './profile';
import './tokens.css';
import './type.css';

const BASE = '/portal-v2';

/** Only destinations with a real, working V2 implementation. No dev tooling, no dead links. */
export const REVIEW_NAV: readonly NavItem[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'payouts', label: 'Payouts' },
  { key: 'certificates', label: 'Certificates' },
  { key: 'progress', label: 'Progress' },
  { key: 'billing', label: 'Billing' },
  { key: 'support', label: 'Support' },
];

export type Route =
  | { view: 'dashboard' }
  | { view: 'accounts' }
  | { view: 'detail'; id: string }
  | { view: 'payouts' }
  | { view: 'certificates' }
  | { view: 'progress' }
  | { view: 'billing' }
  | { view: 'support' }
  | { view: 'profile' }
  | { view: 'owner' };

export function parseRoute(pathname: string): Route {
  const p = pathname.replace(/\/+$/, '') || BASE;
  if (p === BASE) return { view: 'dashboard' };
  if (p === `${BASE}/accounts`) return { view: 'accounts' };
  const m = /^\/portal-v2\/accounts\/(.+)$/.exec(p);
  if (m) return { view: 'detail', id: decodeURIComponent(m[1]!) };
  if (p === `${BASE}/payouts`) return { view: 'payouts' };
  if (p === `${BASE}/certificates`) return { view: 'certificates' };
  if (p === `${BASE}/progress`) return { view: 'progress' };
  if (p === `${BASE}/billing`) return { view: 'billing' };
  if (p === `${BASE}/support`) return { view: 'support' };
  if (p === `${BASE}/profile`) return { view: 'profile' };
  if (p === `${BASE}/owner`) return { view: 'owner' };
  return { view: 'dashboard' }; // unknown sub-paths → dashboard, never a blank/trapped screen
}

function pathForNav(key: string): string {
  return key === 'dashboard' ? BASE : `${BASE}/${key}`;
}

function activeKeyFor(route: Route): string {
  if (route.view === 'detail') return 'accounts';
  if (route.view === 'owner') return '';
  return route.view;
}

const extraFor = (a: AccountSummary) => FIXTURE_FUNDED_EXTRA[a.id];

/** The projected data the review renders — swapped wholesale for the zero-customer mode. */
interface PortalData {
  accountsView: AccountsView;
  payouts: PayoutsView;
  certs: Cert[];
  billing: BillingView;
  support: SupportView;
  activity: ActivityItem[];
  series: SeriesPoint[];
  profile: ProfileView;
  progress: ProgressView;
  extraFor: (a: AccountSummary) => ReturnType<typeof extraFor>;
}

export function PortalV2Review(): JSX.Element {
  const [pathname, setPathname] = useState(() =>
    typeof window === 'undefined' ? BASE : window.location.pathname,
  );
  const [tab, setTab] = useState<DetailTab>('overview');

  const showOwner = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('role') === 'owner';
  }, [pathname]);

  // ZERO-CUSTOMER review mode (`?state=empty`): a brand-new customer with no business
  // records. Every surface must truthfully show zeros/empty states — never demo data.
  const empty = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('state') === 'empty';
  }, [pathname]);

  const data = useMemo((): PortalData => (empty
    ? {
        accountsView: FIXTURE_VIEW_EMPTY_CUSTOMER, payouts: FIXTURE_PAYOUTS_EMPTY, certs: [],
        billing: FIXTURE_BILLING_EMPTY, support: FIXTURE_SUPPORT_EMPTY, activity: [],
        series: [], profile: FIXTURE_PROFILE_EMPTY, progress: FIXTURE_PROGRESS_EMPTY, extraFor: () => undefined,
      }
    : {
        accountsView: FIXTURE_VIEW_LONG, payouts: FIXTURE_PAYOUTS, certs: FIXTURE_CERTS,
        billing: FIXTURE_BILLING, support: FIXTURE_SUPPORT, activity: FIXTURE_ACTIVITY,
        series: FIXTURE_PORTFOLIO_SERIES, profile: FIXTURE_PROFILE, progress: FIXTURE_PROGRESS, extraFor,
      }), [empty]);

  useEffect(() => {
    const onPop = (): void => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((to: string): void => {
    if (typeof window === 'undefined') return;
    const full = window.location.search ? `${to}${window.location.search}` : to;
    if (window.location.pathname !== to) {
      window.history.pushState({}, '', full);
      setPathname(to);
      const ws = document.querySelector('.htv2-workspace');
      if (ws) ws.scrollTop = 0;
    }
  }, []);

  const route = parseRoute(pathname);
  const onNavigate = useCallback((key: string): void => go(pathForNav(key)), [go]);
  const openAccount = useCallback((id: string): void => go(`${BASE}/accounts/${encodeURIComponent(id)}`), [go]);
  const openTrade = useCallback((publicId: string): void => { window.location.href = `/?account=${publicId}`; }, []);
  // Add account → the legitimate existing purchase flow (hosted at the app root). The
  // review routes to it rather than fabricating a purchase (see PORTAL_V2_DATA_TRUTH_MAP.md).
  const addAccount = useCallback((): void => { window.location.href = '/'; }, []);

  // The account menu: real actions. Profile/Account center lives in this utility
  // surface (not primary nav). Owner Console (owners only) also lives HERE, never in nav.
  const accountActions: AccountMenuAction[] = [];
  accountActions.push({ key: 'profile', label: 'Profile & security', onSelect: () => go(`${BASE}/profile`) });
  if (showOwner) accountActions.push({ key: 'owner', label: 'Owner Console', tone: 'owner', onSelect: () => go(`${BASE}/owner`) });
  accountActions.push({ key: 'signout', label: 'Sign out', onSelect: () => { window.location.href = '/'; } });

  let content: JSX.Element;
  let crumb: JSX.Element;

  if (route.view === 'accounts') {
    crumb = <Crumb trail={['Accounts']} />;
    content = (
      <V2AccountsView
        state={{ status: 'ready', view: data.accountsView }}
        extraFor={data.extraFor}
        actions={{
          onOpen: (a) => openAccount(a.id),
          onTrade: (a) => openTrade(a.publicId),
          onGetAccount: addAccount,
        }}
      />
    );
  } else if (route.view === 'detail') {
    const summary = data.accountsView.accounts.find((a) => a.id === route.id);
    const detail: AccountDetailFull | null = summary ? fixtureDetailFor(summary) : null;
    crumb = <Crumb trail={['Accounts', summary ? productLabel(summary) : 'Account']} />;
    content = detail ? (
      <V2AccountDetail
        state={{ status: 'ready', detail }}
        tab={tab}
        onTab={setTab}
        actions={{ onBack: () => go(`${BASE}/accounts`), onTrade: (d) => openTrade(d.publicId) }}
      />
    ) : (
      <V2AccountDetail state={{ status: 'not-found' }} tab={tab} onTab={setTab} actions={{ onBack: () => go(`${BASE}/accounts`) }} />
    );
  } else if (route.view === 'payouts') {
    crumb = <Crumb trail={['Payouts']} />;
    content = (
      <V2PayoutsPage
        view={data.payouts}
        onOpenAccount={openAccount}
        actions={{ onRequestPayout: (id) => openAccount(id) }}
      />
    );
  } else if (route.view === 'certificates') {
    crumb = <Crumb trail={['Certificates']} />;
    content = (
      <V2CertificatesPage
        certs={data.certs}
        onOpenAccount={openAccount}
        actions={{
          // Dev review has no session, so it serves the REAL rendered artwork produced by
          // the production certificate renderer (captured as dev-review samples; see
          // cert-samples.ts). Production wires this to the authenticated endpoint
          // GET /api/v1/portal/certificates/:id/{image,pdf}.
          resolveArtifact: async (certId) => {
            const cert = data.certs.find((c) => c.id === certId);
            return cert ? sampleArtifactFor(cert.type) : null;
          },
          onVerify: (token) => { window.location.href = `/verify/${token}`; },
        }}
      />
    );
  } else if (route.view === 'progress') {
    crumb = <Crumb trail={['Progress']} />;
    content = <ProgressReview initial={data.progress} onOpenPayouts={() => go(`${BASE}/payouts`)} onAddAccount={addAccount} />;
  } else if (route.view === 'billing') {
    crumb = <Crumb trail={['Billing']} />;
    content = (
      <V2BillingPage
        view={data.billing}
        onOpenAccount={openAccount}
        actions={{
          onAddAccount: addAccount,
          // Payment-method management is a provider-hosted flow (card data never touches
          // our origin). Receipts are server/provider-rendered; neither is fabricated in
          // the dev review — see PORTAL_V2_BILLING_ARCHITECTURE.md.
          onManagePaymentMethod: () => { window.location.href = '/onboarding'; },
        }}
      />
    );
  } else if (route.view === 'support') {
    crumb = <Crumb trail={['Support']} />;
    // Support is a REAL, authoritative surface wired to /api/v1/support (not a fixture).
    content = <V2SupportCenter />;
  } else if (route.view === 'profile') {
    crumb = <Crumb trail={['Profile & security']} />;
    content = (
      <V2ProfilePage
        view={data.profile}
        onBack={() => go(BASE)}
        onManageSecurity={() => { window.location.href = '/onboarding'; }}
        onManageVerification={() => { window.location.href = '/onboarding'; }}
      />
    );
  } else if (route.view === 'owner') {
    crumb = <Crumb trail={['Owner Console']} />;
    content = <V2OwnerNotice onBack={() => go(BASE)} onOpenAdmin={() => { window.location.href = '/admin'; }} />;
  } else {
    crumb = <Crumb trail={['Dashboard']} />;
    content = <Dashboard data={data} onOpenAccount={openAccount} onTrade={openTrade} onAddAccount={addAccount} go={go} />;
  }

  return (
    <div className="htv2">
      <V2AppShell
        active={activeKeyFor(route)}
        onNavigate={onNavigate}
        nav={REVIEW_NAV}
        breadcrumb={crumb}
        utilities={<V2AccountMenu label="Account" actions={accountActions} />}
      >
        {content}
      </V2AppShell>
    </div>
  );
}

function Crumb({ trail }: { trail: string[] }): JSX.Element {
  return (
    <span>
      Portal · {trail.map((t, i) => (
        <span key={t}>{i === trail.length - 1 ? <strong>{t}</strong> : <>{t} · </>}</span>
      ))}
    </span>
  );
}

// ----------------------------------------------------------------- Progress ----
/**
 * Dev-review container for the Progress & Achievements surface. The dev harness has
 * no session, so goal CRUD runs over LOCAL React state seeded from the fixture —
 * exactly as the other V2 surfaces use fixtures in review. Production mounts
 * V2ProgressPage against the authoritative endpoints (GET /api/v1/portal/progress
 * and the /api/v1/portal/goals CRUD); nothing here is persisted or shown as truth.
 */
function ProgressReview({ initial, onOpenPayouts, onAddAccount }: {
  initial: ProgressView;
  onOpenPayouts: () => void;
  onAddAccount: () => void;
}): JSX.Element {
  const [goals, setGoals] = useState<GoalView[]>(initial.goals);
  const view: ProgressView = { ...initial, goals };

  const actions = {
    onCreateGoal: (d: GoalDraft) => {
      const g: GoalView = {
        id: `g-${Math.random().toString(36).slice(2, 9)}`,
        title: d.title, note: d.note, kind: d.kind, metric: d.metric, targetValue: d.targetValue,
        // Tracked goals derive progress from authoritative data in production; the
        // dev harness shows 0 against the chosen target until a server would fill it.
        currentValue: d.kind === 'TRACKED' ? 0 : null,
        status: 'ACTIVE', pinned: false, completedAt: null, createdAt: Date.now(),
      };
      setGoals((gs) => [g, ...gs]);
    },
    onUpdateGoal: (id: string, patch: { title?: string; note?: string | null; targetValue?: number | null }) =>
      setGoals((gs) => gs.map((g) => (g.id === id ? { ...g, ...patch } : g))),
    onCompleteGoal: (id: string) =>
      setGoals((gs) => gs.map((g) => (g.id === id && g.kind === 'MANUAL' ? { ...g, status: 'COMPLETED' as const, pinned: false, completedAt: Date.now() } : g))),
    onArchiveGoal: (id: string) => setGoals((gs) => gs.filter((g) => g.id !== id)),
    onTogglePin: (id: string, pinned: boolean) => {
      setGoals((gs) => {
        const pinnedCount = gs.filter((g) => g.pinned && g.status === 'ACTIVE').length;
        if (pinned && pinnedCount >= 3) return gs; // mirror the server pin ceiling
        return gs.map((g) => (g.id === id ? { ...g, pinned } : g));
      });
    },
    onOpenPayouts,
    onAddAccount,
  };

  return <V2ProgressPage view={view} actions={actions} />;
}

// ----------------------------------------------------------------- Dashboard ----
function Dashboard({ data, onOpenAccount, onTrade, onAddAccount, go }: {
  data: PortalData;
  onOpenAccount: (id: string) => void;
  onTrade: (publicId: string) => void;
  onAddAccount: () => void;
  go: (to: string) => void;
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
          action={<V2Button variant="secondary" size="sm" onClick={() => go(`${BASE}/accounts`)}>Review</V2Button>}
        />
      ) : payoutAvailable > 0 ? (
        <V2Attention
          tone="positive"
          title={`${formatMoney(payoutAvailable)} available to withdraw`}
          detail="One of your funded accounts is eligible for a payout."
          action={<V2Button variant="secondary" size="sm" onClick={() => go(`${BASE}/payouts`)}>Payouts</V2Button>}
        />
      ) : null}

      {topAccounts.length > 0 && (
        <V2Section
          title="Your accounts"
          actions={<button className="htv2-link ht-t-nav" onClick={() => go(`${BASE}/accounts`)}>All accounts →</button>}
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

      {accts.length > 0 && <NextUp accounts={accts} extraFor={data.extraFor} onOpenAccount={onOpenAccount} go={go} />}

      {(data.progress.hero.lifetimePaidTraderShareMicros > 0 || data.progress.hero.achievementsEarned > 0) && (
        <V2Section title="Your journey" actions={<button className="htv2-link ht-t-nav" onClick={() => go(`${BASE}/progress`)} data-testid="htv2-dash-journey">Open journey →</button>}>
          <div className="htv2-dash-journey" data-testid="htv2-dash-journey-strip">
            <div className="htv2-dash-journey-lead htv2-aura htv2-aura-on">
              <span className="ht-t-label">Paid to you, lifetime</span>
              <span className="ht-t-fin-lg ht-num htv2-metal-champagne">{formatMoney(data.progress.hero.lifetimePaidTraderShareMicros, { maxFractionDigits: 0 })}</span>
            </div>
            <div className="htv2-dash-journey-meta">
              {data.progress.hero.currentClub && <span className="ht-t-body-sm">Member of the <strong>{data.progress.hero.currentClub === 'HUNDREDK_CLUB' ? '$100K' : data.progress.hero.currentClub === 'FIFTYK_CLUB' ? '$50K' : '$10K'} Club</strong></span>}
              {data.progress.hero.nextClub && (
                <span className="ht-t-meta htv2-tone-muted">
                  {formatMoney(data.progress.hero.nextClub.remainingMicros, { maxFractionDigits: 0 })} to the next club
                </span>
              )}
              <span className="ht-t-meta htv2-tone-muted">{data.progress.hero.achievementsEarned} milestone{data.progress.hero.achievementsEarned === 1 ? '' : 's'} earned</span>
            </div>
          </div>
        </V2Section>
      )}

      {accts.length > 0 && <PortfolioPerformance series={data.series} />}

      {data.activity.length > 0 && (
        <V2Section title="Recent activity" actions={<button className="htv2-link ht-t-nav" onClick={() => go(`${BASE}/payouts`)}>Payout history →</button>}>
          <V2ActivityList items={data.activity} />
        </V2Section>
      )}

      <V2Divider />
    </div>
  );
}

/** Portfolio-level cumulative realized P&L — a REAL interactive chart (human-review #3).
 *  The caller supplies ONE authoritative cumulative series (micro-dollars); ranges slice
 *  it (never fabricate points) and companion metrics are derived from the same data. An
 *  empty/short series shows a truthful empty state, never a drawn-in line. */
function PortfolioPerformance({ series: full }: { series: SeriesPoint[] }): JSX.Element {
  const hasSeries = full.length >= 2;
  const spanDays = hasSeries ? (full[full.length - 1]!.t - full[0]!.t) / 86_400_000 : 0;
  const ranges = useMemo(() => {
    const all: Array<{ key: string; days: number | null }> = [
      { key: '7D', days: 7 }, { key: '30D', days: 30 }, { key: '90D', days: 90 },
      { key: 'YTD', days: null }, { key: 'All', days: null },
    ];
    // Only offer a fixed-window range when the data actually spans it.
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

/** "Progress & payout readiness" — answers "what am I closest to?" and "can I withdraw?"
 *  from authoritative account state, as compact clickable rows (no giant cards, no casino
 *  rings). Evaluations show target progress; funded accounts show winning days + available. */
function NextUp({ accounts, extraFor, onOpenAccount, go }: {
  accounts: AccountSummary[];
  extraFor: (a: AccountSummary) => AccountViewExtra | undefined;
  onOpenAccount: (id: string) => void;
  go: (to: string) => void;
}): JSX.Element | null {
  const evals = accounts.filter((a) => a.portalState === 'EVALUATION_ACTIVE');
  const funded = accounts.filter((a) => a.accountType === 'FUNDED_SIM' && a.portalState === 'FUNDED_ACTIVE');
  if (evals.length === 0 && funded.length === 0) return null;
  return (
    <V2Section title="Progress & payout readiness" actions={<button className="htv2-link ht-t-nav" onClick={() => go(`${BASE}/payouts`)}>Payouts →</button>}>
      <div className="htv2-nextup">
        {evals.map((a) => {
          const v = toAccountView(a, extraFor(a));
          const achieved = a.balanceMicros - a.startingBalanceMicros;
          const remaining = Math.max(0, (a.profitTargetMicros ?? 0) - achieved);
          const mll = v.metrics.find((m) => m.label === 'MLL room');
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

/** Derive companion metrics from a cumulative series. Daily deltas come from the FULL
 *  series (so the window's first day's delta is correct); the window is the visible slice. */
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
