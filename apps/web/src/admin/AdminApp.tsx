/**
 * The operator console.
 *
 * A separate experience from the trading terminal: its own shell, its own
 * navigation, none of the terminal's chrome, and lazily loaded so a trader
 * never downloads it. The terminal gains nothing admin-shaped in return -
 * that was the requirement, and it is also the only way either surface stays
 * legible.
 *
 * Routing is by pathname, kept deliberately small: four views and a detail
 * page do not need a router library.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { useSession } from '../state/session';
import { useChartStore } from '../state/chart-store';
import { adminApi } from './api';
import { AdminOverviewPage } from './pages/OverviewPage';
import { AdminUsersPage } from './pages/UsersPage';
import { AdminUserPage } from './pages/UserPage';
import { AdminAccountsPage } from './pages/AccountsPage';
import { AdminAccountPage } from './pages/AccountPage';
import { AdminProductsPage } from './pages/ProductsPage';
import { AdminProductPage } from './pages/ProductPage';
import { AdminTradingPage } from './pages/TradingPage';
import { AdminRiskPage } from './pages/RiskPage';
import { AdminFundingPage } from './pages/FundingPage';
import { AdminPayoutsPage } from './pages/PayoutsPage';
import { AdminEconomicsPage } from './pages/EconomicsPage';
import { AdminCustomersPage } from './pages/CustomersPage';
import { AdminAuditPage } from './pages/AuditPage';
import { AdminSystemPage } from './pages/SystemPage';
import { AdminInfraPage } from './pages/InfraPage';
import { AdminCertificateStorePage } from './pages/CertificateStorePage';
import { AdminEnforcementPage } from './pages/EnforcementPage';
import { AdminPayoutOperationsPage } from './pages/PayoutOperationsPage';
import { CommandCenterPage, OwnerSystemPage, StaffPage } from './pages/OwnerOsPages';
import { AffiliatesPage, Affiliate360Page } from './pages/AffiliatesPages';
import './Admin.css';

export type AdminRoute =
  | { name: 'COMMAND' }
  | { name: 'OWNER_SYSTEM' }
  | { name: 'STAFF' }
  | { name: 'OVERVIEW' }
  | { name: 'USERS' }
  | { name: 'USER'; id: string }
  | { name: 'ACCOUNTS' }
  | { name: 'ACCOUNT'; id: string }
  | { name: 'CUSTOMERS' }
  | { name: 'TRADING' }
  | { name: 'RISK' }
  | { name: 'FUNDING' }
  | { name: 'PAYOUTS' }
  | { name: 'ECONOMICS' }
  | { name: 'AUDIT' }
  | { name: 'PRODUCTS' }
  | { name: 'PRODUCT'; key: string }
  | { name: 'ENFORCEMENT' }
  | { name: 'PAYOUT_OPS' }
  | { name: 'SYSTEM' }
  | { name: 'INFRA' }
  | { name: 'CERTSTORE' }
  | { name: 'AFFILIATES' }
  | { name: 'AFFILIATE'; id: string };

export function parseAdminRoute(pathname: string): AdminRoute {
  const parts = pathname.replace(/^\/admin\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'command') return { name: 'COMMAND' };
  if (parts[0] === 'ops-system') return { name: 'OWNER_SYSTEM' };
  if (parts[0] === 'staff') return { name: 'STAFF' };
  // "traders" and "users" are the same directory - the owner vocabulary and the
  // schema vocabulary for the same people.
  if (parts[0] === 'users' || parts[0] === 'traders') {
    return parts[1] ? { name: 'USER', id: parts[1] } : { name: 'USERS' };
  }
  if (parts[0] === 'accounts') {
    return parts[1] ? { name: 'ACCOUNT', id: parts[1] } : { name: 'ACCOUNTS' };
  }
  if (parts[0] === 'customers') return { name: 'CUSTOMERS' };
  if (parts[0] === 'trading') return { name: 'TRADING' };
  if (parts[0] === 'risk') return { name: 'RISK' };
  if (parts[0] === 'funding') return { name: 'FUNDING' };
  if (parts[0] === 'payouts') return { name: 'PAYOUTS' };
  if (parts[0] === 'economics') return { name: 'ECONOMICS' };
  if (parts[0] === 'audit') return { name: 'AUDIT' };
  if (parts[0] === 'products') {
    return parts[1] ? { name: 'PRODUCT', key: decodeURIComponent(parts[1]) } : { name: 'PRODUCTS' };
  }
  if (parts[0] === 'enforcement') return { name: 'ENFORCEMENT' };
  if (parts[0] === 'payout-operations' || parts[0] === 'payout-ops') return { name: 'PAYOUT_OPS' };
  if (parts[0] === 'system') return { name: 'SYSTEM' };
  if (parts[0] === 'infrastructure' || parts[0] === 'infra') return { name: 'INFRA' };
  if (parts[0] === 'certificate-store' || parts[0] === 'certstore') return { name: 'CERTSTORE' };
  if (parts[0] === 'affiliates') {
    return parts[1] ? { name: 'AFFILIATE', id: parts[1] } : { name: 'AFFILIATES' };
  }
  return { name: 'OVERVIEW' };
}

export function adminPath(route: AdminRoute): string {
  switch (route.name) {
    case 'COMMAND':
      return '/admin/command';
    case 'OWNER_SYSTEM':
      return '/admin/ops-system';
    case 'STAFF':
      return '/admin/staff';
    case 'USERS':
      return '/admin/traders';
    case 'USER':
      return `/admin/traders/${route.id}`;
    case 'ACCOUNTS':
      return '/admin/accounts';
    case 'ACCOUNT':
      return `/admin/accounts/${route.id}`;
    case 'CUSTOMERS':
      return '/admin/customers';
    case 'TRADING':
      return '/admin/trading';
    case 'RISK':
      return '/admin/risk';
    case 'FUNDING':
      return '/admin/funding';
    case 'PAYOUTS':
      return '/admin/payouts';
    case 'ECONOMICS':
      return '/admin/economics';
    case 'AUDIT':
      return '/admin/audit';
    case 'PRODUCTS':
      return '/admin/products';
    case 'PRODUCT':
      return `/admin/products/${encodeURIComponent(route.key)}`;
    case 'ENFORCEMENT':
      return '/admin/enforcement';
    case 'PAYOUT_OPS':
      return '/admin/payout-operations';
    case 'SYSTEM':
      return '/admin/system';
    case 'INFRA':
      return '/admin/infrastructure';
    case 'CERTSTORE':
      return '/admin/certificate-store';
    case 'AFFILIATES':
      return '/admin/affiliates';
    case 'AFFILIATE':
      return `/admin/affiliates/${route.id}`;
    default:
      return '/admin';
  }
}

const NAV: ReadonlyArray<{ route: AdminRoute; label: string }> = [
  { route: { name: 'COMMAND' }, label: 'Command Center' },
  { route: { name: 'OVERVIEW' }, label: 'Overview' },
  { route: { name: 'USERS' }, label: 'Traders' },
  { route: { name: 'ACCOUNTS' }, label: 'Accounts' },
  { route: { name: 'CUSTOMERS' }, label: 'Customers' },
  { route: { name: 'TRADING' }, label: 'Trading' },
  { route: { name: 'RISK' }, label: 'Risk' },
  { route: { name: 'FUNDING' }, label: 'Funding' },
  { route: { name: 'PAYOUTS' }, label: 'Payouts' },
  { route: { name: 'AFFILIATES' }, label: 'Affiliates' },
  { route: { name: 'ENFORCEMENT' }, label: 'Enforcement' },
  { route: { name: 'PAYOUT_OPS' }, label: 'Payout Ops' },
  { route: { name: 'ECONOMICS' }, label: 'Economics' },
  { route: { name: 'AUDIT' }, label: 'Audit' },
  { route: { name: 'PRODUCTS' }, label: 'Products' },
  { route: { name: 'OWNER_SYSTEM' }, label: 'Ops System' },
  { route: { name: 'SYSTEM' }, label: 'System' },
  { route: { name: 'INFRA' }, label: 'Infrastructure' },
  { route: { name: 'STAFF' }, label: 'Staff & Access' },
  { route: { name: 'CERTSTORE' }, label: 'Certificate Store' },
];

export function AdminApp(): JSX.Element {
  const user = useSession((s) => s.user);
  const [route, setRoute] = useState<AdminRoute>(() => parseAdminRoute(window.location.pathname));

  // The browser's own back and forward buttons work, because an operator
  // reading five accounts in a row will use them.
  useEffect(() => {
    const onPop = (): void => setRoute(parseAdminRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((next: AdminRoute) => {
    window.history.pushState(null, '', adminPath(next));
    setRoute(next);
  }, []);

  const role = user?.role ?? (user?.isAdmin ? 'ADMIN' : 'TRADER');
  const mayMutate = role === 'ADMIN' || role === 'SUPER_ADMIN';

  /*
   * The server decides. This check keeps a trader from loading a console full
   * of empty tables and confusing error toasts; it is not what stops them
   * doing anything, which is `requireRole` on every route.
   */
  if (role === 'TRADER') {
    return (
      <div className="adm-denied">
        <h1>Atlas operations</h1>
        <p>This area is for operators. Your account does not have access.</p>
        <a href="/">Back to the terminal</a>
      </div>
    );
  }

  return (
    <div className="adm">
      <header className="adm-top">
        <a className="adm-brand" href="/admin" onClick={link(go, { name: 'OVERVIEW' })}>
          <span className="adm-mark" />
          ATLAS <span className="adm-brand-sub">operations</span>
        </a>
        <nav className="adm-nav">
          {NAV.map((entry) => (
            <a
              key={entry.label}
              href={adminPath(entry.route)}
              className={`adm-nav-item ${sameSection(route, entry.route) ? 'adm-nav-on' : ''}`}
              onClick={link(go, entry.route)}
            >
              {entry.label}
            </a>
          ))}
        </nav>
        <div className="adm-spacer" />
        <EnvBadge />
        <ThemeToggle />
        <span className="adm-role" title="Your role decides what you may do">
          {role.replace('_', ' ')}
        </span>
        <span className="adm-who">{user?.email}</span>
        <a className="adm-exit" href="/">
          Terminal
        </a>
      </header>

      <main className="adm-main">
        {route.name === 'COMMAND' ? <CommandCenterPage /> : null}
        {route.name === 'OWNER_SYSTEM' ? <OwnerSystemPage /> : null}
        {route.name === 'STAFF' ? <StaffPage /> : null}
        {route.name === 'OVERVIEW' ? <AdminOverviewPage go={go} /> : null}
        {route.name === 'USERS' ? <AdminUsersPage go={go} /> : null}
        {route.name === 'USER' ? <AdminUserPage id={route.id} go={go} /> : null}
        {route.name === 'ACCOUNTS' ? <AdminAccountsPage go={go} /> : null}
        {route.name === 'ACCOUNT' ? (
          <AdminAccountPage id={route.id} go={go} mayMutate={mayMutate} />
        ) : null}
        {route.name === 'CUSTOMERS' ? <AdminCustomersPage mayMutate={mayMutate} /> : null}
        {route.name === 'TRADING' ? <AdminTradingPage go={go} /> : null}
        {route.name === 'RISK' ? <AdminRiskPage go={go} /> : null}
        {route.name === 'FUNDING' ? <AdminFundingPage go={go} /> : null}
        {route.name === 'PAYOUTS' ? <AdminPayoutsPage go={go} mayMutate={mayMutate} /> : null}
        {route.name === 'ECONOMICS' ? <AdminEconomicsPage /> : null}
        {route.name === 'AUDIT' ? <AdminAuditPage go={go} /> : null}
        {route.name === 'PRODUCTS' ? <AdminProductsPage go={go} /> : null}
        {route.name === 'PRODUCT' ? (
          <AdminProductPage productKey={route.key} go={go} maySuper={role === 'SUPER_ADMIN'} />
        ) : null}
        {route.name === 'ENFORCEMENT' ? (
          <AdminEnforcementPage mayMutate={mayMutate} maySuper={role === 'SUPER_ADMIN'} />
        ) : null}
        {route.name === 'PAYOUT_OPS' ? (
          <AdminPayoutOperationsPage mayMutate={mayMutate} maySuper={role === 'SUPER_ADMIN'} />
        ) : null}
        {route.name === 'SYSTEM' ? <AdminSystemPage /> : null}
        {route.name === 'INFRA' ? <AdminInfraPage /> : null}
        {route.name === 'CERTSTORE' ? <AdminCertificateStorePage mayMutate={mayMutate} /> : null}
        {route.name === 'AFFILIATES' ? <AffiliatesPage go={go} /> : null}
        {route.name === 'AFFILIATE' ? <Affiliate360Page id={route.id} go={go} /> : null}
      </main>
    </div>
  );
}

