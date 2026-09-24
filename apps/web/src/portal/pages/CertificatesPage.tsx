import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { api, getAccessToken } from '../../api/client';
import { type Cert, Card, EmptyState, money, msg, Skeleton } from '../lib';

/**
 * The Certificate Vault — a permanent, first-class awards archive. Every figure
 * and artifact comes from the server; certificates persist through account
 * failure, completion, archival and reset. The certificate artwork itself is the
 * visual hero (a preview of the deterministic rendered artifact, never CSS-drawn).
 */

const LABELS: Record<string, string> = {
  EVALUATION_PASSED: 'Evaluation Passed',
  FUNDED_TRADER: 'Funded Trader',
  PAYOUT: 'Payout',
  ACCOUNT_COMPLETED: 'Account Completed',
  TENK_CLUB: '$10K Club',
  FIFTYK_CLUB: '$50K Club',
  HUNDREDK_CLUB: '$100K Club',
};

type Filter = 'ALL' | 'FUNDED' | 'PAYOUTS' | 'MILESTONES' | 'COMPLETED';
const FILTERS: Array<[Filter, string]> = [
  ['ALL', 'All'], ['FUNDED', 'Funded'], ['PAYOUTS', 'Payouts'], ['MILESTONES', 'Milestones'], ['COMPLETED', 'Completed'],
];
const MILESTONE_TYPES = new Set(['TENK_CLUB', 'FIFTYK_CLUB', 'HUNDREDK_CLUB']);

function inFilter(c: Cert, f: Filter): boolean {
  switch (f) {
    case 'ALL': return true;
    case 'FUNDED': return c.type === 'FUNDED_TRADER';
    case 'PAYOUTS': return c.type === 'PAYOUT';
    case 'MILESTONES': return MILESTONE_TYPES.has(c.type);
    case 'COMPLETED': return c.type === 'ACCOUNT_COMPLETED';
  }
}

/** Fetch an authenticated artifact as an object URL (an <img> cannot send a bearer). */
async function artifactBlobUrl(certId: string, kind: 'image' | 'pdf'): Promise<string | null> {
  try {
    const res = await fetch(`/api/v1/portal/certificates/${certId}/${kind}`, {
      headers: { authorization: `Bearer ${getAccessToken() ?? ''}` },
    });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

async function download(certId: string, kind: 'image' | 'pdf', name: string): Promise<void> {
  const url = await artifactBlobUrl(certId, kind);
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.${kind === 'pdf' ? 'pdf' : 'png'}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function CertificatesPage({ onToast }: { onToast: (m: string) => void }): JSX.Element {
  const [certs, setCerts] = useState<Cert[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('ALL');

  useEffect(() => {
    void api.get<{ certificates: Cert[] }>('/api/v1/portal/certificates')
      .then((r) => setCerts(r.certificates))
      .catch((e: unknown) => setErr(msg(e)));
  }, []);

  const shown = useMemo(() => (certs ?? []).filter((c) => inFilter(c, filter)), [certs, filter]);

  if (err) return <p className="pt-error">{err}</p>;

  return (
    <>
      <h1 className="pt-h1">Certificates</h1>
      <p className="pt-sub">Your permanent awards archive. Certificates stay here through every account change — earned recognition is never un-earned.</p>

      <div className="pt-chart-range" data-testid="pt-cert-filter" style={{ marginBottom: 18 }}>
        {FILTERS.map(([f, label]) => (
          <button key={f} className={f === filter ? 'on' : ''} onClick={() => setFilter(f)}>{label}</button>
        ))}
      </div>

      {!certs ? (
        <div className="pt-cards">{Array.from({ length: 3 }, (_, i) => <div className="pt-card" key={i}><Skeleton h={200} /></div>)}</div>
      ) : shown.length === 0 ? (
        <EmptyState
          title={certs.length === 0 ? 'No certificates yet' : 'None in this category'}
          hint={certs.length === 0 ? 'Pass an evaluation, get funded, or take a payout to earn your first certificate.' : 'Try another category.'}
        />
      ) : (
        <div className="pt-cards" data-testid="pt-cert-list">
          {shown.map((c) => <CertCard key={c.id} c={c} onToast={onToast} />)}
        </div>
      )}
    </>
  );
}

function CertCard({ c, onToast }: { c: Cert; onToast: (m: string) => void }): JSX.Element {
  const [thumb, setThumb] = useState<string | null>(null);
  const rendered = c.renderStatus === 'RENDERED' && c.hasImage;

  useEffect(() => {
    let url: string | null = null;
    let live = true;
    if (rendered) {
      void artifactBlobUrl(c.id, 'image').then((u) => { if (live && u) { url = u; setThumb(u); } });
    }
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [c.id, rendered]);

  const value = MILESTONE_TYPES.has(c.type) ? c.milestoneValueMicros : c.amountMicros;
  const verifyUrl = `${window.location.origin}/verify/${c.verificationToken}`;
  const copyVerify = (): void => {
    void navigator.clipboard?.writeText(verifyUrl).then(() => onToast('Verification link copied')).catch(() => onToast(verifyUrl));
  };

  return (
    <section className="pt-card pt-cert-card" data-testid="pt-cert-card" data-cert-type={c.type}>
      <div className="pt-cert-preview">
        {rendered && thumb ? (
          <img src={thumb} alt={`${LABELS[c.type] ?? c.type} certificate`} className="pt-cert-img" data-testid="pt-cert-thumb" />
        ) : (
          <div className="pt-cert-pending" data-testid="pt-cert-pending">
            {c.renderStatus === 'DISABLED' ? 'Preview coming soon' : 'Preview pending'}
          </div>
        )}
      </div>
      <div className="pt-cert-body">
        <div className="pt-row" style={{ alignItems: 'baseline' }}>
          <div className={`pt-acct-fam${MILESTONE_TYPES.has(c.type) ? ' gold' : ''}`}>{LABELS[c.type] ?? c.type}</div>
          <span className={`pt-badge ${c.status === 'ISSUED' ? 'funded' : 'inactive'}`} data-testid="pt-cert-status">
            <span className="dot" aria-hidden />{c.status === 'ISSUED' ? 'Valid' : 'Revoked'}
          </span>
        </div>
        <div className="pt-cert-name">{c.publicDisplayName}</div>
        <div className="pt-cert-meta">
          {value != null && <span className="num">{money(value)}</span>}
          <span className="pt-dim">{new Date(c.issuedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}</span>
        </div>
        <div className="pt-cert-id pt-dim">{c.certificatePublicId}</div>

        <div className="pt-actions" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          {rendered && <button className="pt-btn" data-testid="pt-cert-download-image" onClick={() => void download(c.id, 'image', c.certificatePublicId)}>Download image</button>}
          {rendered && c.hasPdf && <button className="pt-btn" data-testid="pt-cert-download-pdf" onClick={() => void download(c.id, 'pdf', c.certificatePublicId)}>Download PDF</button>}
          <button className="pt-link" data-testid="pt-cert-copy-verify" onClick={copyVerify}>Copy verification link</button>
          <a className="pt-link" href={verifyUrl} target="_blank" rel="noreferrer">Verify</a>
        </div>
      </div>
    </section>
  );
}
