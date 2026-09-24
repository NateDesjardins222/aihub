/*
 * Public certificate verification page — /verify/:token
 *
 * Unauthenticated, shareable, QR-compatible. Renders ONLY the safe public
 * projection from GET /api/v1/verify/:token: it never shows a legal name, email,
 * phone, KYC data, or internal account/risk data. An unknown or revoked token
 * shows an explicit invalid state.
 */
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import './Portal.css';

interface PublicCert {
  valid: boolean;
  status: 'ISSUED' | 'REVOKED' | 'UNKNOWN';
  certificatePublicId: string | null;
  type: string | null;
  publicDisplayName: string | null;
  amountMicros: number | null;
  issuedMonth: string | null;
}

const TYPE_LABEL: Record<string, string> = {
  EVALUATION_PASSED: 'Evaluation Passed',
  FUNDED_TRADER: 'Funded Trader',
  PAYOUT: 'Payout',
  ACCOUNT_COMPLETED: 'Account Completed',
  TENK_CLUB: '$10K Club',
  FIFTYK_CLUB: '$50K Club',
  HUNDREDK_CLUB: '$100K Club',
};

function money(micros: number | null): string {
  if (micros == null) return '';
  return `$${(micros / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function VerifyPage(): JSX.Element {
  const [cert, setCert] = useState<PublicCert | null>(null);
  const [err, setErr] = useState(false);
  const token = window.location.pathname.replace(/^\/verify\/?/, '').split('/')[0] ?? '';

  useEffect(() => {
    if (!token) { setErr(true); return; }
    fetch(`/api/v1/verify/${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d: PublicCert) => setCert(d))
      .catch(() => setErr(true));
  }, [token]);

  return (
    <div className="pt" style={{ alignItems: 'center', justifyContent: 'center', padding: '40px 16px' }}>
      <div className="pt-card" style={{ maxWidth: 440, width: '100%', textAlign: 'center', padding: 28 }}>
        <div className="pt-mark" style={{ margin: '0 auto 14px' }} aria-hidden />
        <div className="pt-brand" style={{ marginBottom: 18 }}>Happy Trader <span className="g">Certificate</span></div>

        {err && <p className="pt-error">Could not load this certificate.</p>}
        {!err && !cert && <p className="pt-empty">Verifying…</p>}

        {cert && cert.valid && (
          <>
            <div style={{ color: 'var(--pt-ok)', fontSize: 12, letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: 14 }}>
              ✓ Verified certificate
            </div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{cert.publicDisplayName}</div>
            <div style={{ color: 'var(--pt-gold)', fontSize: 15, marginTop: 6 }}>{TYPE_LABEL[cert.type ?? ''] ?? cert.type}</div>
            {cert.amountMicros != null && <div style={{ fontSize: 20, fontWeight: 600, marginTop: 10 }}>{money(cert.amountMicros)}</div>}
            <div className="muted" style={{ marginTop: 14 }}>Issued {cert.issuedMonth}</div>
            <div className="pt-cert" style={{ marginTop: 6 }}><div className="id">{cert.certificatePublicId}</div></div>
          </>
        )}

        {cert && !cert.valid && (
          <div style={{ color: cert.status === 'REVOKED' ? 'var(--pt-error)' : 'var(--pt-dim)' }}>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{cert.status === 'REVOKED' ? 'Certificate revoked' : 'Certificate not found'}</div>
            <p className="pt-note">This verification link is not valid.</p>
          </div>
        )}
      </div>
    </div>
  );
}
