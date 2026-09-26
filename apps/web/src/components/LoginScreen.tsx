import { type FormEvent, useState } from 'react';
import { useSession } from '../state/session';
import './LoginScreen.css';
import type { JSX } from 'react';

export function LoginScreen(): JSX.Element {
  const signIn = useSession((s) => s.signIn);
  const verifyMfa = useSession((s) => s.verifyMfa);
  const cancelMfa = useSession((s) => s.cancelMfa);
  const mfaChallengeToken = useSession((s) => s.mfaChallengeToken);
  const busy = useSession((s) => s.busy);
  const error = useSession((s) => s.error);
  const [email, setEmail] = useState('demo@atlasfutures.local');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void signIn(email, password).catch(() => {
      /* error surfaced through the store */
    });
  };

  const onVerify = (event: FormEvent): void => {
    event.preventDefault();
    void verifyMfa(code.trim()).catch(() => {
      /* error surfaced through the store */
    });
  };

  // Second step: the password was accepted and the account has MFA enabled.
  if (mfaChallengeToken) {
    return (
      <div className="login-root">
        <form className="login-card" onSubmit={onVerify}>
          <div className="login-brand">
            <div className="login-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div>
              <h1>ATLAS</h1>
              <p>Two-factor verification</p>
            </div>
          </div>

          <label className="login-field">
            <span className="label">Authentication code</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              placeholder="123456"
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </label>

          <p className="login-note">
            Enter the 6-digit code from your authenticator app, or one of your recovery codes.
          </p>

          {error ? <div className="login-error">{error}</div> : null}

          <button className="login-submit" type="submit" disabled={busy}>
            {busy ? 'Verifying…' : 'Verify'}
          </button>

          <button
            type="button"
            className="login-secondary"
            onClick={() => {
              setCode('');
              cancelMfa();
            }}
          >
            Back to sign in
          </button>
        </form>
      </div>
    );
  }

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
