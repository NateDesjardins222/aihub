import { type FormEvent, useState } from 'react';
import { useSession } from '../state/session';
import './LoginScreen.css';
import type { JSX } from 'react';

export function LoginScreen(): JSX.Element {
  const signIn = useSession((s) => s.signIn);
  const busy = useSession((s) => s.busy);
  const error = useSession((s) => s.error);
  const [email, setEmail] = useState('demo@atlasfutures.local');
  const [password, setPassword] = useState('');

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void signIn(email, password).catch(() => {
      /* error surfaced through the store */
    });
  };

  return (
    <div className="login-root">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-brand">
          <div className="login-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <h1>ATLAS</h1>
            <p>Futures Simulation Terminal</p>
          </div>
        </div>

        <label className="login-field">
          <span className="label">Email</span>
          <input
            type="email"
            value={email}
            autoComplete="username"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <label className="login-field">
          <span className="label">Password</span>
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {error ? <div className="login-error">{error}</div> : null}

        <button className="login-submit" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="login-note">
          Simulation only. No real orders are routed to any exchange, and no real funds are
          at risk. Market data is exchange-derived and delayed.
        </p>
      </form>
    </div>
  );
}
