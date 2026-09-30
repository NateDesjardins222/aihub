/**
 * Portal V2 — dev REVIEW shell (Portal V2 Scroll/Shell Hotfix).
 *
 * The coherent review entry Nathan opens at `/portal-v2` in a DEVELOPMENT build
 * (guarded by designLabEnabled() in App.tsx; falls through to a 404 in production).
 * Unlike the old harness (a component showcase with decorative dead navigation and
 * a hard-coded Owner Console), this is a REAL V2 shell with WORKING client-side
 * navigation between the V2 pages that actually exist today — Accounts (Phase 1)
 * and Account Detail with its tabs (Phase 2) — driven by the same presentational
 * components production will mount, using clearly-labelled DEV fixtures (there is no
 * session here). Nothing is faked as finished: only implemented destinations appear
 * in the nav; the design-system harness is a clearly dev-only sub-route.
 *
 * Owner Console is ROLE-GATED and defaults to OFF (a normal customer never sees it).
 * It appears only on an explicit dev opt-in (`?role=owner`) so the owner variant can
 * be reviewed without faking a production role. Server-side authorization is always
 * authoritative regardless of this UI.
 *
 * Vertical scrolling is owned by the workspace (see PORTAL_V2_SCROLL_ARCHITECTURE.md).
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { V2AppShell, type NavItem } from './Shell';
import { V2Root, V2Section, V2Card, V2Metric, V2FinancialValue, V2Button, V2Metal, V2EmptyState } from './primitives';
import { V2AccountsView } from './AccountsView';
import { V2AccountDetail, DETAIL_TABS, type DetailTab } from './AccountDetail';
import { PortalV2Harness } from './Harness';
import { FIXTURE_VIEW_LONG, fixtureDetailFor } from './fixtures';
import type { AccountDetailFull, AccountSummary } from '../lib';
import './tokens.css';
import './type.css';

const BASE = '/portal-v2';

/** Only destinations with a real, usable V2 implementation today. No fake breadth. */
export const REVIEW_NAV: readonly NavItem[] = [
  { key: 'home', label: 'Dashboard' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'design', label: 'Design system', status: 'dev' },
];

export type Route =
  | { view: 'home' }
  | { view: 'accounts' }
  | { view: 'detail'; id: string }
  | { view: 'design' }
  | { view: 'owner' };

export function parseRoute(pathname: string): Route {
  const p = pathname.replace(/\/+$/, '') || BASE;
  if (p === BASE) return { view: 'home' };
  if (p === `${BASE}/accounts`) return { view: 'accounts' };
  const m = /^\/portal-v2\/accounts\/(.+)$/.exec(p);
  if (m) return { view: 'detail', id: decodeURIComponent(m[1]!) };
  if (p === `${BASE}/dev/design-system`) return { view: 'design' };
  if (p === `${BASE}/owner`) return { view: 'owner' };
  return { view: 'home' };
}

function pathForNav(key: string): string {
  switch (key) {
    case 'home': return BASE;
    case 'accounts': return `${BASE}/accounts`;
    case 'design': return `${BASE}/dev/design-system`;
    case 'owner': return `${BASE}/owner`;
    default: return BASE;
  }
}

function activeKeyFor(route: Route): string {
  if (route.view === 'detail') return 'accounts';
  if (route.view === 'design') return 'design';
  return route.view;
}

