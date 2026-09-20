/** Every account, searchable by number, name or owner, paged by cursor. */
import { useCallback, useState, type JSX } from 'react';
import { adminApi } from '../api';
import { Money, Panel, StatusPill, usePagedList, when, type AdminRouteGo } from '../shared';
import type { AdminAccount } from '../types';

const STATUSES = ['', 'PENDING', 'ACTIVE', 'LOCKED', 'PASSED', 'FAILED', 'DISABLED', 'ARCHIVED'];

export function AdminAccountsPage({ go }: { go: AdminRouteGo }): JSX.Element {
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const res = await adminApi.accounts(query, status, cursor);
      return { items: res.accounts, nextCursor: res.nextCursor };
    },
    [query, status],
  );
  const { items, error, loading, loadingMore, nextCursor, loadMore } = usePagedList<AdminAccount>(
    fetchPage,
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
        {loading ? <p className="adm-muted">Loading…</p> : null}
        {!loading ? (
          <>
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
                {items.map((account) => (
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
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="adm-muted">
                      No accounts match that.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            <div className="adm-more">
              <span className="adm-dim">
                Showing {items.length}
                {nextCursor ? '+' : ''} account{items.length === 1 ? '' : 's'}
              </span>
              {nextCursor ? (
                <button className="adm-btn" disabled={loadingMore} onClick={loadMore}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </Panel>
    </div>
  );
}
