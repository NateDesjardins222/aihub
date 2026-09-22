/**
 * What is happening across the platform right now.
 *
 * Every figure is the server's. Nothing here is derived in the browser, and
 * nothing here is cached - an operator looking at a balance is looking at what
 * the database says it is.
 */
import { useEffect, useState, type JSX } from 'react';
import { adminApi } from '../api';
import type { AdminOverview, AdminRouteGo } from '../shared';
import { AuditTable, Money, Panel, Stat, useLoad } from '../shared';

export function AdminOverviewPage({ go }: { go: AdminRouteGo }): JSX.Element {
  const { data, error, loading, reload } = useLoad<AdminOverview>(() => adminApi.overview(), []);
  const [verification, setVerification] = useState<string | null>(null);

  useEffect(() => {
    // Refreshed rather than streamed: an overview that moves under the reader
    // is harder to use than one that is a few seconds old and still.
    const timer = window.setInterval(reload, 15_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  if (error) return <p className="adm-error">{error}</p>;
  if (!data) return <p className="adm-muted">{loading ? 'Loading…' : 'Nothing to show.'}</p>;

  return (
    <div className="adm-page">
      <div className="adm-stats">
        <Stat label="Users" value={String(data.users.total)} sub={`${data.users.active} active`} />
        <Stat
          label="Accounts"
          value={String(data.accounts.total)}
          sub={`${data.accounts.active} active · ${data.accounts.passed} passed · ${data.accounts.failed} failed`}
        />
        <Stat
          label="Open positions"
          value={String(data.exposure.openPositions)}
          sub={`${data.exposure.openContracts} contracts · ${data.exposure.workingOrders} working orders`}
        />
        <Stat
          label="Fills (24h)"
          value={String(data.volume.fills24h)}
          sub={`${data.volume.contracts24h} contracts`}
        />
        <Stat
          label="Simulated net P&L"
          value={<Money micros={data.money.netPnlMicros} sign />}
          sub={`${data.money.closedTrades} closed trades`}
        />
        <Stat
          label="Balances"
          value={<Money micros={data.money.balanceMicros} />}
          sub={
            <>
              from <Money micros={data.money.startingBalanceMicros} /> provisioned
            </>
          }
        />
      </div>

      <div className="adm-stats">
        <Stat
          label="Active evaluations"
          value={String(data.lifecycle.activeEvaluations)}
          sub="tradeable EVALUATION accounts"
        />
        <Stat
          label="Passed evaluations"
          value={String(data.lifecycle.passedEvaluations)}
          sub={`${data.lifecycle.passedToday} today`}
        />
        <Stat
          label="Awaiting funding"
          value={String(data.lifecycle.awaitingFunding)}
          sub="qualifications ELIGIBLE"
        />
        <Stat
          label="Funded sim"
          value={String(data.lifecycle.fundedSim)}
          sub="FUNDED_SIM accounts"
        />
        <Stat
          label="Failed today"
          value={String(data.lifecycle.failedToday)}
          sub="lifecycles closed FAILED"
        />
      </div>

      <Panel
        title="Account status"
        action={
          <button
            className="adm-btn"
            onClick={() => {
              void adminApi
                .verifyAudit()
                .then((result) =>
                  setVerification(
                    result.ok
                      ? `Audit chain verified: ${result.checked} entries, unbroken.`
                      : `Audit chain BROKEN at ${result.brokenAt} after ${result.checked} entries.`,
                  ),
                )
                .catch((err: Error) => setVerification(err.message));
            }}
          >
            Verify audit chain
          </button>
        }
      >
        <div className="adm-chips">
          {Object.entries(data.accounts.byStatus).map(([status, count]) => (
            <span key={status} className={`adm-chip adm-status-${status.toLowerCase()}`}>
              {status.replace('_', ' ').toLowerCase()}
              <b>{count}</b>
            </span>
          ))}
        </div>
        {verification ? <p className="adm-note">{verification}</p> : null}
      </Panel>

      <Panel title="Recent activity">
        <AuditTable entries={data.activity} go={go} />
      </Panel>
    </div>
  );
}