export function PortalV2Review(): JSX.Element {
  const [pathname, setPathname] = useState(() =>
    typeof window === 'undefined' ? BASE : window.location.pathname,
  );
  const [tab, setTab] = useState<DetailTab>('overview');

  // Role gate: customer by default; Owner Console only on explicit dev opt-in.
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
      // A fresh page starts at the top of the workspace, never a trapped position.
      const ws = document.querySelector('.htv2-workspace');
      if (ws) ws.scrollTop = 0;
    }
  }, []);

  const route = parseRoute(pathname);
  const onNavigate = useCallback((key: string): void => go(pathForNav(key)), [go]);

  // The design-system harness brings its OWN shell — render it standalone so we
  // don't double-nest shells.
  if (route.view === 'design') return <PortalV2Harness />;

  const nav = REVIEW_NAV;
  let content: JSX.Element;
  let crumb: JSX.Element;

  if (route.view === 'accounts') {
    crumb = <span>Portal V2 · <strong>Accounts</strong></span>;
    content = (
      <V2AccountsView
        state={{ status: 'ready', view: FIXTURE_VIEW_LONG }}
        actions={{
          onOpen: (a: AccountSummary) => go(`${BASE}/accounts/${encodeURIComponent(a.id)}`),
          onGetAccount: () => go(BASE),
        }}
      />
    );
  } else if (route.view === 'detail') {
    const summary = FIXTURE_VIEW_LONG.accounts.find((a) => a.id === route.id);
    const detail: AccountDetailFull | null = summary ? fixtureDetailFor(summary) : null;
    crumb = <span>Portal V2 · Accounts · <strong>{summary?.product?.name ?? 'Account'}</strong></span>;
    content = detail ? (
      <V2AccountDetail
        state={{ status: 'ready', detail }}
        tab={tab}
        onTab={setTab}
        actions={{ onBack: () => go(`${BASE}/accounts`) }}
      />
    ) : (
      <V2AccountDetail state={{ status: 'not-found' }} tab={tab} onTab={setTab} actions={{ onBack: () => go(`${BASE}/accounts`) }} />
    );
  } else if (route.view === 'owner') {
    // Reached only via the role-gated Owner Console entry (dev `?role=owner`). This
    // is a truthful placeholder: the customer Portal V2 review does not implement an
    // owner surface — the real Owner Console is a separate app at /admin, server-
    // authorized. We never render a fake owner product here.
    crumb = <span>Portal V2 · <strong>Owner Console</strong></span>;
    content = (
      <V2EmptyState
        title="Owner Console is a separate application"
        hint="The operator console lives at /admin and is authorized server-side. It is not part of the customer Portal V2 review; this entry is shown only because the dev role override is active."
        action={<V2Button variant="secondary" size="sm" onClick={() => go(BASE)}>Back to review</V2Button>}
      />
    );
  } else {
    // Home / dashboard landing — a real, concise V2 landing (not a component dump).
    crumb = <span>Portal V2 · <strong>Review</strong></span>;
    const totalBalance = FIXTURE_VIEW_LONG.accounts.reduce((s, a) => s + a.balanceMicros, 0);
    content = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ht-space-8)' }}>
        <div>
          <div className="ht-t-page-title"><V2Metal>Happy Trader</V2Metal> — Portal V2</div>
          <p className="ht-t-body-sm" style={{ color: 'var(--ht-text-muted)', marginTop: 6 }}>
            Isolated V2 review environment · DEV ONLY — representative values, no live session.
          </p>
        </div>
        <V2Section title="Overview">
          <V2Card>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--ht-space-5)' }}>
              <V2Metric label="Accounts" value={String(FIXTURE_VIEW_LONG.accounts.length)} />
              <V2Metric label="Active slots" value={`${FIXTURE_VIEW_LONG.activeSlotsUsed} / ${FIXTURE_VIEW_LONG.maxActiveSlots}`} />
              <V2Metric label="Total balance" value={<V2FinancialValue tone="muted" size="md">{`$${Math.round(totalBalance / 1_000_000).toLocaleString()}`}</V2FinancialValue>} />
            </div>
          </V2Card>
        </V2Section>
        <V2Section title="Review the implemented V2 pages">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <V2Button variant="primary" onClick={() => go(`${BASE}/accounts`)}>Open Accounts →</V2Button>
            <V2Button variant="secondary" onClick={() => go(`${BASE}/dev/design-system`)}>Design system (dev)</V2Button>
          </div>
        </V2Section>
        <p className="ht-t-meta">
          Only implemented V2 destinations appear in the sidebar. Payouts, Certificates, Achievements,
          Billing and Support are not yet built in V2 and are intentionally omitted rather than shown as dead links.
        </p>
      </div>
    );
  }

  return (
    <V2Root>
      <V2AppShell
        active={activeKeyFor(route)}
        onNavigate={onNavigate}
        nav={nav}
        showOwner={showOwner}
        breadcrumb={crumb}
        utilities={<V2Button variant="secondary" size="sm">Account ▾</V2Button>}
      >
        {content}
      </V2AppShell>
    </V2Root>
  );
}
