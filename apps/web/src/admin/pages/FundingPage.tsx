/**
 * The passed queue and the funding decision.
 *
 * A trader who passes an evaluation is certified server-side into a
 * qualification; this is where the owner turns that qualification into a
 * funded-sim account, or declines it. Nothing here moves money - it is the
 * account transition, not a payout. Every figure came from the server; the
 * page computes nothing.
 */
import { useCallback, useState, type JSX } from 'react';
import { adminApi } from '../api';
import { ConfirmAction, Money, Panel, StatusPill, useLoad, when, type AdminRouteGo } from '../shared';
import type { FundingQualification } from '../types';

const STATES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'ELIGIBLE', label: 'Awaiting decision' },
  { key: 'FUNDED', label: 'Funded' },
  { key: 'DECLINED', label: 'Declined' },
  { key: 'ALL', label: 'All' },
];

export function AdminFundingPage({ go }: { go: AdminRouteGo }): JSX.Element {
  const [state, setState] = useState('ELIGIBLE');
  const { data, error, loading, reload } = useLoad(() => adminApi.fundingQueue(state), [state]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [declining, setDeclining] = useState<FundingQualification | null>(null);

  const approve = useCallback(
    async (id: string) => {
      setBusyId(id);
      setActionError(null);
      try {
        await adminApi.approveFunding(id);
        reload();
      } catch (err) {
        setActionError((err as Error).message);
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const decline = useCallback(
    async (id: string, reason: string) => {
      setBusyId(id);
      setActionError(null);
      try {
        await adminApi.declineFunding(id, reason);
        setDeclining(null);
        reload();
      } catch (err) {
        setActionError((err as Error).message);
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const rows = data?.qualifications ?? [];

  return (
    <div className="adm-page">
      <Panel
        title="Funding"
        action={
          <div className="adm-tabs" role="tablist" aria-label="Funding state">
            {STATES.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={state === tab.key}
                className={`adm-tab ${state === tab.key ? 'adm-tab-on' : ''}`}
                onClick={() => setState(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        }
      >
        {error ? <p className="adm-error">{error}</p> : null}
        {actionError ? <p className="adm-error">{actionError}</p> : null}
        {loading ? <p className="adm-muted">Loading…</p> : null}
        {!loading ? (
          <table className="adm-table" data-testid="admin-funding">
            <thead>
              <tr>
                <th>Trader</th>
                <th>Evaluation</th>
                <th>Product</th>
                <th className="num">Ending balance</th>
                <th className="num">Profit</th>
                <th>Qualified</th>
                <th>State</th>
                <th className="adm-actions-col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => {
                const profit = q.balanceMicros - q.account.startingBalanceMicros;
                return (
                  <tr key={q.id}>
                    <td>
                      <div>{q.trader.displayName}</div>
                      <div className="adm-dim">{q.trader.email}</div>
                    </td>
                    <td>
                      <a
                        href="#"
                        className="adm-link"
                        onClick={(event) => {
                          event.preventDefault();
                          go({ name: 'ACCOUNT', id: q.account.id });
                        }}
                      >
                        {q.account.publicId}
                      </a>
                    </td>
                    <td className="adm-dim">{q.product?.name ?? '—'}</td>
                    <td className="num">
                      <Money micros={q.balanceMicros} />
                    </td>
                    <td className="num">
                      <Money micros={profit} sign />
                    </td>
                    <td className="num adm-dim">{when(q.qualifiedAt)}</td>
                    <td>
                      <StatusPill status={q.fundingState} />
                      {q.fundingState === 'DECLINED' && q.declineReason ? (
                        <div className="adm-dim" title={q.declineReason}>
                          {q.declineReason}
                        </div>
                      ) : null}
                    </td>
                    <td className="adm-actions-col">
                      {q.fundingState === 'ELIGIBLE' ? (
                        <div className="adm-inline-actions">
                          <button
                            className="adm-btn adm-btn-primary"
                            disabled={busyId === q.id || !q.account.hasFundedDestination}
                            title={
                              q.account.hasFundedDestination
                                ? 'Provision the funded-sim account'
                                : 'This product names no funded destination'
                            }
                            onClick={() => approve(q.id)}
                          >
                            {busyId === q.id ? 'Working…' : 'Approve funding'}
                          </button>
                          <button
                            className="adm-btn"
                            disabled={busyId === q.id}
                            onClick={() => setDeclining(q)}
                          >
                            Decline
                          </button>
                        </div>
                      ) : q.fundingState === 'FUNDED' && q.fundedAccountId ? (
                        <a
                          href="#"
                          className="adm-link"
                          onClick={(event) => {
                            event.preventDefault();
                            go({ name: 'ACCOUNT', id: q.fundedAccountId! });
                          }}
                        >
                          View funded account
                        </a>
                      ) : (
                        <span className="adm-dim">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="adm-muted">
                    Nothing here.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </Panel>

      {declining ? (
        <ConfirmAction
          title={`Decline funding for ${declining.account.publicId}`}
          description="The trader passed the evaluation, but funding is being declined. This is recorded and cannot be silently reversed."
          confirmLabel="Decline funding"
          busy={busyId === declining.id}
          onCancel={() => setDeclining(null)}
          onConfirm={(reason) => decline(declining.id, reason)}
        />
      ) : null}
    </div>
  );
}
