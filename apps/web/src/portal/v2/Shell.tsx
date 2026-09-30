/**
 * V2AppShell / V2Sidebar / V2TopBar (Product Rebuild Phase 0, STEP 11/12).
 *
 * The upcoming Portal architecture: a compact left sidebar + a compact top
 * utility bar + a main workspace — an APPLICATION layout, not the current
 * website-style horizontal nav. Dimensions come from tokens (`--ht-sidebar-w`,
 * `--ht-topbar-h`) so they can be tuned during Nathan's review without a hunt.
 *
 * This is the shell CONTRACT for the rebuild; it renders in the dev harness only.
 * Active state is a subtle surface — never an underline, a purple bar, or a giant
 * pill. Owner Console is role-gated (shown only when `showOwner`).
 */
import type { JSX, ReactNode } from 'react';
import './Shell.css';

export interface NavItem { key: string; label: string; /** marks a development-only destination */ status?: 'dev'; }

export const PORTAL_V2_NAV: readonly NavItem[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'payouts', label: 'Payouts' },
  { key: 'certificates', label: 'Certificates' },
  { key: 'achievements', label: 'Achievements' },
  { key: 'billing', label: 'Billing' },
  { key: 'support', label: 'Support' },
];

export function V2Sidebar({ active, onNavigate, showOwner = false, nav = PORTAL_V2_NAV }: {
  active: string;
  onNavigate?: (key: string) => void;
  showOwner?: boolean;
  /** The destinations to render; defaults to the full design list. A real shell
   *  should pass only destinations that have a usable implementation. */
  nav?: readonly NavItem[];
}): JSX.Element {
  return (
    <aside className="htv2-side" aria-label="Primary">
      <div className="htv2-side-brand">
        <span className="htv2-side-mark" aria-hidden />
        <span className="htv2-side-name ht-t-nav">Happy Trader</span>
      </div>
      <nav className="htv2-side-nav">
        {nav.map((n) => (
          <button
            key={n.key}
            type="button"
            className={`htv2-side-link ht-t-nav${active === n.key ? ' is-active' : ''}`}
            aria-current={active === n.key ? 'page' : undefined}
            onClick={() => onNavigate?.(n.key)}
          >
            {n.label}
            {n.status === 'dev' && <span className="htv2-side-tag">dev</span>}
          </button>
        ))}
        {showOwner && (
          <button
            type="button"
            className={`htv2-side-link htv2-side-owner ht-t-nav${active === 'owner' ? ' is-active' : ''}`}
            onClick={() => onNavigate?.('owner')}
          >
            Owner Console
          </button>
        )}
      </nav>
    </aside>
  );
}

export function V2TopBar({ breadcrumb, utilities }: { breadcrumb?: ReactNode; utilities?: ReactNode }): JSX.Element {
  return (
    <header className="htv2-top">
      <div className="htv2-top-crumb ht-t-meta">{breadcrumb}</div>
      <div className="htv2-top-util">{utilities}</div>
    </header>
  );
}

export function V2AppShell({ active, onNavigate, showOwner, nav, breadcrumb, utilities, children }: {
  active: string;
  onNavigate?: (key: string) => void;
  showOwner?: boolean;
  nav?: readonly NavItem[];
  breadcrumb?: ReactNode;
  utilities?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="htv2-shell">
      <V2Sidebar active={active} onNavigate={onNavigate} showOwner={showOwner} nav={nav} />
      <div className="htv2-shell-main">
        <V2TopBar breadcrumb={breadcrumb} utilities={utilities} />
        <main className="htv2-workspace">
          <div className="htv2-workspace-inner">{children}</div>
        </main>
      </div>
    </div>
  );
}
