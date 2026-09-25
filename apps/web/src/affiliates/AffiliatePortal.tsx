/*
 * Affiliate self-service portal — /affiliates/portal (behind sign-in).
 *
 * Three states, driven entirely by the server's GET /me:
 *   · not enrolled          → an invitation to apply
 *   · enrolled, onboarding   → status, and (when approved) agreement acceptance
 *   · active                 → the dashboard: balances, tier progress, referral
 *                              link/codes, conversions (customers masked), payouts
 *
 * Nothing here computes money or attribution — every figure is server-authoritative,
 * and referred customers are never shown beyond a masked label (§35/§84).
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { formatMicros, formatCompactMicros } from '../state/format';
import {
  affiliatePortal, type MeResponse, type Dashboard, type AgreementDoc,
  type ConversionRow, type PayoutRow, type ProviderStatus,
} from './api';
import './Affiliates.css';

function pct(bps: number | null | undefined): string {
  if (bps == null) return '—';
  const p = bps / 100;
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
}
const TIER_LABEL: Record<string, string> = { AFFILIATE: 'Affiliate', PARTNER: 'Partner', GOLD: 'Gold', PLATINUM: 'Platinum', STRATEGIC: 'Strategic' };
function when(s: string | null): string { return s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' }) : '—'; }

export function AffiliatePortal(): JSX.Element {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    affiliatePortal.me()
      .then((d) => { if (!cancelled) { setMe(d); setErr(null); } })
      .catch((e: Error) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [nonce]);

  return (
    <div className="aff">
      <div className="aff-top">
        <a className="aff-brand" href="/affiliates"><span className="aff-mark" aria-hidden />Happy Trader <span className="g">Partners</span></a>
        <div className="aff-top-spacer" />
        <a className="aff-top-link" href="/portal">My account</a>
        <a className="aff-top-link" href="/" style={{ marginLeft: 16 }}>Terminal</a>
      </div>

      {err ? <div className="aff-portal"><p className="aff-err">{err}</p></div> : null}
      {!me && !err ? <div className="aff-center aff-muted">Loading your partner dashboard…</div> : null}

      {me && me.enrolled === false ? <NotEnrolledView /> : null}
      {me && me.enrolled === true && 'onboarding' in me ? <OnboardingView status={me.status} publicId={me.publicId} onActivated={reload} /> : null}
      {me && me.enrolled === true && !('onboarding' in me) ? <DashboardView data={me as Dashboard} onChange={reload} /> : null}
    </div>
  );
}

function NotEnrolledView(): JSX.Element {
  return (
    <section className="aff-section aff-center">
      <h1 style={{ fontSize: 28, margin: '0 0 10px' }}>You are not a partner yet</h1>
      <p className="aff-muted" style={{ maxWidth: 460, margin: '0 auto 22px' }}>
        The Happy Trader partner program pays a commission on qualified referred revenue. Apply, and once approved
        you can accept the agreement to activate your referral link.
      </p>
      <a className="aff-cta" href="/affiliates/apply">Apply to the program</a>
    </section>
  );
}

function OnboardingView({ status, publicId, onActivated }: { status: string; publicId: string; onActivated: () => void }): JSX.Element {
  const approved = status === 'APPROVED_PENDING_AGREEMENT';
  const [doc, setDoc] = useState<AgreementDoc | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (approved) affiliatePortal.agreement().then(setDoc).catch(() => setDoc(null)); }, [approved]);

  async function accept(): Promise<void> {
    setBusy(true); setErr(null);
    try { await affiliatePortal.acceptAgreement(); onActivated(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  const STATUS_COPY: Record<string, string> = {
    SUBMITTED: 'Your application is in the queue for review.',
    UNDER_REVIEW: 'Your application is being reviewed by our team.',
    INFO_REQUESTED: 'We have asked for more information — please check your email.',
    APPROVED_PENDING_AGREEMENT: 'You are approved. Accept the partner agreement below to activate your referral link.',
    DECLINED: 'This application was not approved at this time.',
    PAUSED: 'Your partner account is paused. Please contact support.',
    SUSPENDED: 'Your partner account is suspended. Please contact support.',
    TERMINATED: 'Your partner account has been closed.',
  };

  return (
    <div className="aff-portal">
      <div className="aff-portal-head">
        <h1>Partner onboarding</h1>
        <span className="aff-pill">{status.replace(/_/g, ' ').toLowerCase()}</span>
      </div>
      <p className="aff-muted">{STATUS_COPY[status] ?? 'Your partner account is being set up.'}</p>
      <p className="aff-faint">Reference: {publicId}</p>

      {approved ? (
        <div className="aff-panel" style={{ marginTop: 18 }}>
          <div className="aff-panel-head"><h2>{doc?.title ?? 'Partner Agreement'}{doc ? ` · v${doc.version}` : ''}</h2></div>
          <div className="aff-panel-body">
            <div className="aff-legal-banner">
              Working draft, pending review by legal counsel. Accepting records your consent to these terms as they
              stand; the finalized agreement will supersede this version.
            </div>
            {doc ? <div className="aff-agreement">{doc.body}</div> : <p className="aff-muted">Loading the agreement…</p>}
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 16, fontSize: 14 }}>
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 3 }} />
              <span>I have read and accept the partner agreement. I understand no commission accrues until my account is active.</span>
            </label>
            {err ? <p className="aff-err">{err}</p> : null}
            <div style={{ marginTop: 16 }}>
              <button className="aff-btn aff-btn-primary" disabled={!agreed || !doc || busy} onClick={accept}>
                {busy ? 'Activating…' : 'Accept & activate'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DashboardView({ data, onChange }: { data: Dashboard; onChange: () => void }): JSX.Element {
  const { affiliate, balance, tierProgress, last30, codes } = data;
  const primary = codes.find((c) => c.kind === 'PRIMARY') ?? codes[0];
  const referralUrl = primary ? `${window.location.origin}/affiliates?ref=${encodeURIComponent(primary.code)}` : null;
  const progressPct = tierProgress.nextThresholdMicros
    ? Math.min(100, Math.round((tierProgress.monthlyQualifiedMicros / tierProgress.nextThresholdMicros) * 100))
    : 100;

  return (
    <div className="aff-portal">
      <div className="aff-portal-head">
        <h1>Partner dashboard</h1>
        <span className={`aff-pill ${affiliate.status === 'ACTIVE' ? 'on' : ''}`}>{affiliate.status.toLowerCase()}</span>
        <span className="aff-pill">{TIER_LABEL[affiliate.tier] ?? affiliate.tier} · {pct(affiliate.effectiveRateBps)}</span>
      </div>

      <div className="aff-stat-grid">
        <div className="aff-stat"><span className="l">Withdrawable</span><span className="v">{formatMicros(balance.withdrawableMicros)}</span><span className="s">available now</span></div>
        <div className="aff-stat"><span className="l">Available</span><span className="v">{formatMicros(balance.availableMicros)}</span><span className="s">matured, ledger balance</span></div>
        <div className="aff-stat"><span className="l">Pending</span><span className="v">{formatMicros(balance.pendingMicros)}</span><span className="s">in maturity holdback</span></div>
        <div className="aff-stat"><span className="l">In-flight payouts</span><span className="v">{formatMicros(balance.inFlightPayoutMicros)}</span><span className="s">requested / processing</span></div>
        <div className="aff-stat"><span className="l">Lifetime paid</span><span className="v">{formatMicros(balance.lifetimePaidMicros)}</span></div>
      </div>

      <Panel title="Your referral link">
        {referralUrl ? (
          <div className="aff-link-row">
            <span className="aff-code" style={{ flex: 1, minWidth: 220, overflowX: 'auto' }}>{referralUrl}</span>
            <button className="aff-btn" onClick={() => navigator.clipboard?.writeText(referralUrl).catch(() => undefined)}>Copy link</button>
            <button className="aff-btn" onClick={() => navigator.clipboard?.writeText(primary!.code).catch(() => undefined)}>Copy code</button>
          </div>
        ) : <p className="aff-muted">No active code yet.</p>}
        {codes.length > 1 ? (
          <table className="aff-table" style={{ marginTop: 14 }}>
            <thead><tr><th>Code</th><th>Type</th><th>Campaign</th><th>Discount</th><th>Status</th></tr></thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.code}><td className="aff-code" style={{ padding: '10px 12px' }}>{c.code}</td><td>{c.kind.toLowerCase()}</td><td>{c.campaignLabel ?? '—'}</td><td>{c.discountBps ? pct(c.discountBps) : '—'}</td><td>{c.status.toLowerCase()}</td></tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <CreateCode onCreated={onChange} />
      </Panel>

      <Panel title="This tier">
        <div className="aff-stat-grid" style={{ marginBottom: 8 }}>
          <div className="aff-stat"><span className="l">Current tier</span><span className="v">{TIER_LABEL[tierProgress.tier] ?? tierProgress.tier}</span></div>
          <div className="aff-stat"><span className="l">Your rate</span><span className="v">{pct(tierProgress.effectiveRateBps)}</span></div>
          <div className="aff-stat"><span className="l">Qualified this month</span><span className="v">{formatMicros(tierProgress.monthlyQualifiedMicros)}</span></div>
        </div>
        {tierProgress.nextTier ? (
          <>
            <div className="aff-progress"><span style={{ width: `${progressPct}%` }} /></div>
            <p className="aff-faint" style={{ marginTop: 8 }}>
              {formatMicros(tierProgress.remainingMicros ?? 0)} more in qualified referred revenue this month to reach{' '}
              {TIER_LABEL[tierProgress.nextTier] ?? tierProgress.nextTier} ({formatCompactMicros(tierProgress.nextThresholdMicros ?? 0)}).
            </p>
          </>
        ) : <p className="aff-faint">You are at the top standard tier.</p>}
      </Panel>

      <Panel title="Last 30 days">
        <div className="aff-stat-grid">
          <div className="aff-stat"><span className="l">Clicks</span><span className="v">{last30.clicks}</span></div>
          <div className="aff-stat"><span className="l">Unique visitors</span><span className="v">{last30.uniqueSessions}</span></div>
          <div className="aff-stat"><span className="l">Conversions</span><span className="v">{last30.conversions}</span></div>
          <div className="aff-stat"><span className="l">Referred revenue</span><span className="v">{formatMicros(last30.referredRevenueMicros)}</span></div>
          <div className="aff-stat"><span className="l">Conversion rate</span><span className="v">{(last30.conversionRate * 100).toFixed(1)}%</span></div>
        </div>
      </Panel>

      <ConversionsPanel />
      <PayoutsPanel withdrawableMicros={balance.withdrawableMicros} onChange={onChange} />
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="aff-panel">
      <div className="aff-panel-head"><h2>{title}</h2></div>
      <div className="aff-panel-body">{children}</div>
    </section>
  );
}

function CreateCode({ onCreated }: { onCreated: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function create(): Promise<void> {
    setBusy(true); setErr(null);
    try { await affiliatePortal.createCode(code.trim(), label.trim() || undefined); setOpen(false); setCode(''); setLabel(''); onCreated(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  if (!open) return <div style={{ marginTop: 14 }}><button className="aff-btn" onClick={() => setOpen(true)}>+ New campaign code</button></div>;
  return (
    <div style={{ marginTop: 14, display: 'grid', gap: 10, maxWidth: 420 }}>
      <div className="aff-field"><label>Code (letters, numbers, - or _)</label><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="summer-launch" /></div>
      <div className="aff-field"><label>Campaign label (optional)</label><input value={label} onChange={(e) => setLabel(e.target.value)} /></div>
      {err ? <p className="aff-err">{err}</p> : null}
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="aff-btn aff-btn-primary" disabled={code.trim().length < 3 || busy} onClick={create}>{busy ? 'Creating…' : 'Create code'}</button>
        <button className="aff-btn" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
      </div>
      <p className="aff-faint">Campaign codes are for attribution only. Any discount attached to a code is set by Happy Trader.</p>
    </div>
  );
}

function ConversionsPanel(): JSX.Element {
  const [rows, setRows] = useState<ConversionRow[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { affiliatePortal.conversions().then((d) => setRows(d.conversions)).catch(() => setErr(true)); }, []);
  return (
    <Panel title="Referred conversions">
      {err ? <p className="aff-err">Could not load conversions.</p> : null}
      {!rows && !err ? <p className="aff-muted">Loading…</p> : null}
      {rows && rows.length === 0 ? <p className="aff-muted">No conversions yet. Share your link to get started.</p> : null}
      {rows && rows.length > 0 ? (
        <table className="aff-table">
          <thead><tr><th>Date</th><th>Customer</th><th>Source</th><th className="num">Qualified revenue</th><th className="num">Rate</th><th className="num">Commission</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{when(r.createdAt)}</td>
                <td>{r.customer}</td>
                <td>{(r.source ?? '').toLowerCase()}</td>
                <td className="num">{formatMicros(r.qualifiedRevenueMicros)}</td>
                <td className="num">{pct(r.rateBps)}</td>
                <td className="num">{r.commissionMicros != null ? formatMicros(r.commissionMicros) : '—'}</td>
                <td>{(r.status ?? '—').toLowerCase()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="aff-faint" style={{ marginTop: 12 }}>Customer names are masked for privacy. You never see a referred customer's contact, identity, or trading data.</p>
    </Panel>
  );
}

function PayoutsPanel({ withdrawableMicros, onChange }: { withdrawableMicros: number; onChange: () => void }): JSX.Element {
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [rows, setRows] = useState<PayoutRow[] | null>(null);
  const [err, setErr] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    affiliatePortal.payouts().then((d) => { setProvider(d.provider); setRows(d.payouts); }).catch(() => setErr(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function request(): Promise<void> {
    const micros = Math.round(Number(amount) * 1_000_000);
    if (!Number.isFinite(micros) || micros <= 0) { setMsg('Enter a valid amount.'); return; }
    setBusy(true); setMsg(null);
    try { await affiliatePortal.requestPayout(micros); setAmount(''); setMsg('Payout requested.'); load(); onChange(); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Panel title="Payouts">
      {provider && !provider.configured ? (
        <div className="aff-legal-banner" style={{ borderColor: 'var(--aff-line)', color: 'var(--aff-dim)', background: 'transparent' }}>
          A payout provider is not configured yet ({provider.note}). You can still request a payout; it will be
          reviewed and settled manually, and no funds move automatically.
        </div>
      ) : null}
      <div className="aff-link-row" style={{ marginBottom: 14 }}>
        <span className="aff-muted">Withdrawable: <strong>{formatMicros(withdrawableMicros)}</strong></span>
        <div className="aff-top-spacer" />
        <input className="aff-code" style={{ width: 130 }} inputMode="decimal" placeholder="Amount ($)" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button className="aff-btn aff-btn-primary" disabled={busy || !amount} onClick={request}>{busy ? 'Requesting…' : 'Request payout'}</button>
      </div>
      {msg ? <p className="aff-muted">{msg}</p> : null}
      {err ? <p className="aff-err">Could not load payouts.</p> : null}
      {rows && rows.length === 0 ? <p className="aff-muted">No payouts yet.</p> : null}
      {rows && rows.length > 0 ? (
        <table className="aff-table">
          <thead><tr><th>Requested</th><th className="num">Amount</th><th>Status</th><th>Method</th><th>Paid</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>{when(p.createdAt)}</td>
                <td className="num">{formatMicros(p.amountMicros)}</td>
                <td>{p.status.replace(/_/g, ' ').toLowerCase()}</td>
                <td>{p.method ?? '—'}</td>
                <td>{when(p.paidAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Panel>
  );
}
