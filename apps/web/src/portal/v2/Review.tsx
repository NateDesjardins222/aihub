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
  V2Section, V2Button, V2StatStrip, V2Attention, V2ActivityList, V2Divider,
} from './primitives';
import { V2AccountsView } from './AccountsView';
import { V2AccountPanel } from './AccountPanel';
import { V2AccountDetail, type DetailTab } from './AccountDetail';
import { V2PayoutsPage, V2CertificatesPage, V2BillingPage, V2SupportPage, V2OwnerNotice } from './pages';
import { toAccountView, productLabel } from './account-view';
import {
  FIXTURE_VIEW_LONG, fixtureDetailFor, FIXTURE_FUNDED_EXTRA,
  FIXTURE_PAYOUTS, FIXTURE_CERTS, FIXTURE_BILLING, FIXTURE_SUPPORT, FIXTURE_ACTIVITY,
} from './fixtures';
import { formatMoney } from './format';
import type { AccountDetailFull, AccountSummary } from '../lib';
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

const ACCTS = FIXTURE_VIEW_LONG.accounts;
const extraFor = (a: AccountSummary) => FIXTURE_FUNDED_EXTRA[a.id];

export function PortalV2Review(): JSX.Element {
  const [pathname, setPathname] = useState(() =>
    typeof window === 'undefined' ? BASE : window.location.pathname,
  );
  const [tab, setTab] = useState<DetailTab>('overview');

  const showOwner = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('role') === 'owner';
  }, [pathname]);

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

  // The account menu: real actions. Owner Console (owners only) lives HERE, never in nav.
  const accountActions: AccountMenuAction[] = [];
  if (showOwner) accountActions.push({ key: 'owner', label: 'Owner Console', tone: 'owner', onSelect: () => go(`${BASE}/owner`) });
  accountActions.push({ key: 'signout', label: 'Sign out', onSelect: () => { window.location.href = '/'; } });

  let content: JSX.Element;
  let crumb: JSX.Element;

  if (route.view === 'accounts') {
    crumb = <Crumb trail={['Accounts']} />;
    content = (
      <V2AccountsView
        state={{ status: 'ready', view: FIXTURE_VIEW_LONG }}
        extraFor={extraFor}
        actions={{
          onOpen: (a) => openAccount(a.id),
          onTrade: (a) => openTrade(a.publicId),
          onGetAccount: () => { window.location.href = '/'; },
        }}
      />
    );
  } else if (route.view === 'detail') {
    const summary = ACCTS.find((a) => a.id === route.id);
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
    content = <V2PayoutsPage view={FIXTURE_PAYOUTS} onOpenAccount={openAccount} />;
  } else if (route.view === 'certificates') {
    crumb = <Crumb trail={['Certificates']} />;
    content = <V2CertificatesPage certs={FIXTURE_CERTS} onOpenAccount={openAccount} />;
  } else if (route.view === 'billing') {
    crumb = <Crumb trail={['Billing']} />;
    content = <V2BillingPage view={FIXTURE_BILLING} onOpenAccount={openAccount} />;
  } else if (route.view === 'support') {
    crumb = <Crumb trail={['Support']} />;
    content = <V2SupportPage view={FIXTURE_SUPPORT} />;
  } else if (route.view === 'owner') {
    crumb = <Crumb trail={['Owner Console']} />;
    content = <V2OwnerNotice onBack={() => go(BASE)} onOpenAdmin={() => { window.location.href = '/admin'; }} />;
  } else {
    crumb = <Crumb trail={['Dashboard']} />;
    content = <Dashboard onOpenAccount={openAccount} onTrade={openTrade} go={go} />;
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
function Dashboard({ onOpenAccount, onTrade, go }: {
  onOpenAccount: (id: string) => void;
  onTrade: (publicId: string) => void;
  go: (to: string) => void;
}): JSX.Element {
  const isEval = (a: AccountSummary): boolean => a.portalState.startsWith('EVALUATION');
  const isFunded = (a: AccountSummary): boolean => a.accountType === 'FUNDED_SIM' && !a.portalState.startsWith('COMPLETED');
  const activeCount = ACCTS.filter((a) => ['PENDING', 'ACTIVE', 'GOAL_REACHED', 'LOCKED'].includes(a.status)).length;
  const totalBalance = ACCTS.reduce((s, a) => s + a.balanceMicros, 0);
  const netPnl = ACCTS.reduce((s, a) => s + (a.balanceMicros - a.startingBalanceMicros), 0);
  const breached = ACCTS.filter((a) => a.portalState === 'FAILED');
  const topAccounts = ACCTS.filter((a) => a.portalState !== 'ARCHIVED' && a.portalState !== 'INACTIVE_CLOSED').slice(0, 4);
  const payoutAvailable = FIXTURE_PAYOUTS.availableMicros;

  return (
    <div className="htv2-page">
      <header className="htv2-page-head">
        <h1 className="ht-t-page-title">Dashboard</h1>
        <p className="ht-t-meta">Your accounts, standing, and what needs attention.</p>
      </header>

      <V2StatStrip
        items={[
          { label: 'Total balance', value: formatMoney(totalBalance, { maxFractionDigits: 0 }) },
          { label: 'Net P&L', value: formatMoney(netPnl, { sign: true, maxFractionDigits: 0 }), tone: netPnl > 0 ? 'positive' : netPnl < 0 ? 'negative' : 'muted' },
          { label: 'Active accounts', value: String(activeCount) },
          { label: 'Evaluations', value: String(ACCTS.filter(isEval).length) },
          { label: 'Funded', value: String(ACCTS.filter(isFunded).length) },
          { label: 'Total paid', value: formatMoney(FIXTURE_PAYOUTS.totalPaidMicros, { maxFractionDigits: 0 }) },
        ]}
      />

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

      <V2Section
        title="Your accounts"
        actions={<button className="htv2-link ht-t-nav" onClick={() => go(`${BASE}/accounts`)}>All accounts →</button>}
      >
        <div className="htv2-acct-grid">
          {topAccounts.map((a) => (
            <V2AccountPanel
              key={a.id}
              a={toAccountView(a, extraFor(a))}
              onDetails={() => onOpenAccount(a.id)}
              onTrade={() => onTrade(a.publicId)}
            />
          ))}
        </div>
      </V2Section>

      <V2Section title="Recent activity" actions={<button className="htv2-link ht-t-nav" onClick={() => go(`${BASE}/payouts`)}>Payout history →</button>}>
        <V2ActivityList items={FIXTURE_ACTIVITY} />
      </V2Section>

      <V2Divider />
    </div>
  );
}
