import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../../api/client';
import { Card, msg } from '../lib';
import type { MfaStatusResponse, MfaEnrollBeginResponse } from '../../api/types';

/**
 * Two-factor authentication management (Phase 12.5).
 *
 * Enroll (scan/enter the secret, confirm a code, save recovery codes), disable
 * (password + a live code), and regenerate recovery codes. The secret and the
 * recovery codes are shown once, here, and never fetched back — the server only
 * ever stores a sealed secret and hashed codes.
 */
export function MfaPanel({ onToast }: { onToast: (m: string) => void }): JSX.Element {
  const [status, setStatus] = useState<MfaStatusResponse | null>(null);
  const [enroll, setEnroll] = useState<MfaEnrollBeginResponse | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = (): void => {
    void api
      .get<MfaStatusResponse>('/api/v1/auth/mfa/status')
      .then(setStatus)
      .catch(() => setStatus(null));
  };
  useEffect(reload, []);

  const begin = async (): Promise<void> => {
    setBusy(true);
    try {
      setEnroll(await api.post<MfaEnrollBeginResponse>('/api/v1/auth/mfa/enroll/begin'));
      setRecoveryCodes(null);
      setCode('');
    } catch (e) {
      onToast(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const activate = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/v1/auth/mfa/enroll/activate', { code: code.trim() });
      setRecoveryCodes(r.recoveryCodes);
      setEnroll(null);
      setCode('');
      onToast('Two-factor authentication enabled');
      reload();
    } catch (e) {
      onToast(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const disable = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.post('/api/v1/auth/mfa/disable', { password, code: code.trim() });
      setPassword('');
      setCode('');
      setRecoveryCodes(null);
      onToast('Two-factor authentication disabled');
      reload();
    } catch (e) {
      onToast(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/v1/auth/mfa/recovery-codes', { code: code.trim() });
      setRecoveryCodes(r.recoveryCodes);
      setCode('');
      onToast('New recovery codes generated');
      reload();
    } catch (e) {
      onToast(msg(e));
    } finally {
      setBusy(false);
    }
  };

  if (recoveryCodes) {
    return (
      <Card>
        <p className="pt-metric-k" style={{ marginTop: 0 }}>Recovery codes</p>
        <p className="pt-note">
          Save these somewhere safe. Each can be used once if you lose your authenticator. They are
          shown only now and cannot be retrieved later.
        </p>
        <pre
          style={{
            fontFamily: "'JetBrains Mono Variable', monospace",
            background: 'rgba(0,0,0,0.25)',
            padding: 12,
            borderRadius: 8,
            lineHeight: 1.8,
            columnCount: 2,
          }}
        >
          {recoveryCodes.join('\n')}
        </pre>
        <div className="pt-actions">
          <button className="pt-btn primary" onClick={() => setRecoveryCodes(null)}>I have saved these</button>
        </div>
      </Card>
    );
  }

  if (enroll) {
    return (
      <Card>
        <p className="pt-metric-k" style={{ marginTop: 0 }}>Set up your authenticator</p>
        <p className="pt-note">
          Add this account to an authenticator app (Google Authenticator, 1Password, Authy…), then
          enter the 6-digit code it shows to confirm.
        </p>
        <label className="pt-metric-k">Manual entry key</label>
        <div style={{ fontFamily: "'JetBrains Mono Variable', monospace", wordBreak: 'break-all', margin: '6px 0 12px' }}>
          {enroll.secret}
        </div>
        <label className="pt-metric-k">Setup URI</label>
        <div style={{ fontFamily: "'JetBrains Mono Variable', monospace", wordBreak: 'break-all', fontSize: 12, margin: '6px 0 12px', opacity: 0.8 }}>
          {enroll.otpauthUri}
        </div>
        <label className="pt-metric-k">Code from your app</label>
        <input
          className="pt-input"
          style={{ marginTop: 8, maxWidth: 200 }}
          inputMode="numeric"
          value={code}
          placeholder="123456"
          onChange={(e) => setCode(e.target.value)}
        />
        <div className="pt-actions">
          <button className="pt-btn primary" onClick={activate} disabled={busy || code.trim().length < 6}>Confirm &amp; enable</button>
          <button className="pt-btn" onClick={() => setEnroll(null)} disabled={busy}>Cancel</button>
        </div>
      </Card>
    );
  }

  if (!status) {
    return (
      <Card>
        <p className="muted" style={{ marginTop: 0 }}>Loading two-factor status…</p>
      </Card>
    );
  }

  if (!status.enrolled) {
    return (
      <Card>
        <p className="pt-metric-k" style={{ marginTop: 0 }}>Two-factor authentication</p>
        <p className="pt-note">
          Not enabled. Add a second factor so a password alone cannot sign in to your account —
          strongly recommended for operator accounts.
        </p>
        <div className="pt-actions">
          <button className="pt-btn primary" onClick={begin} disabled={busy}>Enable two-factor</button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <p className="pt-metric-k" style={{ marginTop: 0 }}>Two-factor authentication — enabled</p>
      <p className="pt-note">
        {status.recoveryCodesRemaining} recovery code{status.recoveryCodesRemaining === 1 ? '' : 's'} remaining.
      </p>
      <label className="pt-metric-k">Current authenticator code</label>
      <input
        className="pt-input"
        style={{ marginTop: 8, maxWidth: 200 }}
        inputMode="numeric"
        value={code}
        placeholder="123456 or recovery code"
        onChange={(e) => setCode(e.target.value)}
      />
      <div className="pt-actions">
        <button className="pt-btn" onClick={regenerate} disabled={busy || code.trim().length < 6}>Regenerate recovery codes</button>
      </div>
      <hr style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.08)', margin: '16px 0' }} />
      <p className="pt-metric-k" style={{ marginTop: 0 }}>Disable two-factor</p>
      <label className="pt-metric-k">Password</label>
      <input
        className="pt-input"
        style={{ marginTop: 8, maxWidth: 320 }}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <div className="pt-actions">
        <button className="pt-btn danger" onClick={disable} disabled={busy || !password || code.trim().length < 6}>Disable</button>
      </div>
    </Card>
  );
}
