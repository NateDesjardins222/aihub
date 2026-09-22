import { Suspense, lazy, useEffect, useState } from 'react';
import { useSession } from './state/session';
import { LoginScreen } from './components/LoginScreen';
import { TerminalShell } from './components/TerminalShell';
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

/*
 * Native checkout is its own path and its own bundle, so the payment component
 * (and Whop's iframe machinery) never loads for a trader who is not buying.
 * Reached at /checkout?product=<key>, behind sign-in like everything else.
 */
const CheckoutApp = lazy(() => import('./checkout/CheckoutApp').then((m) => ({ default: m.CheckoutApp })));

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

  useEffect(() => {
    void boot();
  }, [boot]);

  // The icon gallery is a static development page: no session, no data.
  if (icons) {
    return (
      <Suspense fallback={<div className="boot-splash">Loading icons…</div>}>
        <IconGallery />
      </Suspense>
    );
  }

  if (phase === 'BOOTING') {
    return <div className="boot-splash">Restoring session…</div>;
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
  if (admin) {
    return (
      <Suspense fallback={<div className="boot-splash">Loading operations…</div>}>
        <AdminApp />
      </Suspense>
    );
  }
  return <TerminalShell />;
}
