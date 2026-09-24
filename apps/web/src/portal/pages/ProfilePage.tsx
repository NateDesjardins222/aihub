import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../../api/client';
import { Card, msg } from '../lib';

function firstLastInitial(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

type Section = 'profile' | 'verification' | 'security' | 'notifications';

export function ProfilePage({ section, onToast }: { section: Section; onToast: (m: string) => void }): JSX.Element {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void api.get<{ preferredDisplayName: string | null; displayName: string | null }>('/api/v1/portal/profile')
      .then((r) => { setName(r.preferredDisplayName ?? ''); setDisplayName(r.displayName ?? ''); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);
  const save = async (): Promise<void> => {
    try { await api.patch('/api/v1/portal/profile', { preferredDisplayName: name }); onToast('Profile saved'); }
    catch (e) { onToast(msg(e)); }
  };

  const heading = { profile: 'Profile', verification: 'Verification', security: 'Security', notifications: 'Notifications' }[section];
  return (
    <>
      <h1 className="pt-h1">{heading}</h1>
      {section === 'profile' && (
        <>
          <p className="pt-sub">Your public display identity is separate from your legal identity, which never appears on a certificate.</p>
          <Card className="" >
            <label className="pt-metric-k">Public display name</label>
            <input className="pt-input" style={{ marginTop: 8, maxWidth: 420 }} value={name} maxLength={80}
              placeholder={displayName ? `${firstLastInitial(displayName)} (default)` : 'e.g. Nathan D.'}
              onChange={(e) => setName(e.target.value)} disabled={!loaded} />
            <p className="pt-note">Shown on certificates and public verification. Never your email, phone, or full legal name.</p>
            <div className="pt-actions"><button className="pt-btn primary" onClick={save} disabled={!loaded}>Save</button></div>
          </Card>
        </>
      )}
      {section === 'verification' && (
        <>
          <p className="pt-sub">Contact verification, identity and agreements are managed in onboarding.</p>
          <Card><p className="muted" style={{ marginTop: 0 }}>Complete or review your verification steps.</p>
            <div className="pt-actions"><button className="pt-btn" onClick={() => { window.location.href = '/onboarding'; }}>Open verification</button></div>
          </Card>
        </>
      )}
      {section === 'security' && (
        <>
          <p className="pt-sub">Sessions and password. Sign-in security is enforced server-side.</p>
          <Card><p className="muted" style={{ marginTop: 0 }}>Change your password or review recent sign-ins from onboarding &amp; account settings.</p>
            <div className="pt-actions"><button className="pt-btn" onClick={() => { window.location.href = '/onboarding'; }}>Manage security</button></div>
          </Card>
        </>
      )}
      {section === 'notifications' && (
        <>
          <p className="pt-sub">Account, payout and risk alerts are delivered by email and SMS.</p>
          <Card><p className="muted" style={{ marginTop: 0 }}>You receive notifications for payout eligibility, evaluation results, funding, payout approvals, low MLL headroom, and personal risk-control activations. Delivery preferences are managed with the desk.</p></Card>
        </>
      )}
    </>
  );
}
