/**
 * PortalV2App — the ONE canonical Happy Trader customer product (Portal Convergence
 * Phase 1).
 *
 * Mounted by App.tsx at `/portal`. It is the approved **V2 experience** (the
 * `V2AppShell` sidebar + V2 presentational pages) backed by the **hardened
 * authoritative customer core** (every figure from owner-scoped `/api/v1/*`; the
 * browser computes no business truth). It replaces the rejected horizontal-nav V1
 * shell as the customer product. `/portal-v2` remains a DEV-only review harness.
 *
 * Hardened invariants preserved:
 *  - Portal→Atlas handoff (§4A): Trade → `/?account=<publicId>`; the server re-checks
 *    ownership + status for THAT publicId — an account can never silently become another.
 *  - error ≠ zero (§4B): every container shows error/unknown on failure, never a
 *    fabricated zero/empty.
 *  - Owner Console (role-gated) lives ONLY in the account menu, never in customer nav.
 *  - Add Account always routes to the canonical purchase flow (/onboarding).
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useDocumentScroll } from '../lib/useDocumentScroll';
import { useSession } from '../state/session';
import { canAccessOwnerConsole } from '../lib/roles';
import { V2AppShell, V2AccountMenu, PORTAL_V2_NAV, type AccountMenuAction } from './v2/Shell';
import { V2AccountDetailContainer } from './v2/AccountDetailContainer';
import { V2SupportCenter } from './v2/support';
import { V2OwnerNotice } from './v2/pages';
import { type DetailTab } from './v2/AccountDetail';
import {
  CanonicalDashboard, CanonicalAccounts, CanonicalPayouts, CanonicalCertificates,
  CanonicalProgress, CanonicalBilling, CanonicalAnalytics,
} from './v2/containers';
import { CelebrationHost } from './v2/experience-celebration';
import { ProfilePage } from './pages/ProfilePage';
import { PayoutMethodsPage } from './pages/PayoutMethodsPage';
import './v2/tokens.css';
import './v2/type.css';
import './v2/experience.css';
import './Portal.css';

const BASE = '/portal';
const DETAIL_TABS: DetailTab[] = ['overview', 'performance', 'controls', 'rules', 'activity'];

type View =
  | { view: 'dashboard' } | { view: 'accounts' } | { view: 'detail'; id: string }
  | { view: 'payouts' } | { view: 'certificates' } | { view: 'progress' }
  | { view: 'analytics' }
  | { view: 'billing' } | { view: 'support' } | { view: 'profile' }
  | { view: 'payout-methods' } | { view: 'owner' };

function parseRoute(pathname: string): View {
  const p = pathname.replace(/\/+$/, '') || BASE;
  if (p === BASE) return { view: 'dashboard' };
  const m = /^\/portal\/accounts\/(.+)$/.exec(p);
  if (m) return { view: 'detail', id: decodeURIComponent(m[1]!) };
  if (p === `${BASE}/accounts`) return { view: 'accounts' };
  const simple = ['payouts', 'certificates', 'progress', 'analytics', 'billing', 'support', 'profile', 'payout-methods', 'owner'] as const;
  const key = p.slice(BASE.length + 1);
  if ((simple as readonly string[]).includes(key)) return { view: key } as View;
  return { view: 'dashboard' };
}

function navKeyFor(v: View): string {
  if (v.view === 'detail') return 'accounts';
  if (['profile', 'payout-methods', 'owner'].includes(v.view)) return '';
  return v.view;
}

export function PortalV2App(): JSX.Element {
  useDocumentScroll();
  const signOut = useSession((s) => s.signOut);
  const user = useSession((s) => s.user);
  const ownerConsole = canAccessOwnerConsole(user);

  const [pathname, setPathname] = useState(() => (typeof window === 'undefined' ? BASE : window.location.pathname));
  const [tab, setTab] = useState<DetailTab>(() => {
    const h = typeof window === 'undefined' ? '' : window.location.hash.replace('#', '');
    return DETAIL_TABS.includes(h as DetailTab) ? (h as DetailTab) : 'overview';
  });
  const [toast, setToast] = useState<string | null>(null);
  const showToast = useCallback((m: string) => { setToast(m); window.setTimeout(() => setToast(null), 2600); }, []);

  useEffect(() => {
    const onPop = (): void => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((to: string): void => {
    if (typeof window === 'undefined') return;
    if (window.location.pathname !== to) {
      window.history.pushState({}, '', to);
      setPathname(to);
      const ws = document.querySelector('.htv2-workspace');
      if (ws) ws.scrollTop = 0; else window.scrollTo(0, 0);
    }
  }, []);

  const route = parseRoute(pathname);
  const onNavigate = useCallback((key: string) => go(key === 'dashboard' ? BASE : `${BASE}/${key}`), [go]);
  const openAccount = useCallback((id: string) => go(`${BASE}/accounts/${encodeURIComponent(id)}`), [go]);
  // §4A: the hand-off is the publicId; the server re-checks ownership + status.
  const openTrade = useCallback((publicId: string) => { window.location.href = `/?account=${publicId}`; }, []);
  const addAccount = useCallback(() => { window.location.href = '/onboarding'; }, []);

  const accountActions: AccountMenuAction[] = useMemo(() => {
    const a: AccountMenuAction[] = [
      { key: 'profile', label: 'Profile & security', onSelect: () => go(`${BASE}/profile`) },
      { key: 'payout-methods', label: 'Payout methods', onSelect: () => go(`${BASE}/payout-methods`) },
      { key: 'add', label: 'Get another account', onSelect: addAccount },
    ];
    if (ownerConsole) a.push({ key: 'owner', label: 'Owner Console', tone: 'owner', onSelect: () => { window.location.href = '/admin'; } });
    a.push({ key: 'signout', label: 'Sign out', onSelect: () => void signOut() });
    return a;
  }, [go, addAccount, ownerConsole, signOut]);

  let content: JSX.Element;
  let crumb: string[];
  switch (route.view) {
    case 'accounts':
      crumb = ['Accounts'];
      content = <CanonicalAccounts onOpen={(a) => openAccount(a.id)} onTrade={(a) => openTrade(a.publicId)} onAddAccount={addAccount} />;
      break;
    case 'detail':
      crumb = ['Accounts', 'Account'];
      content = (
        <V2AccountDetailContainer
          accountId={route.id}
          tab={tab}
          onTab={(t) => { setTab(t); if (typeof window !== 'undefined') window.history.replaceState({}, '', `${BASE}/accounts/${encodeURIComponent(route.id)}#${t}`); }}
          onBack={() => go(`${BASE}/accounts`)}
        />
      );
      break;
    case 'payouts':
      crumb = ['Payouts'];
      content = <CanonicalPayouts onOpenAccount={openAccount} onToast={showToast} />;
      break;
    case 'certificates':
      crumb = ['Certificates'];
      content = <CanonicalCertificates onOpenAccount={openAccount} />;
      break;
    case 'progress':
      crumb = ['Progress'];
      content = <CanonicalProgress onOpenPayouts={() => go(`${BASE}/payouts`)} onAddAccount={addAccount} onOpenCertificates={() => go(`${BASE}/certificates`)} />;
      break;
    case 'analytics':
      crumb = ['Analytics'];
      content = <CanonicalAnalytics onOpenAccount={openAccount} />;
      break;
    case 'billing':
      crumb = ['Billing'];
      content = <CanonicalBilling onOpenAccount={openAccount} onAddAccount={addAccount} />;
      break;
    case 'support':
      crumb = ['Support'];
      content = <V2SupportCenter />;
      break;
    case 'profile':
      crumb = ['Profile & security'];
      content = <div className="htv2-page"><div className="pt-portal-reuse"><ProfilePage section="profile" onToast={showToast} /></div></div>;
      break;
    case 'payout-methods':
      crumb = ['Payout methods'];
      content = <div className="htv2-page"><div className="pt-portal-reuse"><PayoutMethodsPage onToast={showToast} /></div></div>;
      break;
    case 'owner':
      crumb = ['Owner Console'];
      content = <V2OwnerNotice onBack={() => go(BASE)} onOpenAdmin={() => { window.location.href = '/admin'; }} />;
      break;
    default:
      crumb = ['Dashboard'];
      content = <CanonicalDashboard onOpenAccount={openAccount} onTrade={openTrade} onAddAccount={addAccount} onOpenPayouts={() => go(`${BASE}/payouts`)} onOpenProgress={() => go(`${BASE}/progress`)} />;
  }

  return (
    <div className="htv2" data-testid="portal-app">
      <V2AppShell
        active={navKeyFor(route)}
        onNavigate={onNavigate}
        nav={PORTAL_V2_NAV}
        breadcrumb={<span>Portal · {crumb.map((t, i) => (<span key={t}>{i === crumb.length - 1 ? <strong>{t}</strong> : <>{t} · </>}</span>))}</span>}
        utilities={<V2AccountMenu label={user?.email ?? 'Account'} actions={accountActions} />}
      >
        {/* A fast page transition on route change (§18): keyed remount → rise + fade. */}
        <div key={route.view === 'detail' ? `detail:${route.id}` : route.view} className="htv2-page-transition">
          {content}
        </div>
      </V2AppShell>
      {toast && <div className="pt-toast" role="status" data-testid="pt-toast">{toast}</div>}
      {/* Authoritative, idempotent, owner-scoped milestone celebrations (§22–26). */}
      <CelebrationHost actions={{ onOpenAccount: openAccount, onOpenCertificates: () => go(`${BASE}/certificates`) }} />
    </div>
  );
}
