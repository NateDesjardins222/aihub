/** Every account, searchable by number, name or owner. */
import { useState, type JSX } from 'react';
import { adminApi } from '../api';
import { Money, Panel, StatusPill, useLoad, when, type AdminRouteGo } from '../shared';
import type { AdminAccount } from '../types';

const STATUSES = ['', 'PENDING', 'ACTIVE', 'LOCKED', 'PASSED', 'FAILED', 'DISABLED', 'ARCHIVED'];

export function AdminAccountsPage({ go }: { go: AdminRouteGo }): JSX.Element {
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const { data, error, loading } = useLoad<{ accounts: AdminAccount[] }>(
    () => adminApi.accounts(query, status),
    [query, status],
  );

  return (
    <div className="adm-page">
      <Panel
        title="Accounts"
        action={
          <form
            className="adm-search"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(term.trim());
            }}
          >
            <input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="SIM-001234, name or owner e-mail"
              aria-label="Search accounts"
            />
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              aria-label="Filter by status"
            >
              {STATUSES.map((option) => (
                <option key={option || 'ANY'} value={option}>
                  {option ? option.replace('_', ' ').toLowerCase() : 'any status'}
                </option>
              ))}
            </select>
            <button className="adm-btn" type="submit">
              Search
            </button>
          </form>
        }
      >
        {error ? <p className="adm-error">{error}</p> : null}
        {!data && loading ? <p className="adm-muted">Loading…</p> : null}
        {data ? (
          <table className="adm-table" data-testid="admin-accounts">
            <thead>
              <tr>
                <th>Number</th>
                <th>Owner</th>
                <th>Product</th>
                <th>Status</th>
                <th className="num">Balance</th>
                <th className="num">Realized</th>
                <th className="num">Open</th>
                <th>Last traded</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((account) => (
                <tr
                  key={account.id}
                  className="adm-row-click"
                  onClick={() => go({ name: 'ACCOUNT', id: account.id })}
                >
                  <td className="num">{account.publicId}</td>
                  <td>
                    {account.owner?.email ?? '—'}
                    <span className="adm-dim"> · {account.name}</span>
                  </td>
                  <td className="adm-dim">
                    {account.product ? `${account.product.name} v${account.product.version}` : '—'}
                  </td>
                  <td>
                    <StatusPill status={account.status} />
                  </td>
                  <td className="num">
                    <Money micros={account.balanceMicros} />
                  </td>
                  <td className="num">
                    <Money micros={account.realizedPnlMicros} sign />
                  </td>
                  <td className="num">{account.openContracts ?? 0}</td>
                  <td className="num adm-dim">{when(account.lastTradedAt ?? null)}</td>
                </tr>
              ))}
              {data.accounts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="adm-muted">
                    No accounts match that.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </Panel>
    </div>
  );
}
