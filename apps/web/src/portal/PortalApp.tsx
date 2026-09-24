/*
 * Happy Trader customer portal (V2) — the trader-facing home beside Atlas.
 *
 * A premium, server-authoritative business/account/performance/control center.
 * Every figure is read from owner-scoped /api/v1/portal routes; the browser never
 * computes a balance, a status, a payout, or enforces risk. This shell owns the
 * navigation, the global account switcher, the theme, and pathname routing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../api/client';
import { useSession } from '../state/session';
import { usePortalTheme } from './theme';
import { type AccountsView, type AccountSummary, familyOf, money, msg, tone } from './lib';
import { DashboardPage } from './pages/DashboardPage';
import { AccountsPage } from './pages/AccountsPage';
import { AccountDetailPage } from './pages/AccountDetailPage';
import { PayoutsPage } from './pages/PayoutsPage';
import { CertificatesPage } from './pages/CertificatesPage';
import { AchievementsPage } from './pages/AchievementsPage';
import { BillingPage } from './pages/BillingPage';
import { SupportPage } from './pages/SupportPage';
import { ProfilePage } from './pages/ProfilePage';
import './Portal.css';

export type Route =
  | { name: 'dashboard' }
  | { name: 'accounts' }
  | { name: 'account'; id: string; tab: string }
  | { name: 'payouts' }
  | { name: 'certificates' }
  | { name: 'achievements' }
  | { name: 'billing' }
  | { name: 'support' }
  | { name: 'profile' }
  | { name: 'verification' }
  | { name: 'security' }
  | { name: 'notifications' };

const ACCOUNT_TABS = ['overview', 'performance', 'controls', 'rules', 'activity'];

export function parseRoute(pathname: string, hash: string): Route {
  const parts = pathname.replace(/^\/portal\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'accounts' && parts[1]) {
    const tab = ACCOUNT_TABS.includes(hash.replace('#', '')) ? hash.replace('#', '') : 'overview';
    return { name: 'account', id: parts[1], tab };
  }
  if (parts[0] === 'accounts') return { name: 'accounts' };
  const simple = ['payouts', 'certificates', 'achievements', 'billing', 'support', 'profile', 'verification', 'security', 'notifications'] as const;
  if (simple.includes(parts[0] as (typeof simple)[number])) return { name: parts[0] } as Route;
  return { name: 'dashboard' };
}

export function routePath(r: Route): string {
  switch (r.name) {
    case 'dashboard': return '/portal';
    case 'account': return `/portal/accounts/${r.id}#${r.tab}`;
    default: return `/portal/${r.name}`;
  }
}

const NAV: Array<{ name: Route['name']; label: string }> = [
  { name: 'dashboard', label: 'Dashboard' },
  { name: 'accounts', label: 'Accounts' },
  { name: 'payouts', label: 'Payouts' },
  { name: 'certificates', label: 'Certificates' },
  { name: 'achievements', label: 'Achievements' },
  { name: 'billing', label: 'Billing' },
  { name: 'support', label: 'Support' },
];

const SEL_KEY = 'ht.portal.account';

export function PortalApp(): JSX.Element {
  const signOut = useSession((s) => s.signOut);
  const user = useSession((s) => s.user);
  const { theme, toggle } = usePortalTheme();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname, window.location.hash));
  const [accounts, setAccounts] = useState<AccountsView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try { return window.localStorage.getItem(SEL_KEY); } catch { return null; }
  });
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((m: string) => { setToast(m); window.setTimeout(() => setToast(null), 2600); }, []);

  const go = useCallback((next: Route) => {
    window.history.pushState(null, '', routePath(next));
    setRoute(next);
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onPop = (): void => setRoute(parseRoute(window.location.pathname, window.location.hash));
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('hashchange', onPop); };
  }, []);

  const loadAccounts = useCallback(() => {
    void api.get<AccountsView>('/api/v1/portal/accounts').then(setAccounts).catch(() => setAccounts({ accounts: [], activeSlotsUsed: 0, maxActiveSlots: 5 }));
  }, []);
  useEffect(loadAccounts, [loadAccounts]);

  const activeAccounts = useMemo(() => (accounts?.accounts ?? []).filter((a) => a.consumesSlot), [accounts]);
  const selected = useMemo(() => {
    const list = accounts?.accounts ?? [];
    return list.find((a) => a.id === selectedId) ?? activeAccounts[0] ?? list[0] ?? null;
  }, [accounts, selectedId, activeAccounts]);

  const selectAccount = useCallback((id: string) => {
    setSelectedId(id);
    try { window.localStorage.setItem(SEL_KEY, id); } catch { /* ignore */ }
  }, []);

  const tradable = selected?.status === 'ACTIVE' && (selected.accountType === 'EVALUATION' || selected.accountType === 'FUNDED_SIM');
  const openAtlas = useCallback(() => {
    if (selected) window.location.href = `/?account=${selected.publicId}`;
  }, [selected]);

  return (
    <div className="pt" data-testid="portal-app">
      <header className="pt-top">
        <a className="pt-brand" href="/portal" onClick={link(go, { name: 'dashboard' })}>
          <span className="pt-mark" aria-hidden />
          Happy Trader <span className="g">Funding</span>
        </a>
        <nav className="pt-nav" aria-label="Primary">
          {NAV.map((n) => (
            <a
              key={n.name}
              data-testid={`pt-nav-${n.name}`}
              href={routePath({ name: n.name } as Route)}
              className={route.name === n.name || (n.name === 'accounts' && route.name === 'account') ? 'on' : ''}
              onClick={link(go, { name: n.name } as Route)}
            >
              {n.label}
            </a>
          ))}
        </nav>
        <div className="pt-spacer" />
        <AccountSwitcher accounts={activeAccounts} selected={selected} onSelect={selectAccount} onView={(id) => go({ name: 'account', id, tab: 'overview' })} onGetAnother={() => { window.location.href = '/onboarding'; }} slots={accounts} />
        <button className="pt-trade" data-testid="pt-trade" disabled={!tradable} onClick={openAtlas} title={tradable ? 'Open Atlas with this account' : 'This account is not trade-enabled'}>
          Trade →
        </button>
        <button className="pt-iconbtn" data-testid="pt-theme-toggle" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title="Toggle theme">
          {theme === 'dark' ? '☾' : '☀'}
        </button>
        <ProfileMenu email={user?.email ?? ''} onGo={go} onSignOut={() => void signOut()} />
      </header>

      <main className="pt-main">
        {route.name === 'dashboard' && <DashboardPage accounts={accounts} onOpen={(id) => go({ name: 'account', id, tab: 'overview' })} onNav={(n) => go({ name: n } as Route)} />}
        {route.name === 'accounts' && <AccountsPage onOpen={(id) => go({ name: 'account', id, tab: 'overview' })} onToast={showToast} onChanged={loadAccounts} />}
        {route.name === 'account' && <AccountDetailPage accountId={route.id} tab={route.tab} onTab={(t) => go({ name: 'account', id: route.id, tab: t })} onBack={() => go({ name: 'accounts' })} onToast={showToast} />}
        {route.name === 'payouts' && <PayoutsPage accounts={activeAccounts} selectedId={selected?.id ?? null} onToast={showToast} />}
        {route.name === 'certificates' && <CertificatesPage onToast={showToast} />}
        {route.name === 'achievements' && <AchievementsPage onToast={showToast} />}
        {route.name === 'billing' && <BillingPage accounts={accounts} />}
        {route.name === 'support' && <SupportPage />}
        {(route.name === 'profile' || route.name === 'verification' || route.name === 'security' || route.name === 'notifications') && (
          <ProfilePage section={route.name} onToast={showToast} />
        )}
      </main>

      {toast && <div className="pt-toast" role="status" data-testid="pt-toast">{toast}</div>}
    </div>
  );
}

