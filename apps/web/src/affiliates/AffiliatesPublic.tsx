/*
 * Public affiliate program — /affiliates (landing), /affiliates/apply (intake),
 * /affiliates/agreement (working agreement). Unauthenticated and its own bundle,
 * rendered before the sign-in gate so a shared referral link works for anyone.
 *
 * Design rule (§28): premium and restrained; it states the commission structure
 * plainly and makes NO guaranteed-income or "get rich" claims. Every rate/threshold
 * shown comes from the server's program config — nothing is hardcoded here.
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { formatCompactMicros } from '../state/format';
import { affiliatePublic, affiliateSessionRef, type ProgramInfo, type AgreementDoc } from './api';
import './Affiliates.css';

function pct(bps: number): string {
  const p = bps / 100;
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
}

const TIER_LABEL: Record<string, string> = {
  AFFILIATE: 'Affiliate', PARTNER: 'Partner', GOLD: 'Gold', PLATINUM: 'Platinum', STRATEGIC: 'Strategic',
};

function nav(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function AffiliatesPublic(): JSX.Element {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Referral capture: any /affiliates URL carrying ?ref=CODE records a first-party
  // touch. The server enforces the attribution window and precedence; we only log it.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('ref');
    if (code) {
      void affiliatePublic.click({ code, sessionRef: affiliateSessionRef(), landingPath: window.location.pathname });
    }
  }, []);

  const view = path.startsWith('/affiliates/apply')
    ? 'apply'
    : path.startsWith('/affiliates/agreement')
      ? 'agreement'
      : 'landing';

  return (
    <div className="aff">
      <div className="aff-top">
        <a className="aff-brand" href="/affiliates" onClick={link('/affiliates')}>
          <span className="aff-mark" aria-hidden />
          Happy Trader <span className="g">Partners</span>
        </a>
        <div className="aff-top-spacer" />
        <a className="aff-top-link" href="/affiliates/agreement" onClick={link('/affiliates/agreement')}>Agreement</a>
        <a className="aff-top-link" href="/affiliates/portal" style={{ marginLeft: 16 }}>Partner sign in</a>
      </div>

      {view === 'landing' ? <Landing /> : null}
      {view === 'apply' ? <ApplyForm /> : null}
      {view === 'agreement' ? <AgreementView /> : null}

      <footer className="aff-section" style={{ borderTop: '1px solid var(--aff-line)', marginTop: 30 }}>
        <p className="aff-faint">
          Happy Trader Funding partner program. Commissions are earned on qualified referred revenue and are
          subject to the partner agreement, maturity holdback, and reversal on refunds and chargebacks. Participation
          does not guarantee any income.
        </p>
      </footer>
    </div>
  );
}

function link(path: string) {
  return (e: React.MouseEvent): void => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    nav(path);
  };
}

function Landing(): JSX.Element {
  const [program, setProgram] = useState<ProgramInfo | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { affiliatePublic.program().then(setProgram).catch(() => setErr(true)); }, []);

  return (
    <>
      <section className="aff-hero">
        <h1>Partner with <span className="g">Happy Trader</span></h1>
        <p>
          Refer traders to the evaluations you already believe in, and earn an ongoing commission on the
          revenue you drive. Transparent rates, honest reporting, and payouts you can audit line by line.
        </p>
        <div>
          {program && !program.applicationsEnabled ? (
            <button className="aff-cta" disabled>Applications are paused</button>
          ) : (
            <a className="aff-cta" href="/affiliates/apply" onClick={link('/affiliates/apply')}>Apply to the program</a>
          )}
          <a className="aff-cta-ghost" href="/affiliates/agreement" onClick={link('/affiliates/agreement')}>Read the agreement</a>
        </div>
        <p className="aff-note">Approval is required. A code and referral link are issued only after you accept the partner agreement.</p>
      </section>

      <section className="aff-section">
        <h2>How it works</h2>
        <div className="aff-grid">
          <div className="aff-card"><h3>1 · Apply</h3><p>Tell us about your audience and how you plan to promote. We review every application by hand.</p></div>
          <div className="aff-card"><h3>2 · Accept &amp; activate</h3><p>Once approved, you accept the partner agreement. Your referral code and link go live the moment you do.</p></div>
          <div className="aff-card"><h3>3 · Refer</h3><p>Share your link. Referrals are attributed for a set window, with clear precedence rules and no self-referrals.</p></div>
          <div className="aff-card"><h3>4 · Earn &amp; withdraw</h3><p>Commissions accrue on qualified revenue, mature after a holdback, and become withdrawable to your payout method.</p></div>
        </div>
      </section>

      <section className="aff-section">
        <h2>Commission tiers</h2>
        {err ? <p className="aff-err">Could not load the program details right now.</p> : null}
        {program ? (
          <>
            <table className="aff-tiers">
              <thead><tr><th>Tier</th><th className="num">Commission</th><th className="num">Qualifies at (monthly referred revenue)</th></tr></thead>
              <tbody>
                {program.tiers.map((t) => (
                  <tr key={t.tier}>
                    <td>{TIER_LABEL[t.tier] ?? t.tier}</td>
                    <td className="num rate">{pct(t.rateBps)}</td>
                    <td className="num">{t.thresholdMicros > 0 ? formatCompactMicros(t.thresholdMicros) : '—'}</td>
                  </tr>
                ))}
                <tr><td>{TIER_LABEL.STRATEGIC}</td><td className="num rate">Custom</td><td className="num">By invitation</td></tr>
              </tbody>
            </table>
            <p className="aff-faint" style={{ marginTop: 14 }}>
              Tiers are assessed on qualified referred revenue each month. Commission is calculated on the net amount
              after any discount. Commissions hold for {program.commissionMaturityDays} days before maturing, and referrals
              are attributed within a {program.attributionWindowDays}-day window. Minimum payout is {formatCompactMicros(program.minPayoutMicros)}.
            </p>
          </>
        ) : (!err ? <p className="aff-muted">Loading…</p> : null)}
      </section>
    </>
  );
}

function ApplyForm(): JSX.Element {
  const [form, setForm] = useState({
    fullName: '', email: '', brandName: '', primaryPlatform: '', profileUrl: '',
    audienceSize: '', audienceDescription: '', promotionPlan: '', country: '',
  });
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const valid = form.fullName.trim().length >= 2 && /.+@.+\..+/.test(form.email);

  function set<K extends keyof typeof form>(k: K, v: string): void { setForm((f) => ({ ...f, [k]: v })); }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!valid || status === 'sending') return;
    setStatus('sending');
    const body: Record<string, unknown> = { fullName: form.fullName.trim(), email: form.email.trim() };
    for (const k of ['brandName', 'primaryPlatform', 'profileUrl', 'audienceSize', 'audienceDescription', 'promotionPlan', 'country'] as const) {
      if (form[k].trim()) body[k] = form[k].trim();
    }
    const res = await affiliatePublic.apply(body);
    if ('error' in res) { setStatus('error'); setMessage(res.error); return; }
    setStatus('done');
  }

  if (status === 'done') {
    return (
      <section className="aff-section aff-center">
        <div className="aff-mark" style={{ margin: '0 auto 18px', width: 40, height: 40 }} aria-hidden />
        <h1 style={{ fontSize: 28, margin: '0 0 10px' }}>Application received</h1>
        <p className="aff-muted" style={{ maxWidth: 460, margin: '0 auto' }}>
          Thank you. Our team reviews every application by hand. If approved, you will be asked to accept the
          partner agreement — and only then does your referral code and link go live. We will be in touch by email.
        </p>
        <div style={{ marginTop: 24 }}><a className="aff-cta-ghost" href="/affiliates" onClick={link('/affiliates')}>Back to the program</a></div>
      </section>
    );
  }

  return (
    <section className="aff-section">
      <h2>Apply to become a partner</h2>
      <form className="aff-form" onSubmit={submit}>
        <div className="aff-field row2">
          <div className="aff-field"><label>Full name *</label><input value={form.fullName} onChange={(e) => set('fullName', e.target.value)} autoComplete="name" /></div>
          <div className="aff-field"><label>Email *</label><input value={form.email} onChange={(e) => set('email', e.target.value)} type="email" autoComplete="email" /></div>
        </div>
        <div className="aff-field row2">
          <div className="aff-field"><label>Brand / channel name</label><input value={form.brandName} onChange={(e) => set('brandName', e.target.value)} /></div>
          <div className="aff-field"><label>Primary platform</label><input value={form.primaryPlatform} onChange={(e) => set('primaryPlatform', e.target.value)} placeholder="YouTube, X, Discord…" /></div>
        </div>
        <div className="aff-field row2">
          <div className="aff-field"><label>Profile / channel URL</label><input value={form.profileUrl} onChange={(e) => set('profileUrl', e.target.value)} placeholder="https://…" /></div>
          <div className="aff-field"><label>Audience size</label><input value={form.audienceSize} onChange={(e) => set('audienceSize', e.target.value)} placeholder="e.g. 25k subscribers" /></div>
        </div>
        <div className="aff-field"><label>Describe your audience</label><textarea value={form.audienceDescription} onChange={(e) => set('audienceDescription', e.target.value)} /></div>
        <div className="aff-field"><label>How will you promote Happy Trader?</label><textarea value={form.promotionPlan} onChange={(e) => set('promotionPlan', e.target.value)} /></div>
        <div className="aff-field"><label>Country</label><input value={form.country} onChange={(e) => set('country', e.target.value)} autoComplete="country-name" /></div>

        {status === 'error' ? <p className="aff-err">{message}</p> : null}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 6 }}>
          <button className="aff-cta" type="submit" disabled={!valid || status === 'sending'}>
            {status === 'sending' ? 'Submitting…' : 'Submit application'}
          </button>
          <a className="aff-cta-ghost" href="/affiliates" onClick={link('/affiliates')}>Cancel</a>
        </div>
        <p className="aff-faint">By applying you consent to us contacting you about the program. Approval is discretionary and does not by itself create any commission entitlement.</p>
      </form>
    </section>
  );
}

function AgreementView(): JSX.Element {
  const [doc, setDoc] = useState<AgreementDoc | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { affiliatePublic.agreement().then(setDoc).catch(() => setErr(true)); }, []);
  const title = useMemo(() => doc?.title ?? 'Partner Agreement', [doc]);
  return (
    <section className="aff-section" style={{ maxWidth: 780 }}>
      <h2>{title}{doc ? ` · v${doc.version}` : ''}</h2>
      <div className="aff-legal-banner">
        This is a working draft provided for transparency. It is pending review by legal counsel and is not yet a
        binding legal document. The final agreement will be presented for acceptance before your program activation.
      </div>
      {err ? <p className="aff-err">Could not load the agreement.</p> : null}
      {doc ? <div className="aff-agreement">{doc.body}</div> : (!err ? <p className="aff-muted">Loading…</p> : null)}
      <div style={{ marginTop: 20 }}><a className="aff-cta-ghost" href="/affiliates" onClick={link('/affiliates')}>Back</a></div>
    </section>
  );
}
