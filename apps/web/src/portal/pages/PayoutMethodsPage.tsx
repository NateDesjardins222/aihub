/*
 * Payout Methods + payout status (Milestone 8), trader-facing.
 *
 * Shows the customer their masked payout destinations, lets them add/verify/remove
 * one through the provider-hosted (here dev/mock) flow, and shows the status and
 * authoritative timeline of their recent payouts. It never exposes a raw bank
 * number, a provider reference, or a fabricated PAID — only what the server can
 * prove. Clean payouts read as immediate: Requested → Approved → Sent → Processing
 * → Paid. "Processing" is Happy Trader/provider processing time, not a bank-arrival
 * guarantee.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { api } from '../../api/client';
import { Card, EmptyState, Money, msg } from '../lib';

interface Destination { id: string; provider: string; destinationType: string; maskedDisplay: string | null; status: string; ownershipState: string; verifiedAt: string | null; createdAt: string }
interface DestView { provider: string | null; providerConfigured: boolean; destinations: Destination[] }
interface Operation { payoutRequestId: string; status: string; requestedAt: string; paidAt: string | null; grossMicros: number; traderShareMicros: number | null }

const STATUS_LABEL: Record<string, string> = {
  PREPARING: 'Preparing', SENT: 'Sent to provider', PROCESSING: 'Processing', PAID: 'Paid',
  UNDER_REVIEW: 'Under review', FAILED: 'Could not complete', RETURNED: 'Returned',
};

export function PayoutMethodsPage({ onToast }: { onToast: (m: string) => void }): JSX.Element {
  const [dest, setDest] = useState<DestView | null>(null);
  const [ops, setOps] = useState<Operation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [openTimeline, setOpenTimeline] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.get<DestView>('/api/v1/portal/payout-ops/destinations').then(setDest).catch(() => setDest({ provider: null, providerConfigured: false, destinations: [] }));
    void api.get<{ operations: Operation[] }>('/api/v1/portal/payout-ops/operations').then((r) => setOps(r.operations)).catch(() => setOps([]));
  }, []);
  useEffect(load, [load]);

  const addMethod = useCallback(async () => {
    setBusy(true);
    try { await api.post('/api/v1/portal/payout-ops/destinations', {}); onToast('Payout method added.'); load(); }
    catch (e) { onToast(msg(e)); } finally { setBusy(false); }
  }, [onToast, load]);

  const disable = useCallback(async (id: string) => {
    setBusy(true);
    try { await api.post(`/api/v1/portal/payout-ops/destinations/${id}/disable`, {}); onToast('Payout method removed.'); load(); }
    catch (e) { onToast(msg(e)); } finally { setBusy(false); }
  }, [onToast, load]);

  return (
    <>
      <h1 className="pt-h1">Payout methods</h1>
      <p className="pt-sub">
        Manage where your payouts are sent, and follow their progress. Eligible payouts are typically
        processed within minutes — that’s our processing time, separate from when your bank settles the
        funds.
      </p>

      <Card>
        <h3>Your payout methods</h3>
        {dest === null ? <p className="muted">Loading…</p>
          : !dest.providerConfigured ? (
            <div data-testid="pm-unconfigured">
              <p className="muted">Online payouts are not set up in this environment yet. When a payout provider is configured, you’ll be able to add and verify a payout method here.</p>
            </div>
          ) : dest.destinations.length === 0 ? (
            <EmptyState title="No payout method yet" hint="Add a payout method so we can send your payouts." action={<button className="pt-btn" data-testid="pm-add" disabled={busy} onClick={addMethod}>Add payout method</button>} />
          ) : (
            <>
              <div className="pt-cards">
                {dest.destinations.map((d) => (
                  <Card key={d.id}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <strong data-testid={`pm-dest-${d.id}`}>{d.maskedDisplay ?? d.destinationType}</strong>
                      <span className={`pt-badge ${d.status === 'ACTIVE' ? 'ok' : ''}`}>{d.status.toLowerCase()}</span>
                    </div>
                    <p className="muted" style={{ marginTop: 6 }}>
                      {d.ownershipState === 'OWNERSHIP_CONFIRMED' ? 'Ownership confirmed' : d.ownershipState === 'OWNERSHIP_MISMATCH' ? 'Needs review' : 'Verification pending'}
                    </p>
                    {d.status !== 'DISABLED' ? <div className="pt-actions"><button className="pt-link" disabled={busy} onClick={() => disable(d.id)}>Remove</button></div> : null}
                  </Card>
                ))}
              </div>
              <div className="pt-actions" style={{ marginTop: 8 }}><button className="pt-btn" data-testid="pm-add" disabled={busy} onClick={addMethod}>Add another method</button></div>
            </>
          )}
      </Card>

      <Card>
        <h3>Recent payouts</h3>
        {ops === null ? <p className="muted">Loading…</p>
          : ops.length === 0 ? <p className="muted">No payouts yet.</p>
            : (
              <table className="pt-table" data-testid="pm-operations">
                <thead><tr><th>Requested</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {ops.map((o) => (
                    <>
                      <tr key={o.payoutRequestId} data-testid={`pm-op-${o.payoutRequestId}`}>
                        <td className="muted">{new Date(o.requestedAt).toLocaleString()}</td>
                        <td className="num"><Money micros={o.traderShareMicros ?? o.grossMicros} /></td>
                        <td><span className={`pt-badge ${o.status === 'PAID' ? 'ok' : o.status === 'FAILED' ? 'bad' : ''}`}>{STATUS_LABEL[o.status] ?? o.status}</span></td>
                        <td><button className="pt-link" onClick={() => setOpenTimeline(openTimeline === o.payoutRequestId ? null : o.payoutRequestId)}>{openTimeline === o.payoutRequestId ? 'Hide' : 'Timeline'}</button></td>
                      </tr>
                      {openTimeline === o.payoutRequestId ? <tr key={`${o.payoutRequestId}-t`}><td colSpan={4}><Timeline id={o.payoutRequestId} /></td></tr> : null}
                    </>
                  ))}
                </tbody>
              </table>
            )}
      </Card>
    </>
  );
}

function Timeline({ id }: { id: string }): JSX.Element {
  const [steps, setSteps] = useState<Array<{ at: string; label: string }> | null>(null);
  useEffect(() => {
    void api.get<{ timeline: Array<{ at: string; label: string }> }>(`/api/v1/portal/payout-ops/operations/${id}/timeline`)
      .then((r) => setSteps(r.timeline)).catch(() => setSteps([]));
  }, [id]);
  if (steps === null) return <span className="muted">Loading…</span>;
  if (steps.length === 0) return <span className="muted">No events yet.</span>;
  return (
    <ul style={{ margin: '6px 0', paddingLeft: 18 }} data-testid={`pm-timeline-${id}`}>
      {steps.map((s, i) => <li key={i} className="muted" style={{ marginBottom: 2 }}>{new Date(s.at).toLocaleTimeString()} — {s.label}</li>)}
    </ul>
  );
}
