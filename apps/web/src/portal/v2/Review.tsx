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
  V2Section, V2Button, V2StatStrip, V2Attention, V2ActivityList, V2Divider, V2AreaChart, V2EmptyState,
} from './primitives';
import { V2AccountsView } from './AccountsView';
import { V2AccountPanel } from './AccountPanel';
import { V2AccountDetail, type DetailTab } from './AccountDetail';
import { V2PayoutsPage, V2CertificatesPage, V2BillingPage, V2SupportPage, V2OwnerNotice } from './pages';
import { V2ProfilePage } from './profile';
import { toAccountView, productLabel } from './account-view';
import {
  FIXTURE_VIEW_LONG, fixtureDetailFor, FIXTURE_FUNDED_EXTRA,
  FIXTURE_PAYOUTS, FIXTURE_CERTS, FIXTURE_BILLING, FIXTURE_SUPPORT, FIXTURE_ACTIVITY,
  FIXTURE_PORTFOLIO_SERIES, FIXTURE_PROFILE,
  FIXTURE_VIEW_EMPTY_CUSTOMER, FIXTURE_PAYOUTS_EMPTY, FIXTURE_BILLING_EMPTY,
  FIXTURE_SUPPORT_EMPTY, FIXTURE_PROFILE_EMPTY,
} from './fixtures';
import { formatMoney } from './format';
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
  { key: 'billing', label: 'Billing' },
  { key: 'support', label: 'Support' },
];

export type Route =
  | { view: 'dashboard' }
  | { view: 'accounts' }
  | { view: 'detail'; id: string }
  | { view: 'payouts' }
  | { view: 'certificates' }
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
        series: [], profile: FIXTURE_PROFILE_EMPTY, extraFor: () => undefined,
      }
    : {
        accountsView: FIXTURE_VIEW_LONG, payouts: FIXTURE_PAYOUTS, certs: FIXTURE_CERTS,
        billing: FIXTURE_BILLING, support: FIXTURE_SUPPORT, activity: FIXTURE_ACTIVITY,
        series: FIXTURE_PORTFOLIO_SERIES, profile: FIXTURE_PROFILE, extraFor,
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
          // Dev review has no session, so the authenticated artifact endpoint is not
          // called — the card shows a truthful "preview available in your account" state.
          // Production wires this to GET /api/v1/portal/certificates/:id/{image,pdf}.
          resolveArtifact: async () => null,
          onVerify: (token) => { window.location.href = `/verify/${token}`; },
        }}
      />
    );
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
    content = <V2SupportPage view={data.support} />;
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

/** Portfolio-level cumulative realized P&L (authoritative series in production; dev
 *  fixture here). Range buttons slice the same series — never fabricate new points.
 *  An empty/short series shows a truthful empty state, never a drawn-in line. */
function PortfolioPerformance({ series: full }: { series: SeriesPoint[] }): JSX.Element {
  const RANGES: Array<{ key: string; days: number | null }> = [
    { key: '30D', days: 30 }, { key: '90D', days: 90 }, { key: 'All', days: null },
  ];
  const [range, setRange] = useState('90D');
  const days = RANGES.find((r) => r.key === range)!.days;
  const series = days == null ? full : full.slice(-days);
  const last = series[series.length - 1]?.v ?? 0;
  const hasSeries = full.length >= 2;
  return (
    <V2Section
      title="Portfolio performance"
      actions={hasSeries ? (
        <span className="htv2-chart-ranges">
          {RANGES.map((r) => (
            <button key={r.key} className={`htv2-chart-range${range === r.key ? ' on' : ''}`} onClick={() => setRange(r.key)}>{r.key}</button>
          ))}
        </span>
      ) : undefined}
    >
      <div className="htv2-chart-frame">
        {hasSeries ? (
          <>
            <div className="htv2-chart-caption">
              <span className="ht-t-label">Cumulative realized P&amp;L</span>
              <span className={`ht-t-fin-md ht-num htv2-tone-${last > 0 ? 'positive' : last < 0 ? 'negative' : 'muted'}`}>
                {formatMoney(last, { sign: true, maxFractionDigits: 0 })}
              </span>
            </div>
            <V2AreaChart points={series} height={160} ariaLabel="Portfolio cumulative realized P&L" />
          </>
        ) : (
          <p className="htv2-chart-empty ht-t-body-sm">No trading history yet. Your performance appears here once you place your first trades.</p>
        )}
      </div>
    </V2Section>
  );
}
