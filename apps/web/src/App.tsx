import { useEffect } from 'react';
import { useSession } from './state/session';
import { LoginScreen } from './components/LoginScreen';
import { TerminalShell } from './components/TerminalShell';
import type { JSX } from 'react';

export function App(): JSX.Element {
  const phase = useSession((s) => s.phase);
  const boot = useSession((s) => s.boot);

  useEffect(() => {
    void boot();
  }, [boot]);

  if (phase === 'BOOTING') {
    return <div className="boot-splash">Restoring session…</div>;
  }
  return phase === 'SIGNED_IN' ? <TerminalShell /> : <LoginScreen />;
}
