/**
 * V2AppShell / V2Sidebar / V2TopBar / V2AccountMenu.
 *
 * The customer Portal application layout: a compact left sidebar (brand wordmark +
 * real destinations) + a compact top utility bar + a scrolling workspace. Rebuilt
 * at human-rejection #1 to a sharper, institutional, trading-workstation language.
 *
 * HARD invariants proven by human feedback:
 *  - the brand is the SUPPLIED Happy Trader Funding wordmark image (no fake square);
 *  - the sidebar renders ONLY destinations that actually work (no Design system/DEV,
 *    no decorative badges, no dead links);
 *  - Owner Console is NEVER in customer navigation — it lives (owners only) inside
 *    the account menu, a utility surface; server authorization stays authoritative;
 *  - the account menu is a REAL menu (keyboard + click-outside), never a fake caret.
 *
 * Active state is a subtle surface + a thin left marker — never an underline, a
 * purple bar, or a giant pill.
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import wordmarkUrl from './brand/happy-trader-funding-wordmark.png';
import './Shell.css';

export interface NavItem { key: string; label: string }

/** The full customer destination set. A real shell passes only the ones that work. */
export const PORTAL_V2_NAV: readonly NavItem[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'payouts', label: 'Payouts' },
  { key: 'certificates', label: 'Certificates' },
  { key: 'billing', label: 'Billing' },
  { key: 'support', label: 'Support' },
];

/** The brand wordmark. Supplied raster asset — never retyped, recreated, or distorted. */
export function V2Wordmark({ className = '' }: { className?: string }): JSX.Element {
  return <img className={`htv2-wordmark ${className}`} src={wordmarkUrl} alt="Happy Trader Funding" draggable={false} />;
}

export function V2Sidebar({ active, onNavigate, nav = PORTAL_V2_NAV }: {
  active: string;
  onNavigate?: (key: string) => void;
  nav?: readonly NavItem[];
}): JSX.Element {
  return (
    <aside className="htv2-side" aria-label="Primary">
      <div className="htv2-side-brand">
        <V2Wordmark className="htv2-side-logo" />
      </div>
      <nav className="htv2-side-nav" aria-label="Customer">
        {nav.map((n) => (
          <button
            key={n.key}
            type="button"
            className={`htv2-side-link ht-t-nav${active === n.key ? ' is-active' : ''}`}
            aria-current={active === n.key ? 'page' : undefined}
            onClick={() => onNavigate?.(n.key)}
          >
            <span className="htv2-side-link-label">{n.label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

export interface AccountMenuAction { key: string; label: string; onSelect: () => void; tone?: 'default' | 'owner' }

/**
 * The top-right account menu — a REAL menu. It carries the identity label and the
 * customer's actual actions (e.g. Sign out). The owner entry, when present, lives
 * here (a utility surface), never in customer navigation. If there are no actions,
 * the caller passes none and we render a plain identity chip with NO caret — never a
 * fake dropdown affordance.
 */
export function V2AccountMenu({ label, actions = [] }: { label: string; actions?: readonly AccountMenuAction[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (actions.length === 0) {
    return <span className="htv2-acctmenu-chip ht-t-nav" data-testid="htv2-account-chip">{label}</span>;
  }
  return (
    <div className="htv2-acctmenu" ref={ref}>
      <button
        type="button"
        className="htv2-acctmenu-btn ht-t-nav"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="htv2-account-menu"
      >
        {label}
        <svg className="htv2-acctmenu-caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
      </button>
      {open && (
        <div className="htv2-acctmenu-pop" role="menu">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              role="menuitem"
              className={`htv2-acctmenu-item ht-t-nav${a.tone === 'owner' ? ' is-owner' : ''}`}
              onClick={() => { setOpen(false); a.onSelect(); }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
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

export function V2AppShell({ active, onNavigate, nav, breadcrumb, utilities, children }: {
  active: string;
  onNavigate?: (key: string) => void;
  nav?: readonly NavItem[];
  breadcrumb?: ReactNode;
  utilities?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="htv2-shell">
      <V2Sidebar active={active} onNavigate={onNavigate} nav={nav} />
      <div className="htv2-shell-main">
        <V2TopBar breadcrumb={breadcrumb} utilities={utilities} />
        <main className="htv2-workspace">
          <div className="htv2-workspace-inner">{children}</div>
        </main>
      </div>
    </div>
  );
}