function sameSection(current: AdminRoute, target: AdminRoute): boolean {
  if (current.name === target.name) return true;
  if (target.name === 'USERS' && current.name === 'USER') return true;
  if (target.name === 'ACCOUNTS' && current.name === 'ACCOUNT') return true;
  if (target.name === 'PRODUCTS' && current.name === 'PRODUCT') return true;
  return false;
}

/**
 * Dark/light toggle for the console. It reuses the platform theme engine
 * (`setTheme`) so the choice is the same one the terminal uses and applies to
 * the shared design tokens — no second, drifting palette. `themeMode` is set on
 * the document by `applyTheme`, so it reflects the truth even for custom themes.
 */
function ThemeToggle(): JSX.Element {
  const setTheme = useChartStore((s) => s.setTheme);
  const themeId = useChartStore((s) => s.themeId);
  const [light, setLight] = useState<boolean>(
    () => document.documentElement.dataset['themeMode'] === 'light',
  );
  useEffect(() => {
    setLight(document.documentElement.dataset['themeMode'] === 'light');
  }, [themeId]);
  return (
    <button
      type="button"
      className="adm-theme-toggle"
      data-testid="admin-theme-toggle"
      title={light ? 'Switch to dark' : 'Switch to light'}
      onClick={() => setTheme(light ? 'ATLAS_DARK' : 'CLEAN_LIGHT')}
    >
      {light ? '☾ Dark' : '☀ Light'}
    </button>
  );
}

