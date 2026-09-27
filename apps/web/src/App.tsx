import { Suspense, lazy, useEffect, useState } from 'react';
import { useSession } from './state/session';
import { designLabEnabled } from './lib/runtime';
import { LoginScreen } from './components/LoginScreen';
import { TerminalShell } from './components/TerminalShell';
import { NotFound } from './components/NotFound';
import type { JSX } from 'react';

/*
 * The operator console is a separate experience and a separate bundle.
 *
 * Lazily imported, so a trader never downloads a line of it, and reached only
 * by its own path: nothing admin-shaped appears in the terminal's chrome.
 */
const AdminApp = lazy(() => import('./admin/AdminApp').then((m) => ({ default: m.AdminApp })));

/*
 * A development-only icon gallery, reached at /icons and lazily loaded so it
 * never ships in the trader's first paint. It renders the drawing-tool icons at
 * every rail size and state for side-by-side comparison against the references.
 */
const IconGallery = lazy(() => import('./dev/IconGallery').then((m) => ({ default: m.IconGallery })));
// Portal V2 design-system harness: DEVELOPMENT BUILDS ONLY (see /portal-v2 below).
const PortalV2Harness = lazy(() => import('./portal/v2/Harness').then((m) => ({ default: m.PortalV2Harness })));

/*
 * Native checkout is its own path and its own bundle, so the payment component
 * (and Whop's iframe machinery) never loads for a trader who is not buying.
 * Reached at /checkout?product=<key>, behind sign-in like everything else.
 */
const CheckoutApp = lazy(() => import('./checkout/CheckoutApp').then((m) => ({ default: m.CheckoutApp })));

/*
 * The customer onboarding flow (VISITOR → verified → agreements → product →
 * checkout → server-driven provisioning → account ready). Its own path and
 * bundle, behind sign-in, so the terminal never downloads it.
 */
const OnboardingApp = lazy(() => import('./onboarding/OnboardingApp').then((m) => ({ default: m.OnboardingApp })));

/*
 * The customer portal (dashboard, accounts, analytics, certificates,
 * achievements, profile). Its own path and bundle, behind sign-in, beside the
 * terminal — a trader who only trades never downloads it.
 */
const PortalApp = lazy(() => import('./portal/PortalApp').then((m) => ({ default: m.PortalApp })));

/*
 * Public certificate verification (/verify/:token). Unauthenticated and its own
 * bundle — rendered before the sign-in gate so a shared/QR link works for anyone.
 */
const VerifyPage = lazy(() => import('./portal/VerifyPage').then((m) => ({ default: m.VerifyPage })));

/*
 * The public affiliate/partner program (/affiliates, /affiliates/apply,
 * /affiliates/agreement). Unauthenticated and its own bundle — rendered before the
 * sign-in gate so a shared referral link and the application form work for anyone.
 */
const AffiliatesPublic = lazy(() => import('./affiliates/AffiliatesPublic').then((m) => ({ default: m.AffiliatesPublic })));

/*
 * The affiliate self-service portal (/affiliates/portal). Behind sign-in and its
 * own bundle — a trader who is not a partner never downloads it.
 */
const AffiliatePortal = lazy(() => import('./affiliates/AffiliatePortal').then((m) => ({ default: m.AffiliatePortal })));

/*
 * The public marketing website (the homepage). Its own bundle, rendered before the
 * sign-in gate for visitors at "/" (or "/home") — the public front door. Signed-in
 * users at "/" still get the terminal, so the authenticated product is untouched.
 */
const MarketingApp = lazy(() => import('./marketing/MarketingApp').then((m) => ({ default: m.MarketingApp })));

/*
 * The homepage design lab (NON-PRODUCTION), reached at /design-lab. Its own bundle,
 * rendered before the sign-in gate like other public surfaces. It never affects the
 * production homepage or any authenticated app.
 */
const LabApp = lazy(() => import('./marketing/lab/LabApp').then((m) => ({ default: m.LabApp })));

function isMarketingRootPath(pathname: string): boolean {
  return pathname === '/' || pathname === '' || pathname === '/home';
}

/*
 * The complete set of top-level routes the app serves. Anything else is a
 * genuine 404 (HTF-30): before this, an unknown URL silently fell through to the
 * terminal or the sign-in screen. The terminal itself lives at the root and does
 * not use sub-paths, so restricting unknown top-level paths is safe.
 */
const KNOWN_ROUTE_PREFIXES = [
  '/home',
  '/verify',
  '/affiliates',
  '/design-lab',
  '/icons',
  '/checkout',
  '/onboarding',
  '/portal',
  '/admin',
];

