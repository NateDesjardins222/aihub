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
import { AdminAuditPage } from './pages/AuditPage';
import { AdminSystemPage } from './pages/SystemPage';
import './Admin.css';

export type AdminRoute =
  | { name: 'OVERVIEW' }
  | { name: 'USERS' }
  | { name: 'USER'; id: string }
  | { name: 'ACCOUNTS' }
  | { name: 'ACCOUNT'; id: string }
  | { name: 'TRADING' }
  | { name: 'RISK' }
  | { name: 'FUNDING' }
  | { name: 'PAYOUTS' }
  | { name: 'ECONOMICS' }
  | { name: 'AUDIT' }
  | { name: 'PRODUCTS' }
  | { name: 'PRODUCT'; key: string }
  | { name: 'SYSTEM' };

export function parseAdminRoute(pathname: string): AdminRoute {
  const parts = pathname.replace(/^\/admin\/?/, '').split('/').filter(Boolean);
  // "traders" and "users" are the same directory - the owner vocabulary and the
  // schema vocabulary for the same people.
  if (parts[0] === 'users' || parts[0] === 'traders') {
    return parts[1] ? { name: 'USER', id: parts[1] } : { name: 'USERS' };
  }
  if (parts[0] === 'accounts') {
    return parts[1] ? { name: 'ACCOUNT', id: parts[1] } : { name: 'ACCOUNTS' };
  }
  if (parts[0] === 'trading') return { name: 'TRADING' };
  if (parts[0] === 'risk') return { name: 'RISK' };
  if (parts[0] === 'funding') return { name: 'FUNDING' };
  if (parts[0] === 'payouts') return { name: 'PAYOUTS' };
  if (parts[0] === 'economics') return { name: 'ECONOMICS' };
  if (parts[0] === 'audit') return { name: 'AUDIT' };
  if (parts[0] === 'products') {
    return parts[1] ? { name: 'PRODUCT', key: decodeURIComponent(parts[1]) } : { name: 'PRODUCTS' };
  }
  if (parts[0] === 'system') return { name: 'SYSTEM' };
  return { name: 'OVERVIEW' };
}

export function adminPath(route: AdminRoute): string {
  switch (route.name) {
    case 'USERS':
      return '/admin/traders';
    case 'USER':
      return `/admin/traders/${route.id}`;
    case 'ACCOUNTS':
      return '/admin/accounts';
    case 'ACCOUNT':
      return `/admin/accounts/${route.id}`;
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
    case 'SYSTEM':
      return '/admin/system';
    default:
      return '/admin';
  }
}

const NAV: ReadonlyArray<{ route: AdminRoute; label: string }> = [
  { route: { name: 'OVERVIEW' }, label: 'Overview' },
  { route: { name: 'USERS' }, label: 'Traders' },
  { route: { name: 'ACCOUNTS' }, label: 'Accounts' },
  { route: { name: 'TRADING' }, label: 'Trading' },
  { route: { name: 'RISK' }, label: 'Risk' },
  { route: { name: 'FUNDING' }, label: 'Funding' },
  { route: { name: 'PAYOUTS' }, label: 'Payouts' },
  { route: { name: 'ECONOMICS' }, label: 'Economics' },
  { route: { name: 'AUDIT' }, label: 'Audit' },
  { route: { name: 'PRODUCTS' }, label: 'Products' },
  { route: { name: 'SYSTEM' }, label: 'System' },
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
        <span className="adm-role" title="Your role decides what you may do">
          {role.replace('_', ' ')}
        </span>
        <span className="adm-who">{user?.email}</span>
        <a className="adm-exit" href="/">
          Terminal
        </a>
      </header>

      <main className="adm-main">
        {route.name === 'OVERVIEW' ? <AdminOverviewPage go={go} /> : null}
        {route.name === 'USERS' ? <AdminUsersPage go={go} /> : null}
        {route.name === 'USER' ? <AdminUserPage id={route.id} go={go} /> : null}
        {route.name === 'ACCOUNTS' ? <AdminAccountsPage go={go} /> : null}
        {route.name === 'ACCOUNT' ? (
          <AdminAccountPage id={route.id} go={go} mayMutate={mayMutate} />
        ) : null}
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
        {route.name === 'SYSTEM' ? <AdminSystemPage /> : null}
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

/** A real link that navigates in place: middle-click and copy-link still work. */
function link(go: (route: AdminRoute) => void, route: AdminRoute) {
  return (event: React.MouseEvent): void => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    go(route);
  };
}