/**
 * The environment badge. It is deliberately honest (M10 §107): the label comes
 * from the server's authoritative posture — the EXTERNAL_LIVE master gate — not
 * from a guess or a build constant. Until the gate is truly enabled the console
 * says SIMULATION, and it never renders a reassuring word it cannot back up.
 */
function EnvBadge(): JSX.Element {
  const [state, setState] = useState<'loading' | 'live' | 'sim' | 'unknown'>('loading');
  useEffect(() => {
    let cancelled = false;
    adminApi
      .infra()
      .then((d) => {
        if (!cancelled) setState(d.posture.externalLiveEnabled ? 'live' : 'sim');
      })
      .catch(() => {
        if (!cancelled) setState('unknown');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const label = state === 'live' ? 'LIVE' : state === 'sim' ? 'SIMULATION' : state === 'loading' ? '…' : 'ENV?';
  const tone = state === 'live' ? 'adm-env-live' : state === 'sim' ? 'adm-env-sim' : 'adm-env-unknown';
  return (
    <span className={`adm-env ${tone}`} data-testid="admin-env-badge" title="External-live master gate (server-authoritative)">
      {label}
    </span>
  );
}

/** A real link that navigates in place: middle-click and copy-link still work. */
function link(go: (route: AdminRoute) => void, route: AdminRoute) {
  return (event: React.MouseEvent): void => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    go(route);
  };
}
