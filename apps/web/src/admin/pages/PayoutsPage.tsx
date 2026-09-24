/**
 * The owner's payout control center.
 *
 * Real backend state, never a mock: the queue, firm exposure, and the full
 * payout case (eligibility recompute, rule snapshot, balance calculation,
 * ledger, audit) with the operator actions the state machine permits. Every
 * figure came from the server; the page computes nothing but a difference for
 * display. Sensitive actions require a reason, and the server enforces RBAC.
 */
import { useCallback, useState, type JSX } from 'react';
import { adminApi } from '../api';
import { ConfirmAction, Money, Panel, Stat, StatusPill, useLoad, when, type AdminRouteGo } from '../shared';
import type { PayoutCase } from '../types';

const STATES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'REQUESTED', label: 'Pending' },
  { key: 'UNDER_REVIEW', label: 'Under review' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'PROCESSING', label: 'Processing' },
  { key: 'PAID', label: 'Paid' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'FAILED', label: 'Failed' },
  { key: 'ALL', label: 'All' },
];

const pct = (r: number | null): string => (r === null ? '—' : `${(r * 100).toFixed(0)}%`);

export function AdminPayoutsPage({ go, mayMutate }: { go: AdminRouteGo; mayMutate: boolean }): JSX.Element {
  const [state, setState] = useState('REQUESTED');
  const { data, error, loading, reload } = useLoad(() => adminApi.payoutQueue(state), [state]);
  const exposure = useLoad(() => adminApi.payoutExposure(), []);
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = data?.rows ?? [];
  const x = exposure.data;

  return (
    <div className="adm-page">
      {x ? (
        <Panel title="Firm exposure">
          <div className="adm-stats">
            <Stat label="Paid today" value={<Money micros={x.realizedPaid.today} />} />
            <Stat label="Paid 7d" value={<Money micros={x.realizedPaid.last7d} />} />
            <Stat label="Paid 30d" value={<Money micros={x.realizedPaid.last30d} />} />
            <Stat label="Paid all time" value={<Money micros={x.realizedPaid.allTime} />} />
            <Stat label="Requested liability" value={<Money micros={x.requestedLiabilityMicros} />} />
            <Stat label="Approved unpaid" value={<Money micros={x.approvedUnpaidMicros} />} />
            <Stat label="Eligible ceiling" value={<Money micros={x.eligibleWithdrawableMicros} />} />
          </div>
          <p className="adm-muted">
            These are three different things and are never merged: money already paid, the gross of
            requests not yet terminal, and the ceiling if every eligible trader withdrew their maximum.
          </p>
        </Panel>
      ) : null}

      <Panel
        title="Payouts"
        action={
          <div className="adm-tabs" role="tablist" aria-label="Payout state">
            {STATES.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={state === tab.key}
                className={`adm-tab ${state === tab.key ? 'adm-tab-on' : ''}`}
                onClick={() => { setState(tab.key); setOpenId(null); }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        }
      >
        {error ? <p className="adm-error">{error}</p> : null}
        {loading ? <p className="adm-muted">Loading…</p> : null}
        {!loading ? (
          <table className="adm-table" data-testid="admin-payouts">
            <thead>
              <tr>
                <th>Trader</th>
                <th>Account</th>
                <th>Product</th>
                <th className="num">Request</th>
                <th className="num">Trader / Firm</th>
                <th className="num">Balance</th>
                <th className="num">Withdrawable</th>
                <th>Holds</th>
                <th>State</th>
                <th className="adm-actions-col">Case</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid={`payout-row-${r.id}`}>
                  <td><div className="adm-dim">{r.traderEmail ?? '—'}</div></td>
                  <td>
                    <a href="#" className="adm-link" onClick={(e) => { e.preventDefault(); go({ name: 'ACCOUNT', id: r.accountId }); }}>
                      {r.accountPublicId ?? r.accountName}
                    </a>
                  </td>
                  <td className="adm-dim">{r.productName ?? '—'} <span className="adm-dim">#{r.payoutOrdinal}</span></td>
                  <td className="num"><Money micros={r.requestedGrossMicros} /></td>
                  <td className="num">
                    {r.traderShareMicros !== null ? <><Money micros={r.traderShareMicros} /> / <Money micros={r.firmShareMicros ?? 0} /></> : <span className="adm-dim">—</span>}
                  </td>
                  <td className="num"><Money micros={r.balanceMicros} /></td>
                  <td className="num">{r.withdrawableBeforeMicros !== null ? <Money micros={r.withdrawableBeforeMicros} /> : '—'}</td>
                  <td>{r.holdKind ? <StatusPill status={r.holdKind} /> : <span className="adm-dim">—</span>}</td>
                  <td><StatusPill status={r.state} /></td>
                  <td className="adm-actions-col">
                    <button className="adm-btn" onClick={() => setOpenId(openId === r.id ? null : r.id)} data-testid={`open-case-${r.id}`}>
                      {openId === r.id ? 'Hide' : 'Open'}
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr><td colSpan={10} className="adm-muted">Nothing here.</td></tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </Panel>

      {openId ? (
        <PayoutCasePanel
          id={openId}
          mayMutate={mayMutate}
          onChanged={() => { reload(); exposure.reload(); }}
        />
      ) : null}
    </div>
  );
}

function PayoutCasePanel({ id, mayMutate, onChanged }: { id: string; mayMutate: boolean; onChanged: () => void }): JSX.Element {
  const { data, error, loading, reload } = useLoad(() => adminApi.payoutCase(id), [id]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ action: string; label: string; holdKind?: string } | null>(null);

  const run = useCallback(
    async (action: string, body: Record<string, unknown>) => {
      setBusy(true);
      setActionError(null);
      try {
        await adminApi.payoutAction(id, action, body);
        setConfirm(null);
        reload();
        onChanged();
      } catch (err) {
        setActionError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [id, reload, onChanged],
  );

  if (loading) return <Panel title="Payout case"><p className="adm-muted">Loading…</p></Panel>;
  if (error || !data) return <Panel title="Payout case"><p className="adm-error">{error ?? 'Not found.'}</p></Panel>;

  const c: PayoutCase = data;
  const e = c.liveEligibility;
  const profit = c.account.balanceMicros - c.account.startingBalanceMicros;
  const canDecide = c.request.state === 'REQUESTED' || c.request.state === 'UNDER_REVIEW';

  return (
    <Panel title={`Payout case — ${c.account.publicId ?? c.account.name}`}>
      {actionError ? <p className="adm-error">{actionError}</p> : null}

      <div className="adm-stats">
        <Stat label="Model" value={c.policy.model} />
        <Stat label="State" value={<StatusPill status={c.request.state} />} />
        <Stat label="Requested" value={<Money micros={c.request.requestedGrossMicros} />} />
        <Stat label="Split" value={`${(c.policy.profitSplitPercent * 100).toFixed(0)}%`} />
        <Stat label="Balance" value={<Money micros={c.account.balanceMicros} />} />
        <Stat label="Profit" value={<Money micros={profit} sign />} />
      </div>

      <h4>Eligibility (recomputed now)</h4>
      <div className="adm-stats">
        <Stat label="Status" value={<StatusPill status={e.state} />} />
        <Stat label="Winning days" value={`${e.qualifyingWinningDays} / ${c.policy.requiredWinningDays}`} />
        <Stat label="Best day" value={<Money micros={e.bestDayMicros} />} />
        <Stat label="Consistency" value={`${pct(e.consistencyRatio)}${c.policy.payoutConsistencyThreshold !== null ? ` / ${pct(c.policy.payoutConsistencyThreshold)}` : ''}`} />
        <Stat label="Buffer" value={<><Money micros={c.policy.fundedBufferMicros} /> {e.bufferEstablished ? '✓' : '—'}</>} />
        <Stat label="Withdrawable" value={<Money micros={e.grossWithdrawableMicros} />} />
        <Stat label="Request bounds" value={<><Money micros={e.minRequestMicros} />–<Money micros={e.maxRequestMicros} /></>} />
      </div>
      {e.reasonCodes.length > 0 && e.reasonCodes[0] !== 'ELIGIBLE' ? (
        <p className="adm-muted">Reasons: {e.reasonCodes.join(', ')}</p>
      ) : null}

      <h4>Ledger</h4>
      <table className="adm-table">
        <thead><tr><th>Entry</th><th className="num">Amount</th><th className="num">Balance before</th><th className="num">Balance after</th><th className="num">Trader / Firm</th><th>When</th></tr></thead>
        <tbody>
          {c.ledger.map((l, i) => (
            <tr key={i}>
              <td>{l.entryType}</td>
              <td className="num"><Money micros={l.amountMicros} /></td>
              <td className="num"><Money micros={l.balanceBeforeMicros} /></td>
              <td className="num"><Money micros={l.balanceAfterMicros} /></td>
              <td className="num">{l.traderShareMicros !== null ? <><Money micros={l.traderShareMicros} /> / <Money micros={l.firmShareMicros ?? 0} /></> : '—'}</td>
              <td className="adm-dim">{when(Date.parse(l.createdAt))}</td>
            </tr>
          ))}
          {c.ledger.length === 0 ? <tr><td colSpan={6} className="adm-muted">No money has moved.</td></tr> : null}
        </tbody>
      </table>

      <h4>Audit</h4>
      <table className="adm-table">
        <thead><tr><th>Action</th><th>Reason</th><th>When</th></tr></thead>
        <tbody>
          {c.audit.map((a, i) => (
            <tr key={i}><td>{a.action}</td><td className="adm-dim">{a.reason ?? '—'}</td><td className="adm-dim">{when(Date.parse(a.createdAt))}</td></tr>
          ))}
          {c.audit.length === 0 ? <tr><td colSpan={3} className="adm-muted">No history.</td></tr> : null}
        </tbody>
      </table>

      {mayMutate ? (
        <div className="adm-inline-actions" style={{ marginTop: 12 }}>
          {canDecide ? (
            <>
              <button className="adm-btn adm-btn-primary" data-testid="payout-approve" disabled={busy} onClick={() => setConfirm({ action: 'approve', label: 'Approve payout' })}>Approve</button>
              <button className="adm-btn" disabled={busy} onClick={() => setConfirm({ action: 'reject', label: 'Reject payout' })}>Reject</button>
              <button className="adm-btn" disabled={busy} onClick={() => setConfirm({ action: 'hold', label: 'Place manual hold', holdKind: 'MANUAL' })}>Hold</button>
              <button className="adm-btn" disabled={busy} onClick={() => setConfirm({ action: 'cancel', label: 'Cancel payout' })}>Cancel</button>
            </>
          ) : null}
          {c.request.holdKind ? <button className="adm-btn" disabled={busy} onClick={() => run('remove-hold', {})}>Remove hold</button> : null}
          {c.request.state === 'APPROVED' ? <button className="adm-btn" disabled={busy} onClick={() => run('process', {})}>Mark processing</button> : null}
          {c.request.state === 'PROCESSING' ? <button className="adm-btn adm-btn-primary" disabled={busy} onClick={() => run('pay', {})}>Mark paid (mock)</button> : null}
        </div>
      ) : (
        <p className="adm-muted">Read-only: acting on a payout needs an operator role.</p>
      )}

      {confirm ? (
        <ConfirmAction
          title={confirm.label}
          description="This decision is recorded in the payout ledger and the audit chain. Approval moves the trader's share and adjusts the account balance once."
          confirmLabel={confirm.label}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => run(confirm.action, { confirm: true, reason, ...(confirm.holdKind ? { holdKind: confirm.holdKind } : {}) })}
        />
      ) : null}
    </Panel>
  );
}
