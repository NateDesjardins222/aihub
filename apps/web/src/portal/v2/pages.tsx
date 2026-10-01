/**
 * Portal V2 — customer destination pages (added at human-rejection #1).
 *
 * Sharp, institutional READ surfaces for the real customer destinations Nathan's
 * sidebar names: Payouts, Certificates, Billing, Support. Each is PRESENTATIONAL —
 * it takes an already-projected view model and renders authoritative records as
 * ledger/table/vault surfaces. In production the container fetches the authoritative
 * endpoints; the dev review supplies clearly dev-only fixtures. No business logic
 * here, no fabricated figures, and every interactive element is a REAL navigation
 * (no dead buttons): records cross-link to the owning account's detail.
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import type { Cert } from '../lib';
import { V2StatStrip, V2Section, V2EmptyState, V2Status, type StatusKind } from './primitives';
import { formatMoney } from './format';
import './pages.css';

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
}

function PageHead({ title, meta, action }: { title: string; meta: string; action?: JSX.Element }): JSX.Element {
  return (
    <header className="htv2-page-head htv2-page-head-row">
      <div>
        <h1 className="ht-t-page-title">{title}</h1>
        <p className="ht-t-meta">{meta}</p>
      </div>
      {action}
    </header>
  );
}

// ============================================================ Payouts =========

export type PayoutState = 'PAID' | 'PROCESSING' | 'APPROVED' | 'UNDER_REVIEW';
export interface PayoutStandingRow {
  accountId: string; accountLabel: string;
  eligible: boolean; availableMicros: number; winningDays: string;
}
export interface PayoutHistoryRow {
  id: string; dateMs: number; accountLabel: string;
  grossMicros: number; traderMicros: number; state: PayoutState;
}
export interface PayoutsView {
  totalPaidMicros: number; availableMicros: number; inReviewMicros: number; cyclesText: string;
  standing: PayoutStandingRow[]; history: PayoutHistoryRow[];
}

const PAYOUT_STATE: Record<PayoutState, { kind: StatusKind; label: string }> = {
  PAID: { kind: 'funded', label: 'Paid' },
  PROCESSING: { kind: 'payout', label: 'Processing' },
  APPROVED: { kind: 'payout', label: 'Approved' },
  UNDER_REVIEW: { kind: 'hold', label: 'In review' },
};

export interface PayoutActions { onRequestPayout?: (accountId: string) => void }

export function V2PayoutsPage({ view, onOpenAccount, actions = {} }: {
  view: PayoutsView;
  onOpenAccount: (id: string) => void;
  actions?: PayoutActions;
}): JSX.Element {
  // The first eligible funded account drives the primary "request payout" action.
  const eligible = view.standing.find((s) => s.eligible && s.availableMicros > 0);
  return (
    <div className="htv2-page">
      <PageHead title="Payouts" meta="Your withdrawable profit, payout standing, and settled history." />

      {/* Premium ledger hero — a calm statement of what you've earned and what's ready.
          Deliberately NOT a gambling surface: no streak meters, no confetti, no chance. */}
      <section className="htv2-payout-hero" data-testid="htv2-payout-hero">
        <div className="htv2-payout-hero-main">
          <span className="ht-t-label">Paid to you, lifetime</span>
          <span className="htv2-payout-hero-value ht-t-display ht-num htv2-metal">{formatMoney(view.totalPaidMicros, { maxFractionDigits: 0 })}</span>
        </div>
        <div className="htv2-payout-hero-side">
          <div className="htv2-payout-hero-avail">
            <span className="ht-t-label">Available now</span>
            <span className={`ht-t-fin-lg ht-num htv2-tone-${view.availableMicros > 0 ? 'positive' : 'muted'}`}>{formatMoney(view.availableMicros, { maxFractionDigits: 0 })}</span>
          </div>
          {eligible && actions.onRequestPayout && (
            <button className="htv2-btn htv2-btn-primary htv2-btn-sm ht-t-button" onClick={() => actions.onRequestPayout!(eligible.accountId)} data-testid="htv2-payout-request">
              Request payout
            </button>
          )}
        </div>
      </section>

      <V2StatStrip
        items={[
          { label: 'In review', value: formatMoney(view.inReviewMicros, { maxFractionDigits: 0 }) },
          { label: 'Payout cycles', value: view.cyclesText },
          { label: 'Funded accounts', value: String(view.standing.length) },
          { label: 'Eligible now', value: String(view.standing.filter((s) => s.eligible).length), tone: view.standing.some((s) => s.eligible) ? 'positive' : 'muted' },
        ]}
      />

      <V2Section title="Payout standing">
        {view.standing.length === 0 ? (
          <V2EmptyState title="No funded accounts yet" hint="Payout standing appears once you have a funded account." />
        ) : (
          <div className="htv2-rows" data-testid="htv2-payout-standing">
            {view.standing.map((r) => {
              const [doneStr, reqStr] = r.winningDays.split('/').map((s) => s.trim());
              const done = Number(doneStr); const req = Number(reqStr);
              const pct = req > 0 && Number.isFinite(done) ? Math.max(0, Math.min(100, (done / req) * 100)) : null;
              return (
                <div className="htv2-row" key={r.accountId}>
                  <div className="htv2-row-main">
                    <span className="htv2-row-title ht-t-fin-sm">{r.accountLabel}</span>
                    <span className="ht-t-meta">Winning days {r.winningDays}</span>
                    {pct != null && (
                      <span className="htv2-wd-bar" aria-hidden><span style={{ width: `${pct}%` }} /></span>
                    )}
                  </div>
                  <div className="htv2-row-right">
                    <span className="ht-t-fin-sm ht-num">{formatMoney(r.availableMicros)}</span>
                    <V2Status kind={r.eligible ? 'funded' : 'neutral'}>{r.eligible ? 'Eligible' : 'Not yet'}</V2Status>
                    <button className="htv2-link ht-t-nav" onClick={() => onOpenAccount(r.accountId)}>View account →</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </V2Section>

      <V2Section title="History">
        {view.history.length === 0 ? (
          <V2EmptyState title="No payouts yet" hint="Settled payouts will be listed here with their profit split." />
        ) : (
          <div className="htv2-table-wrap">
            <table className="htv2-ledger" data-testid="htv2-payout-history">
              <thead><tr><th>Date</th><th>Account</th><th className="num">Gross</th><th className="num">Your share</th><th>Status</th></tr></thead>
              <tbody>
                {view.history.map((h) => (
                  <tr key={h.id}>
                    <td className="ht-num">{fmtDate(h.dateMs)}</td>
                    <td>{h.accountLabel}</td>
                    <td className="num ht-num">{formatMoney(h.grossMicros)}</td>
                    <td className="num ht-num htv2-tone-positive">{formatMoney(h.traderMicros)}</td>
                    <td><V2Status kind={PAYOUT_STATE[h.state].kind}>{PAYOUT_STATE[h.state].label}</V2Status></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </V2Section>
    </div>
  );
}

// ======================================================= Certificates =========

/**
 * Certificates — rebuilt at human-review #2 into a categorised vault with a real
 * artifact pipeline. A horizontal category rail filters the vault; each certificate
 * previews the DETERMINISTIC RENDERED ARTIFACT (never a CSS re-creation) and offers
 * download + public verification.
 *
 * Honest wiring: the artifact and the verification URL are produced by the server.
 *   - `resolveArtifact(certId, kind)` → an authenticated object URL for the rendered
 *     PNG/PDF (production: GET /api/v1/portal/certificates/:id/{image,pdf}). When it
 *     returns null (e.g. the dev review has no session, or the artifact is still
 *     rendering) the card shows a truthful "preview unavailable here" state — it never
 *     fabricates an image.
 *   - `onVerify(token)` opens the public verification page (/verify/:token).
 * The renderer is NOT re-implemented here (see PORTAL_V2_CERTIFICATE_ARCHITECTURE.md).
 */
type CertCategory = 'all' | 'funded' | 'payouts' | 'completion';
const CERT_CATS: Array<{ key: CertCategory; label: string; match: (c: Cert) => boolean }> = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'funded', label: 'Funded', match: (c) => c.type === 'FUNDED_TRADER' },
  { key: 'payouts', label: 'Payouts', match: (c) => c.type === 'PAYOUT' },
  { key: 'completion', label: 'Account completion', match: (c) => c.type !== 'FUNDED_TRADER' && c.type !== 'PAYOUT' },
];

function certKindLabel(t: string): string {
  if (t === 'FUNDED_TRADER') return 'Funded Trader';
  if (t === 'PAYOUT') return 'Payout';
  return t.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

export interface CertActions {
  /** Authenticated object URL for the rendered artifact, or null when unavailable here. */
  resolveArtifact?: (certId: string, kind: 'image' | 'pdf') => Promise<string | null>;
  /** Open the public verification page for the certificate. */
  onVerify?: (token: string) => void;
}

export function V2CertificatesPage({ certs, onOpenAccount, actions = {} }: {
  certs: Cert[];
  onOpenAccount: (id: string) => void;
  actions?: CertActions;
}): JSX.Element {
  const [cat, setCat] = useState<CertCategory>('all');
  const [open, setOpen] = useState<Cert | null>(null);
  const counts = useMemo(() => {
    const c: Record<CertCategory, number> = { all: 0, funded: 0, payouts: 0, completion: 0 };
    for (const def of CERT_CATS) c[def.key] = certs.filter(def.match).length;
    return c;
  }, [certs]);
  const visible = useMemo(() => certs.filter(CERT_CATS.find((d) => d.key === cat)!.match), [certs, cat]);

  return (
    <div className="htv2-page">
      <PageHead title="Certificates" meta="Your earned certifications and payout awards, each verifiable on the public ledger." />
      {certs.length === 0 ? (
        <V2EmptyState title="No certificates yet" hint="Pass an evaluation or receive a payout and your certificates will appear here." />
      ) : (
        <>
          <nav className="htv2-catrail" role="tablist" aria-label="Certificate categories">
            {CERT_CATS.filter((d) => d.key === 'all' || counts[d.key] > 0).map((d) => (
              <button
                key={d.key}
                role="tab"
                aria-selected={cat === d.key}
                className={`htv2-catrail-tab ht-t-nav${cat === d.key ? ' on' : ''}`}
                onClick={() => setCat(d.key)}
                data-testid={`htv2-cert-cat-${d.key}`}
              >
                {d.label}<span className="htv2-catrail-n ht-num">{counts[d.key]}</span>
              </button>
            ))}
          </nav>
          <div className="htv2-vault" data-testid="htv2-certs">
            {visible.map((c) => (
              <CertCard key={c.id} c={c} actions={actions} onOpen={() => setOpen(c)} />
            ))}
          </div>
        </>
      )}
      {open && <CertModal c={open} actions={actions} onClose={() => setOpen(null)} onOpenAccount={onOpenAccount} />}
    </div>
  );
}

/** Resolve the rendered artifact into an object URL, tracking state. Shared by card + modal. */
function useArtifact(c: Cert, actions: CertActions): { url: string | null; state: 'loading' | 'ready' | 'unavailable' } {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const rendered = c.renderStatus == null || c.renderStatus === 'RENDERED';
  useEffect(() => {
    if (!actions.resolveArtifact || !rendered || c.hasImage === false) { setState('unavailable'); return; }
    let live = true; let made: string | null = null;
    setState('loading');
    void actions.resolveArtifact(c.id, 'image').then((u) => {
      if (!live) { if (u) URL.revokeObjectURL(u); return; }
      if (u) { made = u; setUrl(u); setState('ready'); } else { setState('unavailable'); }
    });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [c.id, c.hasImage, rendered, actions]);
  return { url, state };
}

async function downloadArtifact(c: Cert, actions: CertActions, kind: 'image' | 'pdf'): Promise<void> {
  if (!actions.resolveArtifact) return;
  const url = await actions.resolveArtifact(c.id, kind);
  if (!url) return;
  const a = document.createElement('a');
  a.href = url; a.download = `${c.certificatePublicId}.${kind === 'pdf' ? 'pdf' : 'png'}`;
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** An artwork-DOMINANT tile: the real rendered certificate is the tile. Click → preview. */
function CertCard({ c, actions, onOpen }: { c: Cert; actions: CertActions; onOpen: () => void }): JSX.Element {
  const { url, state } = useArtifact(c, actions);
  return (
    <button className="htv2-certtile" data-testid="htv2-cert" onClick={onOpen} aria-label={`${certKindLabel(c.type)} certificate — ${c.publicDisplayName}`}>
      <span className="htv2-certtile-art" data-state={state}>
        {state === 'ready' && url
          ? <img className="htv2-certtile-img" src={url} alt={`${c.publicDisplayName} certificate`} />
          : <span className="htv2-certtile-note ht-t-meta">{state === 'loading' ? 'Loading…' : 'Preview available in your account'}</span>}
        <span className="htv2-certtile-view ht-t-nav">View</span>
      </span>
      <span className="htv2-certtile-meta">
        <span className="htv2-certtile-kind ht-t-label">{certKindLabel(c.type)}</span>
        {c.amountMicros != null && <span className="htv2-certtile-amt ht-t-fin-sm ht-num">{formatMoney(c.amountMicros)}</span>}
        <span className="htv2-certtile-date ht-t-meta ht-num">{fmtDate(c.issuedAt)}</span>
      </span>
    </button>
  );
}

/** Large preview: the actual rendered certificate, full size, with metadata + real actions. */
function CertModal({ c, actions, onClose, onOpenAccount }: { c: Cert; actions: CertActions; onClose: () => void; onOpenAccount: (id: string) => void }): JSX.Element {
  const { url, state } = useArtifact(c, actions);
  const rendered = c.renderStatus == null || c.renderStatus === 'RENDERED';
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="htv2-certmodal-scrim" role="dialog" aria-modal="true" aria-label="Certificate preview" data-testid="htv2-cert-modal" onClick={onClose}>
      <div className="htv2-certmodal" onClick={(e) => e.stopPropagation()}>
        <div className="htv2-certmodal-art" data-state={state}>
          {state === 'ready' && url
            ? <img className="htv2-certmodal-img" src={url} alt={`${c.publicDisplayName} certificate`} />
            : <span className="htv2-certtile-note ht-t-meta">{state === 'loading' ? 'Loading…' : 'Preview available in your account'}</span>}
        </div>
        <aside className="htv2-certmodal-side">
          <header className="htv2-certmodal-head">
            <span className="htv2-cert-kind ht-t-label">{certKindLabel(c.type)}</span>
            <button className="htv2-certmodal-x" onClick={onClose} aria-label="Close">✕</button>
          </header>
          <dl className="htv2-certmodal-dl">
            <div><dt className="ht-t-label">Recipient</dt><dd className="ht-t-fin-sm">{c.publicDisplayName}</dd></div>
            {c.amountMicros != null && <div><dt className="ht-t-label">Amount</dt><dd className="ht-t-fin-sm ht-num">{formatMoney(c.amountMicros)}</dd></div>}
            <div><dt className="ht-t-label">Issued</dt><dd className="ht-t-fin-sm ht-num">{fmtDate(c.issuedAt)}</dd></div>
            <div><dt className="ht-t-label">Certificate ID</dt><dd className="ht-t-fin-sm ht-num">#{c.certificatePublicId}</dd></div>
          </dl>
          <div className="htv2-certmodal-actions">
            {rendered && c.hasImage !== false && actions.resolveArtifact && (
              <button className="htv2-btn htv2-btn-secondary htv2-btn-sm ht-t-button" onClick={() => void downloadArtifact(c, actions, 'image')} data-testid="htv2-cert-download-image">Download image</button>
            )}
            {rendered && c.hasPdf && actions.resolveArtifact && (
              <button className="htv2-btn htv2-btn-secondary htv2-btn-sm ht-t-button" onClick={() => void downloadArtifact(c, actions, 'pdf')} data-testid="htv2-cert-download-pdf">Download PDF</button>
            )}
            {actions.onVerify && (
              <button className="htv2-btn htv2-btn-secondary htv2-btn-sm ht-t-button" onClick={() => actions.onVerify!(c.verificationToken)} data-testid="htv2-cert-verify">Verify ↗</button>
            )}
          </div>
          {c.accountId && <button className="htv2-link ht-t-nav" onClick={() => onOpenAccount(c.accountId!)}>View associated account →</button>}
        </aside>
      </div>
    </div>
  );
}

// ============================================================ Billing =========

export type OrderState = 'PAID' | 'REFUNDED' | 'PENDING';
export interface OrderRow {
  id: string; dateMs: number; item: string; amountMicros: number; state: OrderState; accountId?: string | null;
}
/** Provider-safe payment-method projection. NEVER a raw card number — only the brand,
 *  last four, and expiry the payment provider returns. Null when none is on file. */
export interface PaymentMethodView {
  brand: string; last4: string; expMonth: number; expYear: number;
  isDefault?: boolean;
  // Provider-safe billing contact (only what the provider returns; never card data).
  billingName?: string | null; billingEmail?: string | null; country?: string | null;
}
export interface BillingView {
  totalSpentMicros: number; orderCount: number; activeEntitlements: number; orders: OrderRow[];
  paymentMethod?: PaymentMethodView | null;
}
export interface BillingActions {
  onAddAccount?: () => void;
  /** Opens the provider-hosted payment-method flow (card data never touches our origin). */
  onManagePaymentMethod?: () => void;
  /** Opens/downloads the receipt for a settled order (provider-hosted or server-rendered). */
  onViewReceipt?: (orderId: string) => void;
}

const ORDER_STATE: Record<OrderState, { kind: StatusKind; label: string }> = {
  PAID: { kind: 'funded', label: 'Paid' },
  REFUNDED: { kind: 'neutral', label: 'Refunded' },
  PENDING: { kind: 'hold', label: 'Pending' },
};

export function V2BillingPage({ view, onOpenAccount, actions = {} }: {
  view: BillingView;
  onOpenAccount: (id: string) => void;
  actions?: BillingActions;
}): JSX.Element {
  const pm = view.paymentMethod ?? null;
  const [managing, setManaging] = useState(false);
  return (
    <div className="htv2-page">
      <PageHead
        title="Billing"
        meta="Your purchases, entitlements, and payment history."
        action={actions.onAddAccount ? <button className="htv2-btn htv2-btn-primary htv2-btn-sm ht-t-button" onClick={actions.onAddAccount} data-testid="htv2-billing-add-account">Add account</button> : undefined}
      />
      <V2StatStrip
        items={[
          { label: 'Total spent', value: formatMoney(view.totalSpentMicros, { maxFractionDigits: 0 }) },
          { label: 'Orders', value: String(view.orderCount) },
          { label: 'Active entitlements', value: String(view.activeEntitlements) },
        ]}
      />

      <V2Section title="Payment method" actions={pm ? <button className="htv2-link ht-t-nav" onClick={() => setManaging(true)} data-testid="htv2-billing-manage-pm">Manage →</button> : undefined}>
        {pm ? (
          <div className="htv2-paymethod2" data-testid="htv2-billing-paymethod">
            <div className="htv2-paymethod2-card">
              <span className="htv2-paymethod2-chip" aria-hidden />
              <span className="htv2-paymethod2-brand ht-t-fin-md">{pm.brand}</span>
              <span className="htv2-paymethod2-num ht-num">•••• •••• •••• {pm.last4}</span>
              <span className="htv2-paymethod2-exp ht-t-meta ht-num">Expires {String(pm.expMonth).padStart(2, '0')}/{String(pm.expYear).slice(-2)}</span>
            </div>
            <dl className="htv2-paymethod2-meta">
              {pm.isDefault && <div><dt className="ht-t-label">Status</dt><dd><V2Status kind="funded">Default</V2Status></dd></div>}
              {pm.billingName && <div><dt className="ht-t-label">Billing name</dt><dd className="ht-t-fin-sm">{pm.billingName}</dd></div>}
              {pm.billingEmail && <div><dt className="ht-t-label">Billing email</dt><dd className="ht-t-fin-sm ht-num">{pm.billingEmail}</dd></div>}
              {pm.country && <div><dt className="ht-t-label">Country</dt><dd className="ht-t-fin-sm">{pm.country}</dd></div>}
            </dl>
          </div>
        ) : (
          <div className="htv2-paymethod" data-testid="htv2-billing-paymethod">
            <span className="ht-t-body-sm htv2-tone-muted">No payment method on file.</span>
            {actions.onManagePaymentMethod && <button className="htv2-link ht-t-nav" onClick={actions.onManagePaymentMethod} data-testid="htv2-billing-add-pm">Add payment method →</button>}
          </div>
        )}
        <p className="ht-t-meta">Card details are held by our payment provider and never stored on our servers.</p>
      </V2Section>

      {managing && pm && (
        <div className="htv2-certmodal-scrim" role="dialog" aria-modal="true" aria-label="Manage payment method" data-testid="htv2-billing-pm-modal" onClick={() => setManaging(false)}>
          <div className="htv2-pmmodal" onClick={(e) => e.stopPropagation()}>
            <header className="htv2-certmodal-head">
              <span className="ht-t-section">Payment method</span>
              <button className="htv2-certmodal-x" onClick={() => setManaging(false)} aria-label="Close">✕</button>
            </header>
            <div className="htv2-paymethod2-card htv2-pmmodal-card">
              <span className="htv2-paymethod2-chip" aria-hidden />
              <span className="htv2-paymethod2-brand ht-t-fin-md">{pm.brand}</span>
              <span className="htv2-paymethod2-num ht-num">•••• •••• •••• {pm.last4}</span>
              <span className="htv2-paymethod2-exp ht-t-meta ht-num">Expires {String(pm.expMonth).padStart(2, '0')}/{String(pm.expYear).slice(-2)}</span>
            </div>
            <p className="ht-t-body-sm">To change or remove your card, continue to our payment provider’s secure portal. Card details are entered and stored there — never on Happy Trader’s servers, and never in this app.</p>
            <div className="htv2-certmodal-actions">
              {actions.onManagePaymentMethod && <button className="htv2-btn htv2-btn-primary htv2-btn-sm ht-t-button" onClick={actions.onManagePaymentMethod} data-testid="htv2-billing-pm-continue">Continue to secure provider ↗</button>}
              <button className="htv2-btn htv2-btn-secondary htv2-btn-sm ht-t-button" onClick={() => setManaging(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      <V2Section title="Order history">
        {view.orders.length === 0 ? (
          <V2EmptyState title="No orders yet" hint="Your evaluation purchases and other orders will appear here." action={actions.onAddAccount ? <button className="htv2-btn htv2-btn-primary htv2-btn-sm ht-t-button" onClick={actions.onAddAccount}>Add account</button> : undefined} />
        ) : (
          <div className="htv2-table-wrap">
            <table className="htv2-ledger" data-testid="htv2-billing-orders">
              <thead><tr><th>Date</th><th>Item</th><th className="num">Amount</th><th>Status</th><th>Account</th><th /></tr></thead>
              <tbody>
                {view.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="ht-num">{fmtDate(o.dateMs)}</td>
                    <td>{o.item}</td>
                    <td className="num ht-num">{formatMoney(o.amountMicros)}</td>
                    <td><V2Status kind={ORDER_STATE[o.state].kind}>{ORDER_STATE[o.state].label}</V2Status></td>
                    <td>{o.accountId ? <button className="htv2-link ht-t-nav" onClick={() => onOpenAccount(o.accountId!)}>View account →</button> : <span className="ht-t-meta htv2-tone-muted">—</span>}</td>
                    <td className="num">{actions.onViewReceipt && o.state !== 'PENDING' ? <button className="htv2-link ht-t-nav" onClick={() => actions.onViewReceipt!(o.id)} data-testid="htv2-billing-receipt">Receipt</button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </V2Section>
    </div>
  );
}

// ============================================================ Support =========

export type TicketState = 'OPEN' | 'WAITING' | 'RESOLVED';
export interface TicketRow { id: string; subject: string; state: TicketState; updatedMs: number; ref: string }
export interface SupportView { openCount: number; tickets: TicketRow[] }

const TICKET_STATE: Record<TicketState, { kind: StatusKind; label: string }> = {
  OPEN: { kind: 'evaluation', label: 'Open' },
  WAITING: { kind: 'hold', label: 'Awaiting you' },
  RESOLVED: { kind: 'completed', label: 'Resolved' },
};

export function V2SupportPage({ view }: { view: SupportView }): JSX.Element {
  return (
    <div className="htv2-page">
      <PageHead title="Support" meta="Your requests and their status. Replies arrive by email and here." />
      {view.tickets.length === 0 ? (
        <V2EmptyState title="No requests yet" hint="When you contact support, your conversation and its status appear here." />
      ) : (
        <V2Section title="Your requests" actions={<span className="ht-t-meta">{view.openCount} open</span>}>
          <div className="htv2-table-wrap">
            <table className="htv2-ledger" data-testid="htv2-support-tickets">
              <thead><tr><th>Reference</th><th>Subject</th><th>Status</th><th className="num">Updated</th></tr></thead>
              <tbody>
                {view.tickets.map((t) => (
                  <tr key={t.id}>
                    <td className="ht-num">{t.ref}</td>
                    <td>{t.subject}</td>
                    <td><V2Status kind={TICKET_STATE[t.state].kind}>{TICKET_STATE[t.state].label}</V2Status></td>
                    <td className="num ht-num">{fmtDate(t.updatedMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </V2Section>
      )}
    </div>
  );
}

// ====================================================== Owner notice =========

/**
 * Owner entry target. Owner Console is a SEPARATE, server-authorized application at
 * /admin — never rendered inside the customer portal. This truthful notice is reached
 * only from the account menu's owner-only entry (dev `?role=owner`).
 */
export function V2OwnerNotice({ onOpenAdmin, onBack }: { onOpenAdmin: () => void; onBack: () => void }): JSX.Element {
  return (
    <div className="htv2-page">
      <PageHead title="Owner Console" meta="Operator tools live in a separate, server-authorized application." />
      <V2EmptyState
        title="Owner Console is a separate application"
        hint="The operator console is served at /admin and authorized server-side. It is not part of the customer portal; this entry appears only because the owner role override is active."
      />
      <div className="htv2-page-actions">
        <button className="htv2-link ht-t-nav" onClick={onBack}>← Back to dashboard</button>
        <button className="htv2-btn htv2-btn-secondary htv2-btn-sm ht-t-button" onClick={onOpenAdmin}>Open Owner Console ↗</button>
      </div>
    </div>
  );
}