function isKnownRoute(pathname: string): boolean {
  if (isMarketingRootPath(pathname)) return true;
  return KNOWN_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function useIsAdminPath(): boolean {
  const [isAdmin, setIsAdmin] = useState(() => window.location.pathname.startsWith('/admin'));
  useEffect(() => {
    const onPop = (): void => setIsAdmin(window.location.pathname.startsWith('/admin'));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return isAdmin;
}

export function App(): JSX.Element {
  const phase = useSession((s) => s.phase);
  const boot = useSession((s) => s.boot);
  const admin = useIsAdminPath();
  const icons = typeof window !== 'undefined' && window.location.pathname.startsWith('/icons');
  const checkout = typeof window !== 'undefined' && window.location.pathname.startsWith('/checkout');
  const onboarding = typeof window !== 'undefined' && window.location.pathname.startsWith('/onboarding');
  const portal = typeof window !== 'undefined' && window.location.pathname.startsWith('/portal');
  const affiliatePortal = typeof window !== 'undefined' && window.location.pathname.startsWith('/affiliates/portal');

  useEffect(() => {
    void boot();
  }, [boot]);

  // Public certificate verification: no session required, before the sign-in gate.
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/verify')) {
    return (
      <Suspense fallback={<div className="boot-splash">Verifying…</div>}>
        <VerifyPage />
      </Suspense>
    );
  }

  // Public affiliate program: no session required, before the sign-in gate — so a
  // shared referral link and the application form work for anyone. The affiliate
  // portal (/affiliates/portal) is behind sign-in and handled after the gate.
  if (
    typeof window !== 'undefined' &&
    window.location.pathname.startsWith('/affiliates') &&
    !window.location.pathname.startsWith('/affiliates/portal')
  ) {
    return (
      <Suspense fallback={<div className="boot-splash">Loading…</div>}>
        <AffiliatesPublic />
      </Suspense>
    );
  }

  // The homepage design lab: DEVELOPMENT BUILDS ONLY, no session, rendered before
  // the gate. In a production build `designLabEnabled()` is false, so this block is
  // skipped and a direct /design-lab URL falls through to the normal app — the lab
  // (and its fabricated demo values) is never reachable in production.
  if (
    designLabEnabled() &&
    typeof window !== 'undefined' &&
    window.location.pathname.startsWith('/design-lab')
  ) {
    return (
      <Suspense fallback={<div className="boot-splash">Loading design lab…</div>}>
        <LabApp />
      </Suspense>
    );
  }

  // Portal V2 design-system harness: DEVELOPMENT BUILDS ONLY, no session, rendered
  // before the gate. In a production build `designLabEnabled()` is false so this is
  // skipped and /portal-v2 falls through to the 404 — the isolated V2 foundation is
  // never reachable by customers and never affects the live V1 Portal.
  if (
    designLabEnabled() &&
    typeof window !== 'undefined' &&
    window.location.pathname.startsWith('/portal-v2')
  ) {
    return (
      <Suspense fallback={<div className="boot-splash">Loading Portal V2 harness…</div>}>
        <PortalV2Harness />
      </Suspense>
    );
  }

  // The icon gallery is a static development page: no session, no data.
  if (icons) {
    return (
      <Suspense fallback={<div className="boot-splash">Loading icons…</div>}>
        <IconGallery />
      </Suspense>
    );
  }

  // A genuinely unknown top-level URL gets an honest branded 404 rather than
  // silently falling through to the terminal or the sign-in screen (HTF-30).
  if (typeof window !== 'undefined' && !isKnownRoute(window.location.pathname)) {
    return <NotFound />;
  }

  if (phase === 'BOOTING') {
    return <div className="boot-splash">Restoring session…</div>;
  }
  // The public marketing homepage is the front door for visitors who are not signed
  // in. Signed-in users at "/" fall through to the terminal, unchanged.
  if (phase !== 'SIGNED_IN' && typeof window !== 'undefined' && isMarketingRootPath(window.location.pathname)) {
    return (
      <Suspense fallback={<div className="boot-splash">Loading…</div>}>
        <MarketingApp />
      </Suspense>
    );
  }
  // Signing in is the same door for everyone; what is behind it is not.
  if (phase !== 'SIGNED_IN') return <LoginScreen />;
  if (checkout) {
    return (
      <Suspense fallback={<div className="boot-splash">Loading checkout…</div>}>
        <CheckoutApp />
      </Suspense>
    );
  }
  if (onboarding) {
    return (
      <Suspense fallback={<div className="boot-splash">Loading…</div>}>
        <OnboardingApp />
      </Suspense>
    );
  }
  if (affiliatePortal) {
    return (
      <Suspense fallback={<div className="boot-splash">Loading partner dashboard…</div>}>
        <AffiliatePortal />
      </Suspense>
    );
  }
  if (portal) {
    return (
      <Suspense fallback={<div className="boot-splash">Loading portal…</div>}>
        <PortalApp />
      </Suspense>
    );
  }
  if (admin) {
    return (
      <Suspense fallback={<div className="boot-splash">Loading operations…</div>}>
        <AdminApp />
      </Suspense>
    );
  }
  return <TerminalShell />;
}
