/**
 * Risk: where the operator should look first.
 *
 * Every ordering here is a stated, factual criterion - no opaque "risk score".
 * Accounts with open exposure are ranked by the two numbers that actually move
 * an account toward failure: how much drawdown room is left, and how large the
 * open loss is. Held and recently-failed accounts are listed straight from
 * their lifecycle status. A flat account has no open risk, so it is not here.
 */
import type { JSX } from 'react';
import { adminApi } from '../api';
import { Money, Panel, useLoad, when, type AdminRouteGo } from '../shared';
import type { AdminRisk, AdminRiskAccount, AdminRiskBrief } from '../types';

function RankedTable({
  rows,
  go,
  metric,
  label,
  empty,
}: {
  rows: AdminRiskAccount[];
  go: AdminRouteGo;
  metric: (row: AdminRiskAccount) => number | null;
  label: string;
  empty: string;
}): JSX.Element {
  return (
    <table className="adm-table">
      <thead>
        <tr>
          <th>Trader</th>
          <th>Account</th>
          <th className="num">Open</th>
          <th className="num">Equity</th>
          <th className="num">{label}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const value = metric(row);
          return (
            <tr
              key={row.accountId}
              className="adm-row-click"
              onClick={() => go({ name: 'ACCOUNT', id: row.accountId })}
            >
              <td>{row.trader ?? '—'}</td>
              <td className="num adm-dim">{row.accountPublicId ?? '—'}</td>
              <td className="num">{row.openContracts}</td>
              <td className="num">{row.equityMicros === null ? '—' : <Money micros={row.equityMicros} />}</td>
              <td className="num">{value === null ? '—' : <Money micros={value} sign />}</td>
            </tr>
          );
        })}
        {rows.length === 0 ? (
          <tr>
            <td colSpan={5} className="adm-muted">
              {empty}
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

function BriefTable({
  rows,
  go,
  showReason,
  empty,
}: {
  rows: AdminRiskBrief[];
  go: AdminRouteGo;
  showReason?: boolean;
  empty: string;
}): JSX.Element {
  return (
    <table className="adm-table">
      <thead>
        <tr>
          <th>Trader</th>
          <th>Account</th>
          <th className="num">Balance</th>
          {showReason ? <th>Reason</th> : null}
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.accountId}
            className="adm-row-click"
            onClick={() => go({ name: 'ACCOUNT', id: row.accountId })}
          >
            <td>{row.trader}</td>
            <td className="num adm-dim">
              {row.accountPublicId}
              <span className="adm-dim"> · {row.name}</span>
            </td>
            <td className="num">
              <Money micros={row.balanceMicros} />
            </td>
            {showReason ? <td className="adm-dim">{row.failedReason ?? '—'}</td> : null}
            <td className="num adm-dim">{when(row.updatedAt)}</td>
          </tr>
        ))}
        {rows.length === 0 ? (
          <tr>
            <td colSpan={showReason ? 5 : 4} className="adm-muted">
              {empty}
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

export function AdminRiskPage({ go }: { go: AdminRouteGo }): JSX.Element {
  const { data, error, loading } = useLoad<AdminRisk>(() => adminApi.risk(), []);

  if (error) {
    return (
      <div className="adm-page">
        <Panel title="Risk">
          <p className="adm-error">Unable to load — {error}</p>
        </Panel>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="adm-page">
        <Panel title="Risk">
          <p className="adm-muted">{loading ? 'Loading…' : 'No data.'}</p>
        </Panel>
      </div>
    );
  }

  return (
    <div className="adm-page adm-grid-2">
      <Panel title="Nearest a loss limit">
        <p className="adm-note">Accounts with open exposure, least drawdown room first.</p>
        <RankedTable
          rows={data.nearestLossLimit}
          go={go}
          metric={(r) => r.remainingDrawdownMicros}
          label="Remaining"
          empty="No open exposure near a limit."
        />
      </Panel>
      <Panel title="Largest open loss">
        <p className="adm-note">Open unrealized loss, largest first.</p>
        <RankedTable
          rows={data.largestUnrealizedLoss}
          go={go}
          metric={(r) => r.openPnlMicros}
          label="Unrealized"
          empty="No account is in an open loss."
        />
      </Panel>
      <Panel title="On admin hold">
        <BriefTable rows={data.onHold} go={go} empty="No accounts are held." />
      </Panel>
      <Panel title="Recent failures">
        <BriefTable rows={data.recentFailures} go={go} showReason empty="No recent failures." />
      </Panel>
    </div>
  );
}