function AccountSwitcher({
  accounts, selected, onSelect, onView, onGetAnother, slots,
}: {
  accounts: AccountSummary[]; selected: AccountSummary | null;
  onSelect: (id: string) => void; onView: (id: string) => void; onGetAnother: () => void;
  slots: AccountsView | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  return (
    <div className="pt-switcher" onClick={(e) => e.stopPropagation()}>
      <button className="pt-switcher-btn" data-testid="pt-switcher" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}>
        <span>
          <div className="sw-name">{selected ? selected.nickname || selected.name : 'No account'}</div>
          <div className="sw-sub">{selected ? `${familyOf(selected.product?.key)} · ${money(selected.balanceMicros)}` : '—'}</div>
        </span>
        <span className="sw-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="pt-menu" role="listbox" data-testid="pt-switcher-menu">
          {accounts.length === 0 && <div className="pt-menu-foot pt-note">No active accounts.</div>}
          {accounts.map((a) => {
            const net = a.balanceMicros - a.startingBalanceMicros;
            return (
              <button key={a.id} className={`pt-menu-item${selected?.id === a.id ? ' on' : ''}`} role="option" aria-selected={selected?.id === a.id}
                onClick={() => { onSelect(a.id); setOpen(false); }}>
                <span className="mi-name">{a.nickname || a.name}</span>
                <span className="mi-bal num">{money(a.balanceMicros)}</span>
                <span className="mi-sub">{familyOf(a.product?.key)} · {a.status === 'ACTIVE' ? 'Active' : a.status}</span>
                <span className={`mi-pnl num ${tone(net)}`}>{money(net, { sign: true })}</span>
              </button>
            );
          })}
          <div className="pt-menu-sep" />
          <div className="pt-menu-foot pt-row">
            <span className="pt-note" style={{ margin: 0 }}>{slots ? `${slots.activeSlotsUsed} / ${slots.maxActiveSlots} active` : ''}</span>
            {selected && <button className="pt-link" onClick={() => { onView(selected.id); setOpen(false); }}>View account</button>}
          </div>
          <div className="pt-menu-foot">
            <button className="pt-link" onClick={onGetAnother}>+ Get another account</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProfileMenu({ email, onGo, onSignOut }: { email: string; onGo: (r: Route) => void; onSignOut: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  const initial = (email[0] ?? '?').toUpperCase();
  const items: Array<[Route['name'], string]> = [
    ['profile', 'Profile'], ['verification', 'Verification'], ['security', 'Security'], ['notifications', 'Notifications'],
  ];
  return (
    <div className="pt-switcher" onClick={(e) => e.stopPropagation()}>
      <button className="pt-iconbtn" data-testid="pt-profile" onClick={() => setOpen((v) => !v)} aria-label="Profile menu" style={{ borderRadius: '50%' }}>{initial}</button>
      {open && (
        <div className="pt-menu" style={{ minWidth: 200 }}>
          <div className="pt-menu-foot pt-note" style={{ margin: 0 }}>{email}</div>
          <div className="pt-menu-sep" />
          {items.map(([n, label]) => (
            <button key={n} className="pt-menu-item" onClick={() => { onGo({ name: n } as Route); setOpen(false); }}>
              <span className="mi-name">{label}</span>
            </button>
          ))}
          <div className="pt-menu-sep" />
          <button className="pt-menu-item" onClick={onSignOut}><span className="mi-name">Log out</span></button>
        </div>
      )}
    </div>
  );
}

/** A real link that navigates in place; middle-click / copy-link still work. */
function link(go: (r: Route) => void, r: Route) {
  return (e: React.MouseEvent): void => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(r);
  };
}
