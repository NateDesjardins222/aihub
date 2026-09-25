/*
 * Shared public-site chrome: the mark, the wordmark, the top navigation and the
 * footer. Small, composable, and used across every marketing surface.
 */
import { useEffect, useState, type JSX } from 'react';
import { SITE, copyrightYear } from './site';

/** External navigation to a gated app flow — a real navigation, not SPA routing. */
export function goExternal(path: string): void {
  window.location.assign(path);
}

/** Smooth in-page scroll to a section id. */
export function scrollToId(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

/** The brand mark: a chrome rounded-square with an ascending three-candle glyph. */
export function HTMark({ size = 28 }: { size?: number }): JSX.Element {
  const id = `htm${size}`;
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" className="ht-mark-svg">
      <defs>
        <linearGradient id={`${id}-chrome`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.28" stopColor="#e3e6ec" />
          <stop offset="0.55" stopColor="#a2a8b4" />
          <stop offset="0.75" stopColor="#e9ecf1" />
          <stop offset="1" stopColor="#848b98" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="27" height="27" rx="7.5" fill={`url(#${id}-chrome)`} />
      {/* Ascending candles, knocked out of the chrome in near-black. */}
      <g fill="#0a0a0b">
        <rect x="6" y="15" width="3" height="6" rx="1" />
        <rect x="7" y="12.5" width="1" height="11" rx="0.5" />
        <rect x="12.5" y="11" width="3" height="8" rx="1" />
        <rect x="13.5" y="8" width="1" height="14" rx="0.5" />
        <rect x="19" y="7" width="3" height="9" rx="1" />
        <rect x="20" y="5" width="1" height="13" rx="0.5" />
      </g>
    </svg>
  );
}

export function Wordmark({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <span className="ht-wordmark" style={{ fontSize: size }}>
      <HTMark size={Math.round(size * 1.75)} />
      <span className="ht-wordmark-text">
        Happy Trader <span className="sub">Funding</span>
      </span>
    </span>
  );
}

const NAV_LINKS: readonly { id: string; label: string }[] = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'how', label: 'How it works' },
  { id: 'atlas', label: 'Atlas' },
  { id: 'payouts', label: 'Payouts' },
  { id: 'faq', label: 'FAQ' },
];

export function Nav(): JSX.Element {
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const link = (id: string, label: string): JSX.Element => (
    <a
      key={id}
      href={`#${id}`}
      onClick={(e) => {
        e.preventDefault();
        setMenu(false);
        scrollToId(id);
      }}
    >
      {label}
    </a>
  );

  return (
    <header className="ht-nav" data-scrolled={scrolled ? 'true' : 'false'}>
      <div className="ht-wrap ht-nav-inner">
        <a
          href="/"
          aria-label={`${SITE.brand} home`}
          onClick={(e) => {
            e.preventDefault();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        >
          <Wordmark />
        </a>
        <nav className="ht-nav-links" aria-label="Primary">
          {NAV_LINKS.map((l) => link(l.id, l.label))}
        </nav>
        <div className="ht-nav-spacer" />
        <div className="ht-nav-actions">
          <a className="ht-nav-signin" href={SITE.routes.signIn} onClick={(e) => { e.preventDefault(); goExternal(SITE.routes.signIn); }}>
            Sign in
          </a>
          <button className="ht-btn ht-btn--primary ht-btn--sm" onClick={() => goExternal(SITE.routes.getStarted)}>
            Get funded
          </button>
          <button
            className="ht-nav-burger"
            aria-label="Menu"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      <div className="ht-mobile-menu" data-open={menu ? 'true' : 'false'}>
        {NAV_LINKS.map((l) => link(l.id, l.label))}
        <a href={SITE.routes.signIn} onClick={(e) => { e.preventDefault(); goExternal(SITE.routes.signIn); }}>
          Sign in
        </a>
        <button className="ht-btn ht-btn--primary" onClick={() => goExternal(SITE.routes.getStarted)}>
          Get funded
        </button>
      </div>
    </header>
  );
}

export function Footer(): JSX.Element {
  const social = SITE.legal.social;
  const hasSocial = Object.values(social).some(Boolean);
  return (
    <footer className="ht-footer">
      <div className="ht-wrap">
        <div className="ht-footer-top">
          <div className="ht-footer-col ht-footer-brand">
            <Wordmark />
            <p>{SITE.description}</p>
          </div>
          <div className="ht-footer-col">
            <h4>Product</h4>
            <a href="#accounts" onClick={(e) => { e.preventDefault(); scrollToId('accounts'); }}>Accounts</a>
            <a href="#atlas" onClick={(e) => { e.preventDefault(); scrollToId('atlas'); }}>Atlas platform</a>
            <a href="#payouts" onClick={(e) => { e.preventDefault(); scrollToId('payouts'); }}>Payouts</a>
            <a href="#rules" onClick={(e) => { e.preventDefault(); scrollToId('rules'); }}>Rules</a>
          </div>
          <div className="ht-footer-col">
            <h4>Company</h4>
            <a href={SITE.routes.affiliates} onClick={(e) => { e.preventDefault(); goExternal(SITE.routes.affiliates); }}>Affiliates</a>
            <a href="#faq" onClick={(e) => { e.preventDefault(); scrollToId('faq'); }}>FAQ</a>
            <a href={SITE.routes.signIn} onClick={(e) => { e.preventDefault(); goExternal(SITE.routes.signIn); }}>Sign in</a>
          </div>
          <div className="ht-footer-col">
            <h4>Get started</h4>
            <a href={SITE.routes.getStarted} onClick={(e) => { e.preventDefault(); goExternal(SITE.routes.getStarted); }}>Choose an account</a>
            {hasSocial ? (
              <>
                {social.x ? <a href={social.x}>X</a> : null}
                {social.youtube ? <a href={social.youtube}>YouTube</a> : null}
                {social.instagram ? <a href={social.instagram}>Instagram</a> : null}
                {social.discord ? <a href={social.discord}>Discord</a> : null}
              </>
            ) : null}
          </div>
        </div>

        <p className="ht-disclaimer">
          {SITE.brand} provides simulated evaluations and simulated-funded performance
          accounts for futures trading education and evaluation. All trading on the
          platform is simulated. Nothing here is financial advice or a solicitation to
          trade live capital, and no specific outcome or income is promised. Trading
          involves substantial risk.
        </p>

        <div className="ht-footer-bottom">
          <span>© {copyrightYear()} {SITE.legal.entityName ?? SITE.brand}. All rights reserved.</span>
          <span>Built on Atlas.</span>
        </div>
      </div>
    </footer>
  );
}
