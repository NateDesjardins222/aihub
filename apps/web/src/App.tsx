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

  useEffect(() => {
    void boot();
  }, [boot]);

  if (phase === 'BOOTING') {
    return <div className="boot-splash">Restoring session…</div>;
  }
  // Signing in is the same door for everyone; what is behind it is not.
  if (phase !== 'SIGNED_IN') return <LoginScreen />;
  if (admin) {
    return (
      <Suspense fallback={<div className="boot-splash">Loading operations…</div>}>
        <AdminApp />
      </Suspense>
    );
  }
  return <TerminalShell />;
}
