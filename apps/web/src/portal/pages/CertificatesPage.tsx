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

interface Merch { enabled: boolean; retailAmountMicros: number; size: string }
interface PhysicalOrder { id: string; certificateId: string; status: string; trackingCarrier: string | null; trackingNumber: string | null; createdAt: number }

export function CertificatesPage({ onToast }: { onToast: (m: string) => void }): JSX.Element {
  const [certs, setCerts] = useState<Cert[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [merch, setMerch] = useState<Merch | null>(null);
  const [orders, setOrders] = useState<PhysicalOrder[]>([]);

  const loadOrders = (): void => { void api.get<{ orders: PhysicalOrder[] }>('/api/v1/portal/physical-orders').then((r) => setOrders(r.orders)).catch(() => setOrders([])); };
  useEffect(() => {
    void api.get<{ certificates: Cert[] }>('/api/v1/portal/certificates').then((r) => setCerts(r.certificates)).catch((e: unknown) => setErr(msg(e)));
    void api.get<Merch>('/api/v1/portal/merch/framed-certificate').then(setMerch).catch(() => setMerch(null));
    loadOrders();
  }, []);

  const shown = useMemo(() => (certs ?? []).filter((c) => inFilter(c, filter)), [certs, filter]);
  const orderByCert = useMemo(() => {
    const m = new Map<string, PhysicalOrder>();
    for (const o of orders) if (!m.has(o.certificateId)) m.set(o.certificateId, o);
    return m;
  }, [orders]);

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
          {shown.map((c) => (
            <CertCard key={c.id} c={c} onToast={onToast} merch={merch} order={orderByCert.get(c.id) ?? null} onOrdered={loadOrders} />
          ))}
        </div>
      )}
    </>
  );
}

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Awaiting payment', PAID: 'Paid', SUBMITTED: 'Order confirmed', IN_PRODUCTION: 'In production',
  SHIPPED: 'Shipped', DELIVERED: 'Delivered', FULFILLMENT_FAILED: 'Needs attention', CANCELLED: 'Cancelled',
};

function CertCard({ c, onToast, merch, order, onOrdered }: {
  c: Cert; onToast: (m: string) => void;
  merch: { enabled: boolean; retailAmountMicros: number; size: string } | null;
  order: { id: string; status: string; trackingCarrier: string | null; trackingNumber: string | null } | null;
  onOrdered: () => void;
}): JSX.Element {
  const [thumb, setThumb] = useState<string | null>(null);
  const [ordering, setOrdering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addr, setAddr] = useState({ name: c.publicDisplayName, line1: '', city: '', region: '', postalCode: '', country: 'US' });
  const rendered = c.renderStatus === 'RENDERED' && c.hasImage;
  const canOrder = merch?.enabled && c.physicalEligible && !order;

  const placeOrder = async (): Promise<void> => {
    setBusy(true);
    try {
      const created = await api.post<{ orderId: string }>(`/api/v1/portal/certificates/${c.id}/order-framed`, { address: addr });
      // Non-production: confirm payment via the server-side simulate route.
      await api.post(`/api/v1/portal/physical-orders/${created.orderId}/dev/simulate-payment`).catch(() => undefined);
      onToast('Framed certificate ordered');
      setOrdering(false);
      onOrdered();
    } catch (e) { onToast(msg(e)); } finally { setBusy(false); }
  };

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

        {/* Physical framed certificate commerce (only for eligible certs). */}
        {canOrder && !ordering && merch && (
          <div className="pt-cert-merch" data-testid="pt-cert-order-framed">
            <div className="pt-dim" style={{ fontSize: 12 }}>Premium Framed Certificate · {merch.size} · {money(merch.retailAmountMicros)}</div>
            <button className="pt-btn gold" style={{ marginTop: 6 }} onClick={() => setOrdering(true)}>Order Framed Copy</button>
          </div>
        )}
        {ordering && (
          <div className="pt-cert-merch" data-testid="pt-cert-order-form">
            <div className="pt-ctl-value" style={{ flexWrap: 'wrap', gap: 6 }}>
              <input className="pt-input" placeholder="Full name" value={addr.name} onChange={(e) => setAddr({ ...addr, name: e.target.value })} />
              <input className="pt-input" placeholder="Address line 1" value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} />
              <input className="pt-input" placeholder="City" value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} style={{ maxWidth: 140 }} />
              <input className="pt-input" placeholder="Region" value={addr.region} onChange={(e) => setAddr({ ...addr, region: e.target.value })} style={{ maxWidth: 100 }} />
              <input className="pt-input" placeholder="Postal" value={addr.postalCode} onChange={(e) => setAddr({ ...addr, postalCode: e.target.value })} style={{ maxWidth: 100 }} />
              <input className="pt-input" placeholder="Country" value={addr.country} onChange={(e) => setAddr({ ...addr, country: e.target.value })} style={{ maxWidth: 70 }} />
            </div>
            <div className="pt-actions" style={{ marginTop: 8 }}>
              <button className="pt-btn primary" data-testid="pt-cert-order-confirm" disabled={busy} onClick={() => void placeOrder()}>
                {busy ? 'Placing…' : `Pay ${merch ? money(merch.retailAmountMicros) : ''} & order`}
              </button>
              <button className="pt-link" onClick={() => setOrdering(false)}>Cancel</button>
            </div>
          </div>
        )}
        {order && (
          <div className="pt-cert-merch" data-testid="pt-cert-order-status">
            <span className={`pt-badge ${order.status === 'DELIVERED' ? 'funded' : order.status === 'FULFILLMENT_FAILED' ? 'failed' : 'eval'}`}>
              <span className="dot" aria-hidden />{STATUS_LABEL[order.status] ?? order.status}
            </span>
            {order.trackingNumber && <span className="pt-dim" style={{ fontSize: 12, marginLeft: 8 }}>{order.trackingCarrier} · {order.trackingNumber}</span>}
          </div>
        )}
      </div>
    </section>
  );
}
