/**
 * Owner Certificate Store (Milestone 6) — operational visibility over physical
 * framed orders + the manual 100K plaque queue. Read-mostly; the only mutations
 * are operational transitions (ship/deliver/refund/replace; plaque verify→order→
 * ship→deliver). There is NO control here that issues an earned certificate.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { api } from '../../api/client';

const M = 1_000_000;
const money = (micros: number | null | undefined): string => (micros == null ? '—' : `$${(micros / M).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);

interface Summary { totalOrders: number; paidOrders: number; revenueMicros: number; fulfillmentCostMicros: number; estimatedContributionMicros: number; averageOrderValueMicros: number; needsAttention: number; byStatus: Record<string, number> }
interface Order { id: string; customerEmail: string; certificateType: string | null; certificatePublicId: string | null; status: string; retailAmountMicros: number; fulfillmentCostMicros: number; estimatedContributionMicros: number | null; fulfillmentProvider: string; providerOrderId: string | null; trackingNumber: string | null; failureCode: string | null; failureDetailSafe: string | null }
interface Plaque { id: string; customerEmail: string; type: string; status: string; trackingNumber: string | null; createdAt: number }

export function AdminCertificateStorePage({ mayMutate }: { mayMutate: boolean }): JSX.Element {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [plaques, setPlaques] = useState<Plaque[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.get<Summary>('/api/v1/admin/certificate-store').then(setSummary).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'error'));
    void api.get<{ orders: Order[] }>('/api/v1/admin/certificate-store/orders').then((r) => setOrders(r.orders)).catch(() => setOrders([]));
    void api.get<{ plaques: Plaque[] }>('/api/v1/admin/certificate-store/plaques').then((r) => setPlaques(r.plaques)).catch(() => setPlaques([]));
  }, []);
  useEffect(load, [load]);

  const orderAction = async (id: string, action: string): Promise<void> => {
    try { await api.post(`/api/v1/admin/certificate-store/orders/${id}/action`, { action }); load(); } catch { /* surfaced by reload */ }
  };
  const plaqueAction = async (id: string, action: string): Promise<void> => {
    try { await api.post(`/api/v1/admin/certificate-store/plaques/${id}/action`, { action }); load(); } catch { /* reload */ }
  };

  if (err) return <p className="adm-error">{err}</p>;

  return (
    <div data-testid="admin-certificate-store">
      <h1 className="adm-h1">Certificate Store</h1>
      {summary && (
        <div className="adm-stats" data-testid="admin-certstore-summary">
          <Stat label="Physical orders" value={String(summary.totalOrders)} />
          <Stat label="Paid" value={String(summary.paidOrders)} />
          <Stat label="Revenue" value={money(summary.revenueMicros)} />
          <Stat label="Fulfillment cost" value={money(summary.fulfillmentCostMicros)} />
          <Stat label="Est. contribution" value={money(summary.estimatedContributionMicros)} />
          <Stat label="Avg order value" value={money(summary.averageOrderValueMicros)} />
          <Stat label="Needs attention" value={String(summary.needsAttention)} />
        </div>
      )}

      <h2 className="adm-h2">Framed orders</h2>
      <table className="adm-table" data-testid="admin-certstore-orders">
        <thead><tr><th>Customer</th><th>Certificate</th><th>Status</th><th className="num">Retail</th><th className="num">Cost</th><th>Provider</th><th>Tracking</th><th>Actions</th></tr></thead>
        <tbody>
          {orders.length === 0 ? <tr><td colSpan={8} className="adm-dim">No physical orders yet.</td></tr> : orders.map((o) => (
            <tr key={o.id}>
              <td>{o.customerEmail}</td>
              <td>{o.certificateType ?? '—'} <span className="adm-dim">{o.certificatePublicId}</span></td>
              <td>{o.status}{o.failureCode ? <span className="adm-dim"> · {o.failureCode}</span> : null}</td>
              <td className="num">{money(o.retailAmountMicros)}</td>
              <td className="num">{money(o.fulfillmentCostMicros)}</td>
              <td>{o.fulfillmentProvider}</td>
              <td>{o.trackingNumber ?? '—'}</td>
              <td>
                {mayMutate && (o.status === 'SUBMITTED' || o.status === 'IN_PRODUCTION') && <button className="adm-btn" onClick={() => void orderAction(o.id, 'ship')}>Ship</button>}
                {mayMutate && o.status === 'SHIPPED' && <button className="adm-btn" onClick={() => void orderAction(o.id, 'deliver')}>Deliver</button>}
                {mayMutate && o.status === 'FULFILLMENT_FAILED' && <button className="adm-btn" onClick={() => void orderAction(o.id, 'refund')}>Refund</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="adm-h2">100K plaque fulfillment (manual)</h2>
      <table className="adm-table" data-testid="admin-certstore-plaques">
        <thead><tr><th>Customer</th><th>Type</th><th>Status</th><th>Tracking</th><th>Actions</th></tr></thead>
        <tbody>
          {plaques.length === 0 ? <tr><td colSpan={5} className="adm-dim">No plaque rewards yet.</td></tr> : plaques.map((p) => (
            <tr key={p.id}>
              <td>{p.customerEmail}</td>
              <td>{p.type}</td>
              <td>{p.status}</td>
              <td>{p.trackingNumber ?? '—'}</td>
              <td>
                {mayMutate && p.status === 'PENDING_REVIEW' && <button className="adm-btn" onClick={() => void plaqueAction(p.id, 'verify')}>Verify</button>}
                {mayMutate && p.status === 'VERIFIED' && <button className="adm-btn" onClick={() => void plaqueAction(p.id, 'order')}>Mark ordered</button>}
                {mayMutate && p.status === 'ORDERED' && <button className="adm-btn" onClick={() => void plaqueAction(p.id, 'ship')}>Ship</button>}
                {mayMutate && p.status === 'SHIPPED' && <button className="adm-btn" onClick={() => void plaqueAction(p.id, 'deliver')}>Deliver</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="adm-dim" style={{ marginTop: 12 }}>The 100K plaque is fulfilled manually — no provider is called and no money is spent automatically.</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return <div className="adm-stat"><span className="adm-stat-label">{label}</span><span className="adm-stat-value">{value}</span></div>;
}
