import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../../api/client';
import { type Achievement, type AchievementsView, type Cert, achLabel, certLabel, EmptyState, money, msg, Skeleton, Toggle } from '../lib';

const MAJOR = new Set(['FIVE_PAYOUT_CLUB', 'ACCOUNT_COMPLETED', 'PAID_25K']);

export function AchievementsPage({ onToast }: { onToast: (m: string) => void }): JSX.Element {
  const [view, setView] = useState<AchievementsView | null>(null);
  const [certs, setCerts] = useState<Cert[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    void api.get<AchievementsView>('/api/v1/portal/achievements').then(setView).catch((e: unknown) => setErr(msg(e)));
    void api.get<{ certificates: Cert[] }>('/api/v1/portal/certificates').then((r) => setCerts(r.certificates)).catch(() => setCerts([]));
  }, []);
  useEffect(load, [load]);

  const toggleAll = async (): Promise<void> => {
    if (!view) return;
    try { await api.patch('/api/v1/portal/achievements/visibility', { isPublic: !view.achievementsPublic }); load(); onToast('Visibility updated'); }
    catch (e) { onToast(msg(e)); }
  };
  const copy = (token: string): void => {
    const url = `${window.location.origin}/verify/${token}`;
    void navigator.clipboard?.writeText(url).then(() => onToast('Verification link copied')).catch(() => onToast(url));
  };

  if (err) return <p className="pt-error">{err}</p>;
  return (
    <>
      <h1 className="pt-h1">Achievements</h1>
      <p className="pt-sub">Milestones you have earned — restrained by design. No points, no economy.</p>
      {view && (
        <div style={{ marginBottom: 18 }}>
          <Toggle on={view.achievementsPublic} onClick={toggleAll} label="Show my achievements publicly" />
        </div>
      )}
      {!view ? (
        <div className="pt-ach-grid">{Array.from({ length: 4 }, (_, i) => <div className="pt-ach" key={i}><Skeleton h={46} w={46} /></div>)}</div>
      ) : view.achievements.length === 0 ? (
        <EmptyState title="No achievements yet" hint="Pass an evaluation and get funded to earn your first." />
      ) : (
        <div className="pt-ach-grid" data-testid="pt-achievements">
          {view.achievements.map((a: Achievement) => (
            <div className={`pt-ach${MAJOR.has(a.type) ? ' major' : ''}`} key={a.id}>
              <div className="emblem">{achLabel(a.type).slice(0, 1)}</div>
              <div className="t">{achLabel(a.type)}</div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{new Date(a.earnedAt).toLocaleDateString()}</div>
            </div>
          ))}
        </div>
      )}

      <div className="pt-section-title">Certificates</div>
      {!certs ? (
        <Skeleton h={80} />
      ) : certs.length === 0 ? (
        <EmptyState title="No certificates yet" hint="Passing an evaluation, getting funded, and each payout issue a publicly verifiable, privacy-safe certificate." />
      ) : (
        <div className="pt-cards">
          {certs.map((c) => (
            <div className="pt-card" key={c.id}>
              <div className="pt-row">
                <span className={`pt-badge ${c.status === 'REVOKED' ? 'failed' : 'funded'}`}><span className="dot" />{certLabel(c.type)}</span>
                {c.amountMicros != null && <strong className="num">{money(c.amountMicros)}</strong>}
              </div>
              <div className="muted" style={{ marginTop: 10 }}>{c.certificatePublicId}</div>
              <div className="muted">{c.publicDisplayName} · {new Date(c.issuedAt).toLocaleDateString()}</div>
              <div className="pt-actions">
                <button className="pt-link" onClick={() => copy(c.verificationToken)}>Copy verify link</button>
                <button className="pt-link" onClick={() => window.open(`/verify/${c.verificationToken}`, '_blank')}>View</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
