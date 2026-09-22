/** Every trader on the platform, searchable by name or e-mail, paged by cursor. */
import { useCallback, useState, type JSX } from 'react';
import { adminApi } from '../api';
import { Panel, StatusPill, usePagedList, when, type AdminRouteGo, type AdminUser } from '../shared';

const FILTERS: ReadonlyArray<{ key: string; label: string }> = [
  { key: '', label: 'All' },
  { key: 'has_eval', label: 'Has evaluation' },
  { key: 'has_funded', label: 'Has funded sim' },
  { key: 'on_hold', label: 'On hold' },
  { key: 'no_accounts', label: 'No accounts' },
];

export function AdminUsersPage({ go }: { go: AdminRouteGo }): JSX.Element {
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const res = await adminApi.users(query, cursor, filter);
      return { items: res.users, nextCursor: res.nextCursor };
    },
    [query, filter],
  );
  const { items, error, loading, loadingMore, nextCursor, loadMore } = usePagedList<AdminUser>(
    fetchPage,
    [query, filter],
  );

  return (
    <div className="adm-page">
      <Panel
        title="Traders"
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
              placeholder="Search name or e-mail"
              aria-label="Search users"
            />
            <button className="adm-btn" type="submit">
              Search
            </button>
          </form>
        }
      >
        <div className="adm-tabs" role="tablist" aria-label="Trader filter">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              className={`adm-tab ${filter === f.key ? 'adm-tab-on' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {error ? <p className="adm-error">{error}</p> : null}
        {loading ? <p className="adm-muted">Loading…</p> : null}
        {!loading ? (
          <>
            <table className="adm-table" data-testid="admin-users">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>E-mail</th>
                  <th>Status</th>
                  <th className="num">Accounts</th>
                  <th className="num">Eval</th>
                  <th className="num">Funded</th>
                  <th>Last traded</th>
                </tr>
              </thead>
              <tbody>
                {items.map((user) => (
                  <tr
                    key={user.id}
                    className="adm-row-click"
                    onClick={() => go({ name: 'USER', id: user.id })}
                  >
                    <td>{user.displayName}</td>
                    <td className="adm-dim">{user.email}</td>
                    <td>
                      <StatusPill status={user.status} />
                    </td>
                    <td className="num">{user.accountCount ?? '—'}</td>
                    <td className="num">{user.evaluationAccounts ?? '—'}</td>
                    <td className="num">{user.fundedSimAccounts ?? '—'}</td>
                    <td className="num adm-dim">{user.lastTradedAt ? when(user.lastTradedAt) : '—'}</td>
                  </tr>
                ))}
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="adm-muted">
                      No traders match that.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            <div className="adm-more">
              <span className="adm-dim">
                Showing {items.length}
                {nextCursor ? '+' : ''} trader{items.length === 1 ? '' : 's'}
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
